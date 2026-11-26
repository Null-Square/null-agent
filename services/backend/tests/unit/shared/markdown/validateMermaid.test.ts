import { describe, it, expect } from 'vitest';
import {
  validateMermaidInMarkdown,
  formatMermaidErrors,
} from '@/shared/markdown/validateMermaid';

describe('validateMermaidInMarkdown', () => {
  it('returns ok when markdown contains no mermaid fences', async () => {
    const result = await validateMermaidInMarkdown('# Title\n\nSome prose with `inline` code.\n\n```js\nconsole.log(1);\n```\n');
    expect(result.ok).toBe(true);
    expect(result.blocks).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('returns ok for empty input', async () => {
    expect(await validateMermaidInMarkdown('')).toEqual({ ok: true, blocks: 0, errors: [] });
  });

  it('accepts a valid flowchart', async () => {
    const md = '```mermaid\ngraph TD\n  A-->B\n  B-->C\n```';
    const result = await validateMermaidInMarkdown(md);
    expect(result).toEqual({ ok: true, blocks: 1, errors: [] });
  });

  it('accepts valid flowchart labels that require Mermaid sanitization at runtime', async () => {
    const md = [
      '```mermaid',
      'graph TD',
      '    A[Compliance Readiness] --> B[SOC 2: 26%]',
      '    B -->|needs review| C((HIPAA Technical Safeguards))',
      '```',
    ].join('\n');
    const result = await validateMermaidInMarkdown(md);
    expect(result).toEqual({ ok: true, blocks: 1, errors: [] });
  });

  it('accepts valid flowchart subgraph labels that require Mermaid sanitization at runtime', async () => {
    const md = [
      '```mermaid',
      'flowchart TD',
      '    subgraph Readiness["Compliance Readiness Overview"]',
      '        SOC2[SOC 2: 26%]',
      '        ISO[ISO 27001: 38%]',
      '    end',
      '```',
    ].join('\n');
    const result = await validateMermaidInMarkdown(md);
    expect(result).toEqual({ ok: true, blocks: 1, errors: [] });
  });

  it('accepts a valid sequence diagram', async () => {
    const md = '```mermaid\nsequenceDiagram\n  participant A\n  participant B\n  A->>B: hi\n```';
    const result = await validateMermaidInMarkdown(md);
    expect(result.ok).toBe(true);
    expect(result.blocks).toBe(1);
  });

  it('rejects a flowchart with a malformed arrow', async () => {
    const md = '```mermaid\ngraph TD\n  A--->>B[oops\n```';
    const result = await validateMermaidInMarkdown(md);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.blockIndex).toBe(0);
    expect(result.errors[0]?.errorLine).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/parse|expecting|unexpected/i);
    expect(result.errors[0]?.snippet.length).toBeGreaterThan(0);
  });

  it('rejects an unknown diagram type', async () => {
    const md = '```mermaid\ngraffle TD\n  A-->B\n```';
    const result = await validateMermaidInMarkdown(md);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('reports per-block errors with stable indexes when multiple fences exist and one is bad', async () => {
    const md = [
      'Intro paragraph.',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      'Middle prose.',
      '',
      '```mermaid',
      'graph TD',
      '  A--->>BROKEN[',
      '```',
      '',
      'Closing prose.',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  participant X',
      '  participant Y',
      '  X->>Y: ok',
      '```',
      '',
    ].join('\n');
    const result = await validateMermaidInMarkdown(md);
    expect(result.blocks).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.blockIndex).toBe(1);
    expect(result.errors[0]?.startLine).toBeGreaterThan(1);
  });

  it('accepts tilde-fenced mermaid blocks', async () => {
    const md = '~~~mermaid\ngraph TD\n  A-->B\n~~~';
    const result = await validateMermaidInMarkdown(md);
    expect(result.ok).toBe(true);
    expect(result.blocks).toBe(1);
  });

  it('ignores fences whose info string is not mermaid', async () => {
    const md = '```mermaidish\ngraph TD\n  A-->B\n```';
    const result = await validateMermaidInMarkdown(md);
    expect(result.blocks).toBe(0);
  });

  it('formatMermaidErrors returns an empty string when ok', () => {
    expect(formatMermaidErrors({ ok: true, blocks: 0, errors: [] })).toBe('');
  });

  it('formatMermaidErrors emits one entry per failure', () => {
    const out = formatMermaidErrors({
      ok: false,
      blocks: 2,
      errors: [
        { blockIndex: 0, startLine: 5, errorLine: 2, message: 'bad', snippet: 'graph TD' },
        { blockIndex: 1, startLine: 12, errorLine: null, message: 'rejected', snippet: 'pie' },
      ],
    });
    expect(out).toMatch(/block 1/);
    expect(out).toMatch(/block 2/);
    expect(out).toMatch(/markdown line/);
  });
});
