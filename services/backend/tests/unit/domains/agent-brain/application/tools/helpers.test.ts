import { describe, it, expect } from 'vitest';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';

describe('fromToolImpl', () => {
  it('generates a manifest from meta when tool.manifest is missing', async () => {
    const tool: ToolImpl = {
      meta: {
        name: 't1',
        description: 'tool one',
        category: 'testing',
        schema: {
          type: 'object',
          properties: {},
          required: [],
        },
        risks: ['read'],
      },
      async run() {
        return { ok: true, data: { name: this.meta.name } };
      },
    };

    const definition = fromToolImpl(tool);

    expect(definition.manifest).toEqual({
      id: 't1',
      summary: 'tool one',
      argsSchema: tool.meta.schema,
      meta: {
        category: 'testing',
        risk: 'read',
        returns: 'json',
      },
    });

    await expect(definition.run({}, {} as any)).resolves.toEqual({
      ok: true,
      data: { name: 't1' },
    });
  });

  it('uses the explicit manifest when provided', () => {
    const manifest = {
      id: 'explicit',
      summary: 'explicit manifest',
      meta: { category: 'testing' },
    } as const;

    const tool: ToolImpl = {
      meta: {
        name: 't2',
        description: 'tool two',
        category: 'testing',
        schema: { type: 'object', properties: {}, required: [] },
        risks: ['read'],
      },
      manifest,
      async run() {
        return { ok: true };
      },
    };

    const definition = fromToolImpl(tool);
    expect(definition.manifest).toBe(manifest);
  });

  it('throws when meta.category is missing/blank and no manifest is provided', () => {
    const tool: ToolImpl = {
      meta: {
        name: 't3',
        description: 'tool three',
        category: '   ',
        schema: { type: 'object', properties: {}, required: [] },
        risks: ['read'],
      },
      async run() {
        return { ok: true };
      },
    };

    expect(() => fromToolImpl(tool)).toThrow(/meta\.category/i);
  });
});

