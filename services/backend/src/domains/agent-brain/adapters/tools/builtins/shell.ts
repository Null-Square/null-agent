import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';

import { ShellRun, WaitForShellJob } from './shell/tools';

export { ShellRun, WaitForShellJob } from './shell/tools';

export const ShellBuiltins = [ShellRun, WaitForShellJob];

/** Registry-compatible export - ToolModuleDefinition format */
export const tools: ToolModuleDefinition[] = ShellBuiltins.map(fromToolImpl);
