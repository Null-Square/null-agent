import type { ToolImpl } from './runtime/Tool';
import type { ToolModuleDefinition } from './types';
import type { ToolManifest } from '../../domain/manifests';

export const fromToolImpl = (tool: ToolImpl): ToolModuleDefinition => {
  const manifest = tool.manifest ?? manifestFromMeta(tool.meta);

  return {
    manifest,
    meta: tool.meta,
    run: tool.run.bind(tool),
  };
};

function manifestFromMeta(meta: ToolImpl['meta']): ToolManifest {
  const category = typeof meta.category === 'string' ? meta.category.trim() : '';
  if (!category) {
    throw new Error(`Tool "${meta.name}" is missing meta.category (required for manifest generation).`);
  }

  const risk = Array.isArray(meta.risks) && meta.risks.length > 0 ? String(meta.risks[0]) : undefined;
  const returns = meta.returns ?? 'json';

  return {
    id: meta.name,
    summary: meta.description,
    argsSchema: meta.schema,
    meta: {
      category,
      ...(risk ? { risk } : {}),
      ...(meta.isCapability !== undefined ? { isCapability: meta.isCapability } : {}),
      ...(meta.requires ? { requires: meta.requires } : {}),
      ...(meta.progressKind ? { progressKind: meta.progressKind } : {}),
      returns,
    },
  };
}
