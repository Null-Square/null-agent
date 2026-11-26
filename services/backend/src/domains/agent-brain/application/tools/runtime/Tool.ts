import type { ToolManifest } from '../../../domain/manifests';
import type { ToolArgs } from '../types';
import { type ToolContext } from './ToolContext';

export type ToolParamsSchema = Record<string, unknown>;

export type ToolRisk = 'read' | 'write' | 'network' | 'remote' | 'compute';

export type ToolReturns = 'markdown' | 'text' | 'json';

export type ToolProgressKind = 'canonical' | 'evidence';

export interface ToolMeta {
  name: string;
  description: string;
  category: string;
  schema: ToolParamsSchema;
  risks: ToolRisk[];
  requires?: string[];
  returns?: ToolReturns;
  isCapability?: boolean;
  progressKind?: ToolProgressKind;
}

export interface ToolImpl {
  meta: ToolMeta;
  manifest?: ToolManifest;
  run(args: ToolArgs, ctx: ToolContext): Promise<ToolResult>;
}

export type ToolControlSignal =
  | {
      kind: 'awaiting_approval';
      reason: 'plan_submission';
      runId?: string;
    };

export type ToolResult = {
  ok: boolean;
  message?: string;
  data?: unknown;
  control?: ToolControlSignal;
};
