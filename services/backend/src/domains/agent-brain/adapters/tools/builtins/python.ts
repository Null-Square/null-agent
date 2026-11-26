import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { registerToolContract } from '@/domains/agent-brain/application/tools/ToolContractRegistry';
import { executePythonSession, type PythonSessionArgs } from '../runtime/pythonSessionRuntime';

const PYTHON_SESSION_DESCRIPTION = [
  'Run Python in a persistent per-run interpreter inside the sandbox or attached private runner. Variables, imports, helper objects, and PoC state persist across python_session exec calls until reset or run teardown.',
  '',
  'WHEN TO USE:',
  '- Use python_session for stateful exploit development, multi-step PoCs, custom parsers, response diffing, replay harnesses, and proof scripts that benefit from persistent Python objects.',
  '- Use http_payload for ordinary HTTP evidence, http_raw_send for byte-exact malformed HTTP/1.1 transport probes, and shell_run for scanners or one-shot CLI tools.',
  '- Do not use python_session just to run curl, nmap, nuclei, ffuf, or other scanner commands. Those belong in shell_run so scanner budgets, artifact rules, and managed jobs apply.',
  '',
  'ACTIONS:',
  '- exec: run Python code in the persistent namespace. The last expression is returned as result_repr.',
  '- reset: clear user variables/imports while keeping built-in helpers available.',
  '- status: report process/session state and defined variable names.',
  '- replay: re-execute a stored http_payload or http_raw_send exchange by exchange_id and return a diff.',
  '- replay_poc: execute a saved workspace PoC file in the persistent namespace.',
  '- stop: stop the supervisor process for this run workspace.',
  '',
  'PRE-INJECTED HELPERS:',
  '- http_history.get(id) / http_history.list(limit=20): read stored http_payload and http_raw_send exchanges.',
  '- raw_send(...): send exact raw HTTP bytes and write .artifacts/raw-http plus .raw-http-history.ndjson entries.',
  '- replay(exchange_id): replay a stored HTTP/raw exchange and return a diff.',
  '- workspace: safe workspace file helper with path/read/write/list methods.',
  '- save_poc(name, code): write a re-runnable Python PoC under .artifacts/poc/.',
  '- oob: workspace-backed token/check helper for PoC bookkeeping; use dedicated oob_* tools for live OOB service interactions.',
  '',
  'OUTPUT AND EVIDENCE:',
  '- Large stdout, stderr, and result_repr values are truncated inline and written as artifacts under .artifacts/python-session/.',
  '- raw_send writes raw request/response byte artifacts and marks them not report-safe by default because they may contain credentials.',
  '- Include returned exchange IDs, PoC paths, and artifact paths when promoting findings or handing off validation evidence.',
].join('\n');

const PYTHON_SESSION_CONTRACT = registerToolContract({
  name: 'python_session',
  description: PYTHON_SESSION_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['exec', 'reset', 'status', 'stop', 'replay', 'replay_poc'],
        description: 'Action to perform. Default: exec.',
      },
      code: {
        type: 'string',
        description: 'Python code to execute when action=exec. Variables/imports persist across calls.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Per-call timeout in milliseconds. Default: 30000; capped by runtime policy.',
      },
      label: {
        type: 'string',
        description: 'Optional short label for trace readability.',
      },
      exchange_id: {
        type: 'string',
        description: 'Stored http_payload history_entry_id or http_raw_send raw_exchange_id for action=replay.',
      },
      poc_path: {
        type: 'string',
        description: 'Workspace-relative saved PoC path for action=replay_poc.',
      },
    },
  },
});

export const PythonSession: ToolImpl = {
  meta: {
    name: 'python_session',
    description: PYTHON_SESSION_CONTRACT.description,
    category: 'shell',
    progressKind: 'evidence',
    schema: PYTHON_SESSION_CONTRACT.schema,
    risks: ['compute', 'read', 'write', 'network'],
  },

  async run(args: PythonSessionArgs, ctx) {
    const action = typeof args.action === 'string' ? args.action : 'exec';
    return runWithGuards(
      PythonSession.meta,
      ctx,
      async () => executePythonSession(args, ctx),
      {},
      { action, label: args.label },
    );
  },
};

export const PythonBuiltins: ToolImpl[] = [PythonSession];

export const tools: ToolModuleDefinition[] = PythonBuiltins.map(fromToolImpl);
