import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PolicyConfigRepositoryAdapter } from '@/domains/agent-brain/adapters/PolicyConfigRepositoryAdapter';

const createTempPolicyDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'policy-config-test-'));

const writePolicy = (directory: string, fileName: string, content: string): void => {
  fs.writeFileSync(path.join(directory, fileName), content, 'utf8');
};

describe('PolicyConfigRepositoryAdapter', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    delete process.env.POLICY_CONFIG_DIR;
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads policies from POLICY_CONFIG_DIR and resolves default policy', async () => {
    const directory = createTempPolicyDir();
    createdDirs.push(directory);
    process.env.POLICY_CONFIG_DIR = directory;

    writePolicy(
      directory,
      'sandboxed.yaml',
      `
slug: sandboxed
name: Sandboxed
isDefaultSandbox: true
spec:
  tools:
    network: false
`,
    );
    writePolicy(
      directory,
      'network-enabled.yaml',
      `
slug: network-enabled
name: Network Enabled
spec:
  tools:
    network: true
`,
    );

    const repository = new PolicyConfigRepositoryAdapter();
    const defaultPolicy = await repository.getDefaultPolicy();
    const networkEnabled = await repository.getBySlug('network-enabled');

    expect(defaultPolicy?.slug).toBe('sandboxed');
    expect(defaultPolicy?.parsedSpec.tools?.network).toBe('none');
    expect(networkEnabled?.parsedSpec.tools?.network).toBe('bridge');
  });

  it('throws when no default policy exists', () => {
    const directory = createTempPolicyDir();
    createdDirs.push(directory);
    process.env.POLICY_CONFIG_DIR = directory;

    writePolicy(
      directory,
      'sandboxed.yaml',
      `
slug: sandboxed
name: Sandboxed
spec:
  tools:
    network: false
`,
    );

    expect(() => new PolicyConfigRepositoryAdapter()).toThrow('Exactly one default policy is required');
  });

  it('throws when multiple default policies exist', () => {
    const directory = createTempPolicyDir();
    createdDirs.push(directory);
    process.env.POLICY_CONFIG_DIR = directory;

    writePolicy(
      directory,
      'sandboxed.yaml',
      `
slug: sandboxed
name: Sandboxed
isDefaultSandbox: true
`,
    );
    writePolicy(
      directory,
      'network-enabled.yaml',
      `
slug: network-enabled
name: Network Enabled
isDefaultSandbox: true
`,
    );

    expect(() => new PolicyConfigRepositoryAdapter()).toThrow('Exactly one default policy is required');
  });

  it('throws when duplicate slugs are configured', () => {
    const directory = createTempPolicyDir();
    createdDirs.push(directory);
    process.env.POLICY_CONFIG_DIR = directory;

    writePolicy(
      directory,
      'policy-a.yaml',
      `
slug: duplicated
name: Policy A
isDefaultSandbox: true
`,
    );
    writePolicy(
      directory,
      'policy-b.yaml',
      `
slug: duplicated
name: Policy B
`,
    );

    expect(() => new PolicyConfigRepositoryAdapter()).toThrow('Duplicate policy slug');
  });
});

