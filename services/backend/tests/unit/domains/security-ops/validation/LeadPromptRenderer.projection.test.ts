import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { LeadPromptRenderer } from '@/domains/security-ops/validation/LeadPromptRenderer';

/**
 * D10 — the canonical lead record and its workspace prompt projection were not one unit.
 *
 * Run 3.1 created 12 validation leads and wrote 4 prompt files; validation then attempted
 * reads of files that had never existed. 3.2 improved the ratio and kept the architecture,
 * so several live leads still had no readable prompt at validation startup.
 *
 * A lead is canonical. Its prompt is a projection of it, which may be missing or rebuilt at
 * any time — so the record must never claim a projection it cannot show, and a missing one
 * must be repairable from canonical data rather than fatal.
 */
const lead = {
  source: 'enumeration',
  riskFamily: 'access-control',
  hypothesis: 'Tenant identifiers may be interchangeable on the account endpoint.',
  target: 'https://api.example.com',
  method: 'GET',
  path: '/api/accounts/{id}',
  priority: 'high',
};

describe('validation lead prompt projection', () => {
  let workspaceDir: string;
  let renderer: LeadPromptRenderer;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-projection-'));
    renderer = new LeadPromptRenderer();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const promptPathFor = (leadId: string): string =>
    path.resolve(workspaceDir, '.artifacts', 'lead-prompts', `${leadId}.md`);

  it('renders a prompt that is readable and states its own digest', async () => {
    const rendered = await renderer.render({ leadId: 'lead-1', workspaceDir, data: lead });
    const content = await fs.readFile(promptPathFor('lead-1'), 'utf8');

    expect(content).toContain(`Prompt SHA256: ${rendered.promptSha256}`);
    expect(rendered.promptPath).toBe('.artifacts/lead-prompts/lead-1.md');
  });

  it('refuses to report a projection it cannot read back', async () => {
    // A workspace that cannot hold the file at all. The lead is still canonical; what must
    // not happen is a record that advertises a path nothing can open.
    const unwritable = path.join(workspaceDir, 'missing-root', '\0invalid');

    await expect(renderer.render({ leadId: 'lead-2', workspaceDir: unwritable, data: lead }))
      .rejects.toThrow();
  });

  it('detects a projection that has drifted from its digest', async () => {
    const rendered = await renderer.render({ leadId: 'lead-3', workspaceDir, data: lead });
    await fs.writeFile(promptPathFor('lead-3'), 'someone edited this\nPrompt SHA256: ' + 'a'.repeat(64) + '\n', 'utf8');

    const repaired = await renderer.ensureRendered({
      leadId: 'lead-3',
      workspaceDir,
      data: rendered.normalizedLead,
      expectedSha256: rendered.promptSha256,
    });

    expect(repaired.repaired).toBe(true);
    const content = await fs.readFile(promptPathFor('lead-3'), 'utf8');
    expect(content).toContain(`Prompt SHA256: ${repaired.promptSha256}`);
  });

  it('repairs a projection the workspace lost', async () => {
    const rendered = await renderer.render({ leadId: 'lead-4', workspaceDir, data: lead });
    await fs.rm(promptPathFor('lead-4'));

    // The canonical record stores the normalized lead, which carries the render time. A
    // repair from it must reproduce the same bytes, not author a new prompt.
    const repaired = await renderer.ensureRendered({
      leadId: 'lead-4',
      workspaceDir,
      data: rendered.normalizedLead,
      expectedSha256: rendered.promptSha256,
    });

    expect(repaired.repaired).toBe(true);
    expect(repaired.promptSha256).toBe(rendered.promptSha256);
    await expect(fs.readFile(promptPathFor('lead-4'), 'utf8')).resolves.toContain('Prompt SHA256');
  });

  it('does not rewrite a projection that is already correct', async () => {
    const rendered = await renderer.render({ leadId: 'lead-5', workspaceDir, data: lead });
    const before = (await fs.stat(promptPathFor('lead-5'))).mtimeMs;

    const result = await renderer.ensureRendered({
      leadId: 'lead-5',
      workspaceDir,
      data: lead,
      expectedSha256: rendered.promptSha256,
    });
    const after = (await fs.stat(promptPathFor('lead-5'))).mtimeMs;

    expect(result.repaired).toBe(false);
    expect(after).toBe(before);
  });

  it('renders from canonical data when no digest is known', async () => {
    // A lead whose projection was never recorded is still workable: the canonical record is
    // enough to rebuild the prompt.
    const result = await renderer.ensureRendered({ leadId: 'lead-6', workspaceDir, data: lead });

    expect(result.repaired).toBe(true);
    await expect(fs.readFile(promptPathFor('lead-6'), 'utf8')).resolves.toContain('Prompt SHA256');
  });
});
