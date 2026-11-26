import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LeadPromptRenderer } from '@/domains/security-ops/validation/LeadPromptRenderer';

describe('LeadPromptRenderer', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'lead-prompt-renderer-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('renders a validation lead prompt from the bundled default template', async () => {
    const renderer = new LeadPromptRenderer({
      skillLoader: {
        loadSkillCatalog: async () => [],
        loadSkillBySlug: async () => null,
      } as never,
    });
    const leadId = '11111111-1111-4111-8111-111111111111';

    const result = await renderer.render({
      leadId,
      workspaceDir,
      now: new Date('2026-03-21T07:00:00.000Z'),
      data: {
        source: 'validation.lead',
        riskFamily: 'idor',
        target: 'api.example.com',
        method: 'GET',
        path: '/api/orders/{orderId}',
        parameter: 'orderId',
        hypothesis: 'Order IDs may not be tenant-isolated.',
      },
    });

    const content = await readFile(result.absolutePath, 'utf8');
    expect(result.promptPath).toBe(`.artifacts/lead-prompts/${leadId}.md`);
    expect(result.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(content).toContain(`Prompt SHA256: ${result.promptSha256}`);
    expect(content).toContain('"riskFamily": "idor"');
    expect(content).toContain('No matching validation methodology was attached.');
  });

  // H-2026-05-28-007: r1 failed with ENOENT on validation-lead-prompt.md because the
  // runtime image lacked the template. The Dockerfile now copies templates and asserts
  // `test -f ./templates/validation-lead-prompt.md` at build time; this guards the same
  // file at unit-test time so a deletion/move is caught before any evaluation run.
  it('ships the bundled validation-lead template at the packaged path the Dockerfile copies', async () => {
    // Tests run with cwd = services/backend, which is the WORKDIR the Dockerfile COPY targets.
    const packagedTemplate = resolve(process.cwd(), 'templates', 'validation-lead-prompt.md');
    await expect(access(packagedTemplate)).resolves.toBeUndefined();
    const template = await readFile(packagedTemplate, 'utf8');
    expect(template.trim().length).toBeGreaterThan(0);
  });

  it('keeps bundled prompt templates visible to the backend Docker build context', async () => {
    const dockerIgnore = await readFile(resolve(process.cwd(), '..', '..', '.dockerignore'), 'utf8');
    expect(dockerIgnore).toContain('**/*.md');
    expect(dockerIgnore).toContain('!services/backend/templates/**/*.md');
  });

  it('renders with a fully default-constructed renderer (no templatePath override) without ENOENT', async () => {
    // Reproduces the exact r1 failure mode: a default renderer must resolve the bundled
    // template via its own candidate-path resolution and render, not throw ENOENT.
    const renderer = new LeadPromptRenderer({
      skillLoader: {
        loadSkillCatalog: async () => [],
        loadSkillBySlug: async () => null,
      } as never,
    });

    await expect(
      renderer.render({
        leadId: '22222222-2222-4222-8222-222222222222',
        workspaceDir,
        now: new Date('2026-05-29T00:00:00.000Z'),
        data: { riskFamily: 'ssrf', target: 'api.example.com' },
      }),
    ).resolves.toMatchObject({ promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
});
