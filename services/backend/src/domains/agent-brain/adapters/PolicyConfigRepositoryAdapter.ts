/**
 * PolicyConfigRepositoryAdapter - file-backed PolicyRepositoryPort implementation
 *
 * Loads sandbox/tool policies from local YAML files at startup and serves
 * them from memory for runtime policy resolution.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type {
  PolicyRepositoryPort,
  PolicySpec,
  PolicyWithSpec,
  SandboxPolicySpec,
} from '../ports';
import type { ToolAccessPolicy } from '../domain/types';

const POLICY_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    allowlist_hosts: z.array(z.string()).optional(),
    network: z.union([z.boolean(), z.enum(['none', 'allowlist', 'bridge'])]).optional(),
  })
  .partial();

const SandboxPolicySchema = z
  .object({
    network: z.string().min(1).optional(),
    readonlyRootfs: z.boolean().optional(),
    capDrop: z.array(z.string()).optional(),
    capAdd: z.array(z.string()).optional(),
    privileged: z.boolean().optional(),
    seccompProfilePath: z.string().nullable().optional(),
    user: z.string().optional(),
  })
  .partial();

const PolicyFileSchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
  isDefaultSandbox: z.boolean().default(false),
  sandboxImageName: z.string().optional(),
  spec: z
    .object({
      tools: ToolPolicySchema.optional(),
      toolPolicy: ToolPolicySchema.optional(),
      sandbox: SandboxPolicySchema.optional(),
    })
    .partial()
    .default({}),
});

type PolicyFile = z.infer<typeof PolicyFileSchema>;

const normalizeToolPolicy = (
  input: PolicyFile['spec']['tools'] | PolicyFile['spec']['toolPolicy'],
): ToolAccessPolicy | undefined => {
  if (!input) {
    return undefined;
  }

  const networkValue = input.network;
  let normalizedNetwork: ToolAccessPolicy['network'] | undefined;
  if (typeof networkValue === 'boolean') {
    normalizedNetwork = networkValue ? 'bridge' : 'none';
  } else if (networkValue) {
    normalizedNetwork = networkValue;
  }

  return {
    ...(input.allow ? { allow: [...input.allow] } : {}),
    ...(input.deny ? { deny: [...input.deny] } : {}),
    ...(input.allowlist_hosts ? { allowlist_hosts: [...input.allowlist_hosts] } : {}),
    ...(normalizedNetwork ? { network: normalizedNetwork } : {}),
  };
};

const normalizeSandboxPolicy = (input: PolicyFile['spec']['sandbox']): SandboxPolicySpec | undefined => {
  if (!input) {
    return undefined;
  }

  const networkRaw = input.network;
  let network: SandboxPolicySpec['network'] | undefined;
  if (networkRaw === 'host') {
    network = 'bridge';
  } else if (networkRaw === 'none' || networkRaw === 'bridge') {
    network = networkRaw;
  } else if (typeof networkRaw === 'string') {
    network = networkRaw as SandboxPolicySpec['network'];
  }

  return {
    ...(network ? { network } : {}),
    ...(typeof input.readonlyRootfs === 'boolean' ? { readonlyRootfs: input.readonlyRootfs } : {}),
    ...(input.capDrop ? { capDrop: [...input.capDrop] } : {}),
    ...(input.capAdd ? { capAdd: [...input.capAdd] } : {}),
    ...(typeof input.privileged === 'boolean' ? { privileged: input.privileged } : {}),
    ...(input.seccompProfilePath !== undefined ? { seccompProfilePath: input.seccompProfilePath } : {}),
    ...(input.user ? { user: input.user } : {}),
  };
};

const clonePolicy = (policy: PolicyWithSpec): PolicyWithSpec => ({
  ...policy,
  spec: JSON.parse(JSON.stringify(policy.spec)) as Record<string, unknown>,
  createdAt: new Date(policy.createdAt),
  updatedAt: new Date(policy.updatedAt),
  parsedSpec: {
    ...(policy.parsedSpec.sandbox ? { sandbox: { ...policy.parsedSpec.sandbox } } : {}),
    ...(policy.parsedSpec.tools ? { tools: { ...policy.parsedSpec.tools } } : {}),
    ...(policy.parsedSpec.toolPolicy ? { toolPolicy: { ...policy.parsedSpec.toolPolicy } } : {}),
  },
  ...(policy.sandboxImageName ? { sandboxImageName: policy.sandboxImageName } : {}),
});

const collectPolicyFiles = (directory: string): string[] => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPolicyFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      files.push(fullPath);
    }
  }

  return files.sort();
};

const resolvePolicyDirectory = (): string => {
  const fromEnv = process.env.POLICY_CONFIG_DIR?.trim();
  if (fromEnv) {
    const configured = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
    if (fs.existsSync(configured)) {
      return configured;
    }
    throw new Error(`[PolicyConfigRepositoryAdapter] POLICY_CONFIG_DIR does not exist: ${configured}`);
  }

  const candidates = [
    path.resolve(process.cwd(), 'config', 'policies'),
    path.resolve(process.cwd(), 'services', 'backend', 'config', 'policies'),
    path.resolve(__dirname, '../../../..', 'config', 'policies'),
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) {
    return existing;
  }

  throw new Error(`[PolicyConfigRepositoryAdapter] No policy directory found. Checked: ${candidates.join(', ')}`);
};

export class PolicyConfigRepositoryAdapter implements PolicyRepositoryPort {
  private readonly bySlug = new Map<string, PolicyWithSpec>();
  private readonly byId = new Map<string, PolicyWithSpec>();
  private readonly defaultPolicy: PolicyWithSpec;

  constructor() {
    const directory = resolvePolicyDirectory();
    const files = collectPolicyFiles(directory);
    if (files.length === 0) {
      throw new Error(`[PolicyConfigRepositoryAdapter] No policy files found in ${directory}`);
    }

    const loaded: PolicyWithSpec[] = [];
    for (const filePath of files) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsedYaml = parseYaml(raw);
      const parsed = PolicyFileSchema.parse(parsedYaml);
      const tools = normalizeToolPolicy(parsed.spec.tools ?? parsed.spec.toolPolicy);
      const sandbox = normalizeSandboxPolicy(parsed.spec.sandbox);
      const id = parsed.id ?? uuidv5(parsed.slug, POLICY_UUID_NAMESPACE);
      const now = new Date();
      const parsedSpec: PolicySpec = {
        ...(sandbox ? { sandbox } : {}),
        ...(tools ? { tools, toolPolicy: tools } : {}),
      };

      loaded.push({
        id,
        slug: parsed.slug,
        name: parsed.name,
        spec: {
          ...(sandbox ? { sandbox } : {}),
          ...(tools ? { tools } : {}),
        },
        isDefaultSandbox: parsed.isDefaultSandbox,
        createdAt: now,
        updatedAt: now,
        parsedSpec,
        ...(parsed.sandboxImageName ? { sandboxImageName: parsed.sandboxImageName } : {}),
      });
    }

    const defaults = loaded.filter((policy) => policy.isDefaultSandbox === true);
    if (defaults.length !== 1) {
      throw new Error(
        `[PolicyConfigRepositoryAdapter] Exactly one default policy is required, found ${defaults.length}`,
      );
    }

    for (const policy of loaded) {
      if (this.bySlug.has(policy.slug)) {
        throw new Error(`[PolicyConfigRepositoryAdapter] Duplicate policy slug: ${policy.slug}`);
      }
      if (this.byId.has(policy.id)) {
        throw new Error(`[PolicyConfigRepositoryAdapter] Duplicate policy id: ${policy.id}`);
      }
      this.bySlug.set(policy.slug, policy);
      this.byId.set(policy.id, policy);
    }

    this.defaultPolicy = defaults[0];
  }

  async getBySlug(slug: string): Promise<PolicyWithSpec | null> {
    const policy = this.bySlug.get(slug);
    return policy ? clonePolicy(policy) : null;
  }

  async getById(id: string): Promise<PolicyWithSpec | null> {
    const policy = this.byId.get(id);
    return policy ? clonePolicy(policy) : null;
  }

  async getDefaultPolicy(): Promise<PolicyWithSpec | null> {
    return clonePolicy(this.defaultPolicy);
  }

  /**
   * Return every loaded policy, sorted alphabetically by slug. Used by the
   * admin catalog surface (`GET /api/admin/policies`) to render a directory
   * of all yaml policies in `config/policies/`.
   */
  async listAll(): Promise<PolicyWithSpec[]> {
    return [...this.bySlug.values()]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((policy) => clonePolicy(policy));
  }
}
