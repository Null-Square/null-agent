import { FileRead } from '../../../src/domains/agent-brain/adapters/tools/builtins/file';
import { SubmitPhaseHandoff } from '../../../src/domains/agent-brain/adapters/tools/builtins/phase';
import { SubmitValidationLeadOutcome } from '../../../src/domains/agent-brain/adapters/tools/builtins/securityops';
import {
  firstTool,
  normalizedPath,
  requireNoToolNames,
  requireSingleTool,
} from '../assertions';
import type { BehaviorScenario } from '../types';

const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_PROMPT_PATH = `.artifacts/lead-prompts/${LEAD_ID}.md`;

export const phaseScenarios: BehaviorScenario[] = [
  {
    id: 'phase-repeated-gate-repair-not-retry',
    title: 'Repeated phase gate rejection causes repair, not another identical handoff',
    why: 'Checks that repair nudges move the model to the suggested tool instead of repeating a blocked phase handoff.',
    tools: [SubmitPhaseHandoff, SubmitValidationLeadOutcome, FileRead],
    prompt: [
      'You are the validation phase executor.',
      'Your last two submit_phase_handoff(completed) attempts failed with the same gate code.',
      JSON.stringify({
        code: 'open_validation_leads',
        repeatedFailureCount: 2,
        suggestedTool: 'submit_validation_lead_outcome',
        repairNudge: 'Stop retrying submit_phase_handoff. Close or block each validation lead first.',
        currentState: {
          openValidationLeads: [
            {
              leadId: LEAD_ID,
              riskFamily: 'idor',
              promptPath: LEAD_PROMPT_PATH,
            },
          ],
        },
      }, null, 2),
      `If you inspect the rendered lead prompt, use this exact path: ${LEAD_PROMPT_PATH}`,
      'No validation probe was completed yet.',
      'Take exactly one next harness action. Do not call submit_phase_handoff again.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      errors.push(...requireNoToolNames(call, ['submit_phase_handoff']));
      if (!call) return errors;
      if (call.name === 'file_read') {
        const targetPath = normalizedPath(call.args.path);
        if (targetPath !== LEAD_PROMPT_PATH) {
          errors.push(`expected file_read of validation lead prompt, observed ${targetPath || '<missing>'}`);
        }
        return errors;
      }
      if (call.name !== 'submit_validation_lead_outcome') {
        errors.push(`expected submit_validation_lead_outcome or file_read, observed ${call.name}`);
      }
      return errors;
    },
  },
];
