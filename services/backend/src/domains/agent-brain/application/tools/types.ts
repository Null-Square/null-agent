import type { ToolManifest } from '../../domain/manifests';
import type { ToolMeta, ToolResult } from './runtime/Tool';
import type { ToolContext } from './runtime/ToolContext';

export type ToolArgs = Record<string, unknown>;

export type ToolRun = (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolModuleDefinition {
  manifest: ToolManifest;
  meta: ToolMeta;
  run: ToolRun;
  sourceFile?: string;
}

export type ToolModuleExport =
  | ToolModuleDefinition
  | ToolModuleDefinition[]
  | { tools: ToolModuleDefinition[] }
  | { default: ToolModuleDefinition | ToolModuleDefinition[] }
  | { default: { tools: ToolModuleDefinition[] } };
