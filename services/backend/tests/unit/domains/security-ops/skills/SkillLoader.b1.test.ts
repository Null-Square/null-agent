import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RUNTIME_CATALOG_SNAPSHOT_FILE,
  SkillCatalogValidationError,
  SkillLoader,
  resolveDefaultSkillsDir,
} from '@/domains/security-ops/skills/SkillLoader';

const EXISTING_SLUGS = [
  'broken-auth', 'business-logic', 'csrf', 'dom-xss', 'graphql', 'idor',
  'information-disclosure', 'insecure-file-uploads', 'jwt-attacks', 'mass-assignment',
  'nextjs', 'nosql-injection', 'open-redirect', 'path-traversal', 'prototype-pollution',
  'race-conditions', 'rce', 'sql-injection', 'ssrf', 'subdomain-takeover', 'xss', 'xxe',
  'api-enumeration', 'broad-surface-scan', 'js-surface-analysis', 'network-recon',
  'securityops-planning', 'security-reporting', 'spa-recon', 'validation',
  'tooling-dalfox', 'tooling-ffuf', 'tooling-gitleaks', 'tooling-httpx',
  'tooling-interactsh', 'tooling-katana', 'tooling-naabu', 'tooling-nmap',
  'tooling-nuclei', 'tooling-semgrep', 'tooling-sqlmap', 'tooling-subfinder',
  'tooling-trivy', 'tooling-trufflehog', 'compliance-access-control',
  'compliance-evidence-review', 'compliance-governance-review', 'compliance-planning',
  'compliance-reporting', 'compliance-technical-readiness',
] as const;

const NEW_SLUGS = [
  'access-control', 'session-management', 'oauth-oidc', 'cors', 'clickjacking',
  'websockets', 'http-request-smuggling', 'web-cache-security', 'host-header-attacks',
  'header-injection', 'command-injection', 'ssti', 'insecure-deserialization',
  'secondary-server-injections', 'http-parameter-method-confusion',
  'csv-formula-injection', 'client-side-trust-boundaries',
  'web-security-misconfiguration', 'cryptographic-implementation',
  'resource-consumption', 'unsafe-api-consumption', 'webhook-security',
  'grpc-security', 'soap-security', 'software-supply-chain', 'source-aware-whitebox',
  'ai-application-security', 'cms-wordpress', 'cms-drupal', 'cms-joomla', 'django',
  'fastapi', 'nestjs', 'express', 'spring-boot', 'laravel', 'rails', 'cloud-aws',
  'cloud-azure', 'cloud-gcp', 'kubernetes-security', 'iac-container-security',
  'supabase', 'firebase-firestore', 'auth0', 'grafana-prometheus', 'tooling-python',
  'tooling-browser', 'tooling-schemathesis', 'tooling-grpcurl', 'tooling-jwt-tool',
  'tooling-tls',
] as const;

const DEEPENED_SLUGS = new Set([
  'api-enumeration', 'broad-surface-scan', 'broken-auth', 'business-logic', 'csrf',
  'dom-xss', 'graphql', 'idor', 'information-disclosure', 'insecure-file-uploads',
  'js-surface-analysis', 'jwt-attacks', 'mass-assignment', 'network-recon', 'nextjs',
  'path-traversal', 'race-conditions', 'rce', 'securityops-planning', 'spa-recon',
  'ssrf', 'validation', 'xss',
]);

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-b1-skills-'));
  tempDirs.push(dir);
  return dir;
};

const writeCatalog = async (
  root: string,
  entries: Array<{ slug: string; enabled: boolean }>,
): Promise<void> => {
  await fs.writeFile(
    path.resolve(root, 'catalog.yaml'),
    YAML.stringify({
      schema_version: 1,
      catalog_version: 'test-release',
      expected_active_count: entries.filter((entry) => entry.enabled).length,
      skills: entries.map((entry) => ({
        ...entry,
        owner_category: 'test',
        delivery_scope: 'existing',
      })),
    }),
    'utf8',
  );
};

const copyStandaloneSkill = async (root: string, slug: string): Promise<void> => {
  const destination = path.resolve(root, slug);
  await fs.cp(path.resolve(resolveDefaultSkillsDir(), slug), destination, { recursive: true });
  const skillPath = path.resolve(destination, 'SKILL.md');
  const raw = await fs.readFile(skillPath, 'utf8');
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`missing frontmatter for ${slug}`);
  const metadata = YAML.parse(match[1]) as Record<string, unknown>;
  metadata.related_skills = [];
  metadata.handoff_skills = [];
  await fs.writeFile(
    skillPath,
    `---\n${YAML.stringify(metadata).trimEnd()}\n---\n${match[2]}`,
    'utf8',
  );
};

const evaluationLoader = (
  root: string = resolveDefaultSkillsDir(),
  runtimeSnapshotPolicy: 'verify-if-present' | 'ignore' = 'verify-if-present',
): SkillLoader => new SkillLoader(root, {
  mode: 'evaluation',
  runtimeSnapshotPolicy,
});

const writeRuntimeSnapshot = async (root: string): Promise<void> => {
  const snapshot = await evaluationLoader(root, 'ignore').createRuntimeCatalogSnapshot();
  await fs.writeFile(
    path.resolve(root, RUNTIME_CATALOG_SNAPSHOT_FILE),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('B1 skill catalog contract', () => {
  it('loads the exact locked 102-skill set with normalized metadata and content hashes', async () => {
    const loader = evaluationLoader();
    const activeCatalog = await loader.loadSkillCatalog();
    const catalog = activeCatalog.filter((skill) => skill.releaseTrack === 'b1');
    const expected = [...EXISTING_SLUGS, ...NEW_SLUGS].sort();

    expect(catalog).toHaveLength(102);
    expect(catalog.map((skill) => skill.slug).sort()).toEqual(expected);
    expect(
      activeCatalog
        .filter((skill) => skill.releaseTrack === 'product-extension')
        .map((skill) => skill.slug)
        .sort(),
    ).toEqual([
      'code-review-analysis',
      'code-review-mapping',
      'code-review-planning',
      'code-review-reporting',
      'code-review-validation',
      // Threat Watch verification ships on the extension track so the locked
      // B1 set of 102 stays exactly what it was.
      'cve-verification',
    ]);
    expect(catalog.filter((skill) => skill.deliveryScope === 'new')).toHaveLength(52);
    expect(catalog.filter((skill) => skill.deliveryScope === 'deepened')).toHaveLength(23);
    expect(
      new Set(catalog.filter((skill) => skill.deliveryScope === 'deepened').map((skill) => skill.slug)),
    ).toEqual(DEEPENED_SLUGS);

    for (const skill of catalog) {
      expect(skill.enabled, skill.slug).toBe(true);
      expect(skill.catalogVersion, skill.slug).toBe('3.0.0-b1');
      expect(skill.versionHash, skill.slug).toMatch(/^[a-f0-9]{64}$/);
      expect(skill.notWhen.length, skill.slug).toBeGreaterThan(0);
      expect(skill.techniqueIds.length, skill.slug).toBeGreaterThan(0);
      expect(skill.sourceModes.length, skill.slug).toBeGreaterThan(0);
      expect(skill.fixtureManifest, skill.slug).toBe('fixtures/manifest.yaml');
      expect(skill.supportingFiles, skill.slug).toEqual(
        expect.arrayContaining(['methodology.md', 'examples.md', 'fixtures/manifest.yaml']),
      );
    }
  });

  it('changes the version hash when a declared support or fixture file changes', async () => {
    const root = await makeTempDir();
    await copyStandaloneSkill(root, 'cors');
    await writeCatalog(root, [{ slug: 'cors', enabled: true }]);

    const initial = (await evaluationLoader(root).loadSkillCatalog())[0].versionHash;
    await fs.appendFile(path.resolve(root, 'cors/examples.md'), '\nDeclared example mutation.\n', 'utf8');
    const supportMutation = (await evaluationLoader(root).loadSkillCatalog())[0].versionHash;
    await fs.appendFile(path.resolve(root, 'cors/fixtures/cases.yaml'), '\n# fixture mutation\n', 'utf8');
    const fixtureMutation = (await evaluationLoader(root).loadSkillCatalog())[0].versionHash;

    expect(supportMutation).not.toBe(initial);
    expect(fixtureMutation).not.toBe(supportMutation);
  });

  it('excludes a disabled skill while retaining audited diagnostic loading and rollback behavior', async () => {
    const root = await makeTempDir();
    for (const slug of ['cors', 'clickjacking']) {
      await copyStandaloneSkill(root, slug);
    }
    await writeCatalog(root, [
      { slug: 'cors', enabled: true },
      { slug: 'clickjacking', enabled: false },
    ]);
    const loader = evaluationLoader(root);

    expect((await loader.loadSkillCatalog()).map((skill) => skill.slug)).toEqual(['cors']);
    expect(await loader.loadSkillBySlug('clickjacking')).toBeNull();
    await expect(
      loader.loadSkillBySlug('clickjacking', { includeDisabled: true }),
    ).rejects.toThrow('auditReason');
    await expect(
      loader.loadSkillBySlug('clickjacking', {
        includeDisabled: true,
        auditReason: 'production-like emergency diagnosis',
      }),
    ).resolves.toMatchObject({ slug: 'clickjacking', enabled: false });

    await writeCatalog(root, [
      { slug: 'cors', enabled: false },
      { slug: 'clickjacking', enabled: true },
    ]);
    const rolledBack = await evaluationLoader(root).loadSkillCatalog();
    expect(rolledBack.map((skill) => skill.slug)).toEqual(['clickjacking']);
  });

  it('rejects traversal in declared supporting files', async () => {
    const root = await makeTempDir();
    await copyStandaloneSkill(root, 'cors');
    await writeCatalog(root, [{ slug: 'cors', enabled: true }]);
    const skillPath = path.resolve(root, 'cors/SKILL.md');
    const raw = await fs.readFile(skillPath, 'utf8');
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    expect(match).not.toBeNull();
    const metadata = YAML.parse(match?.[1] ?? '') as Record<string, unknown>;
    metadata.supporting_files = [
      ...(metadata.supporting_files as string[]),
      '../escape.txt',
    ];
    await fs.writeFile(
      skillPath,
      `---\n${YAML.stringify(metadata).trimEnd()}\n---\n${match?.[2] ?? ''}`,
      'utf8',
    );

    await expect(evaluationLoader(root).loadSkillCatalog()).rejects.toBeInstanceOf(
      SkillCatalogValidationError,
    );
  });

  it('loads the runtime catalog from the release snapshot without evaluation fixtures', async () => {
    const root = await makeTempDir();
    await copyStandaloneSkill(root, 'cors');
    await writeCatalog(root, [{ slug: 'cors', enabled: true }]);
    await writeRuntimeSnapshot(root);
    const expectedVersionHash = (
      await evaluationLoader(root).loadSkillCatalog()
    )[0].versionHash;

    await fs.rm(path.resolve(root, 'cors/fixtures'), { recursive: true, force: true });

    await expect(new SkillLoader(root).loadSkillCatalog()).resolves.toMatchObject([
      { slug: 'cors', versionHash: expectedVersionHash },
    ]);
    await expect(evaluationLoader(root).loadSkillCatalog()).rejects.toThrow(
      'fixture_manifest references a missing file',
    );
  });

  it('rejects a runtime catalog snapshot when a shipped skill asset changes', async () => {
    const root = await makeTempDir();
    await copyStandaloneSkill(root, 'cors');
    await writeCatalog(root, [{ slug: 'cors', enabled: true }]);
    await writeRuntimeSnapshot(root);
    await fs.appendFile(path.resolve(root, 'cors/examples.md'), '\nruntime mutation\n', 'utf8');

    await expect(new SkillLoader(root).loadSkillCatalog()).rejects.toThrow(
      'stale runtimeHash for cors',
    );
  });
});
