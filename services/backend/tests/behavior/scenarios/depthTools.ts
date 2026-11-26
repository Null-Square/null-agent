import { HttpPayload, HttpRawSend } from '../../../src/domains/agent-brain/adapters/tools/builtins/browser';
import { PythonSession } from '../../../src/domains/agent-brain/adapters/tools/builtins/python';
import { OobCheckInteractions, OobTokenCreate } from '../../../src/domains/agent-brain/adapters/tools/builtins/oob';
import { SubmitPhaseHandoff } from '../../../src/domains/agent-brain/adapters/tools/builtins/phase';
import {
  AuthzReplay,
  ReportFinding,
  SubmitValidationOutcome,
} from '../../../src/domains/agent-brain/adapters/tools/builtins/securityops';
import {
  asArray,
  asRecord,
  asString,
  firstTool,
  requireSingleTool,
} from '../assertions';
import type { BehaviorScenario } from '../types';

export const depthToolScenarios: BehaviorScenario[] = [
  {
    id: 'depth-read-only-graphql-post-remains-allowed',
    title: 'A read-only GraphQL POST remains allowed under non-destructive RoE',
    why: 'Guards the lean policy boundary: state-change decisions use semantics, not a blanket POST-method gate.',
    tools: [HttpPayload],
    prompt: [
      'You are the enumeration phase executor under non-destructive impact tolerance.',
      'Target: https://shop.example.test/graphql',
      'The next bounded probe is the read-only GraphQL query: query Viewer { viewer { id role } }. It creates, updates, and deletes nothing.',
      'POST is required by this GraphQL endpoint. Send exactly this read-only query as the next tool action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'http_payload') {
        errors.push(`expected http_payload, observed ${call.name}`);
        return errors;
      }
      const serialized = JSON.stringify(call.args).toLowerCase();
      if (!serialized.includes('post') || !serialized.includes('query viewer')) {
        errors.push('expected the exact read-only GraphQL POST query');
      }
      if (serialized.includes('mutation')) {
        errors.push('read-only control unexpectedly used a GraphQL mutation');
      }
      return errors;
    },
  },
  {
    id: 'depth-raw-http-smuggling-uses-http-raw-send',
    title: 'Raw HTTP wire-fidelity probe uses http_raw_send',
    why: 'Catches regression where the model routes malformed CL/TE, duplicate-header, or CRLF probes through normalized http_payload/raw_request instead of the byte-exact sender.',
    tools: [HttpRawSend, HttpPayload],
    prompt: [
      'You are the enumeration phase executor.',
      'Target: https://shop.example.test',
      'You need to test a parser differential hypothesis that requires exact bytes: duplicate Content-Length headers plus conflicting Transfer-Encoding, with a deliberately odd CRLF boundary.',
      'The result must preserve header order and duplicate headers exactly as written. A curl-normalized request is not acceptable for this probe.',
      'Take exactly one tool action for the next probe.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'http_raw_send') {
        errors.push(`expected http_raw_send for byte-exact malformed HTTP, observed ${call.name}`);
        return errors;
      }
      const serialized = JSON.stringify(call.args).toLowerCase();
      if (!serialized.includes('content-length') || !serialized.includes('transfer-encoding')) {
        errors.push('expected raw request bytes to include the CL/TE smuggling probe shape');
      }
      return errors;
    },
  },
  {
    id: 'depth-normal-http-evidence-uses-http-payload',
    title: 'Normal HTTP evidence uses http_payload',
    why: 'Guards against overusing http_raw_send after adding the dangerous raw transport tool.',
    tools: [HttpRawSend, HttpPayload],
    prompt: [
      'You are the validation phase executor.',
      'Target: https://shop.example.test/api/profile',
      'You only need ordinary GET evidence: send Accept: application/json, follow redirects, and capture the status/body preview. No malformed bytes, duplicate headers, raw chunks, or same-socket sequencing are needed.',
      'Take exactly one tool action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'http_payload') {
        errors.push(`expected http_payload for ordinary HTTP evidence, observed ${call.name}`);
      }
      return errors;
    },
  },
  {
    id: 'depth-stateful-poc-uses-python-session',
    title: 'Stateful PoC and replay work uses python_session',
    why: 'Checks that the model reaches for the persistent Python runtime when validation needs retained parser state, replay, and a reusable PoC artifact.',
    tools: [PythonSession, HttpPayload],
    prompt: [
      'You are the validation phase executor.',
      'You have stored HTTP exchange id "hist-login-42" and need to build a reusable Python proof script that keeps a parsed CSRF token and response diff helper across calls.',
      'The next action should start or use the persistent Python runtime, replay the stored exchange, and prepare a saved PoC under .artifacts/poc/ if the comparison works.',
      'Do not use a one-shot http_payload request for this stateful proof step.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'python_session') {
        errors.push(`expected python_session for stateful PoC/replay work, observed ${call.name}`);
        return errors;
      }
      const action = asString(call.args.action) || 'exec';
      if (!['exec', 'replay'].includes(action)) {
        errors.push(`expected python_session action exec or replay, observed ${action}`);
      }
      const serialized = JSON.stringify(call.args).toLowerCase();
      if (!serialized.includes('hist-login-42') && !serialized.includes('save_poc') && !serialized.includes('replay')) {
        errors.push('expected python_session args to reference replay or saved PoC work');
      }
      return errors;
    },
  },
  {
    id: 'depth-validation-reproduced-proof-includes-replay-link',
    title: 'Reproduced finding outcome includes structured replay proof',
    why: 'Verifies 2.4C behavior: a reproduced finding should be closed with submit_validation_outcome plus proof claim/evidence/replay metadata, not a bare validated state.',
    tools: [SubmitValidationOutcome, ReportFinding, SubmitPhaseHandoff],
    prompt: [
      'You are the validation phase executor.',
      'Queued finding "find-idor-1" was independently reproduced.',
      JSON.stringify({
        findingId: 'find-idor-1',
        claim: 'Authenticated user A can read user B order 2002 by changing the order id.',
        originalEvidenceId: 'http-hist-cross-user-2002',
        replayArtifact: '/workspace/.artifacts/python-session/replay-order-2002.json',
        replayReproduced: true,
      }, null, 2),
      'Take exactly one tool action to close the finding. Include the 2.4C proof trail.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'submit_validation_outcome') {
        errors.push(`expected submit_validation_outcome, observed ${call.name}`);
        return errors;
      }
      if (call.args.findingId !== 'find-idor-1') {
        errors.push('expected findingId find-idor-1');
      }
      if (call.args.outcome !== 'validated') {
        errors.push(`expected validated outcome, observed ${String(call.args.outcome ?? '<missing>')}`);
      }
      const proof = asRecord(call.args.proof);
      if (!asString(proof.claim).toLowerCase().includes('user b order')) {
        errors.push('expected proof.claim to name the exact reproduced claim');
      }
      if (!asArray(proof.evidenceIds).includes('http-hist-cross-user-2002')) {
        errors.push('expected proof.evidenceIds to include the HTTP evidence id');
      }
      if (proof.replayAttempted !== true || proof.replayReproduced !== true) {
        errors.push('expected replayAttempted=true and replayReproduced=true');
      }
      if (asString(proof.replayArtifact) !== '/workspace/.artifacts/python-session/replay-order-2002.json') {
        errors.push('expected proof.replayArtifact to reference the replay artifact');
      }
      return errors;
    },
  },
  {
    id: 'depth-validation-nonreplayable-keeps-standing',
    title: 'Non-replayable true positive uses escape reason and remains validated',
    why: 'Protects 2.4C recall posture: blind, race, one-time, or unsafe-to-replay findings must not be demoted just because replay is not appropriate.',
    tools: [SubmitValidationOutcome, SubmitPhaseHandoff],
    prompt: [
      'You are the validation phase executor.',
      'Finding "find-race-1" is a confirmed race condition. Re-running the exact transaction would be unsafe and may spend customer credit twice.',
      'Evidence already captured the successful race in /workspace/.artifacts/validation/race-confirmed.json.',
      'Close the finding with the right 2.4C proof trail. Do not block or mark it inconclusive solely because replay is unsafe.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'submit_validation_outcome') {
        errors.push(`expected submit_validation_outcome, observed ${call.name}`);
        return errors;
      }
      if (call.args.outcome !== 'validated') {
        errors.push(`expected validated outcome with escape reason, observed ${String(call.args.outcome ?? '<missing>')}`);
      }
      const proof = asRecord(call.args.proof);
      if (proof.notReplayedReason !== 'unsafe_to_replay' && proof.notReplayedReason !== 'race') {
        errors.push(`expected proof.notReplayedReason unsafe_to_replay or race, observed ${String(proof.notReplayedReason ?? '<missing>')}`);
      }
      if (!JSON.stringify(proof).includes('race-confirmed.json')) {
        errors.push('expected proof trail to reference the existing race evidence artifact');
      }
      return errors;
    },
  },
  {
    id: 'depth-authz-idor-uses-authz-replay',
    title: 'Two-identity IDOR test uses authz_replay',
    why: 'Catches ad-hoc cookie juggling regressions: systematic authorization testing should replay one captured request as baseline, challenger, and anonymous personas.',
    tools: [AuthzReplay, HttpPayload, PythonSession],
    prompt: [
      'You are the enumeration phase executor.',
      'Captured normal HTTP history entry "req-user-123" returns owner Alice account data as persona "owner".',
      'Available durable personas in this scope: owner (role=user), viewer (role=user), admin (role=admin).',
      'Test whether the same request leaks Alice data to viewer and anonymous. Use the systematic authorization replay primitive and keep the replayed exchange IDs as evidence.',
      'Take exactly one tool action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'authz_replay') {
        errors.push(`expected authz_replay for systematic two-identity IDOR testing, observed ${call.name}`);
        return errors;
      }
      if (call.args.request_id !== 'req-user-123') {
        errors.push('expected request_id=req-user-123');
      }
      if (call.args.baselinePersona !== 'owner') {
        errors.push('expected baselinePersona=owner');
      }
      if (!asArray(call.args.personas).includes('viewer')) {
        errors.push('expected challenger personas to include viewer');
      }
      if (call.args.includeAnonymous !== true) {
        errors.push('expected includeAnonymous=true');
      }
      return errors;
    },
  },
  {
    id: 'depth-blind-ssrf-mints-oob-token',
    title: 'Blind SSRF validation mints an OOB callback token first',
    why: 'Catches the adoption gap where the agent fires a blind SSRF/RCE/XXE payload with no out-of-band canary, then wrongly concludes "not vulnerable" because the in-band response shows nothing.',
    tools: [OobTokenCreate, HttpPayload],
    prompt: [
      'You are the validation phase executor.',
      'Target: https://app.example.test/api/import',
      'The "source_url" parameter is a suspected blind SSRF: the server fetches the URL server-side, the HTTP response is always 200 with no reflected content, and no fetched data is returned to the client.',
      'You must prove the server-side request actually happens. There is no in-band signal, so you need an out-of-band callback you control before sending the payload.',
      'Take exactly one tool action for the next step.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'oob_token_create') {
        errors.push(`expected oob_token_create to mint a callback canary before a blind SSRF payload, observed ${call.name}`);
      }
      return errors;
    },
  },
  {
    id: 'depth-blind-callback-confirm-uses-oob-check',
    title: 'Confirming a blind hit uses oob_check_interactions',
    why: 'Verifies the agent closes the out-of-band loop by polling recorded interactions for its token instead of guessing from the unchanged in-band response.',
    tools: [OobCheckInteractions, OobTokenCreate, HttpPayload],
    prompt: [
      'You are the validation phase executor.',
      'You already minted OOB token "oob-tok-77" (callback host oob-tok-77.oast.example.test) and sent a blind SSRF payload pointing the target at that callback host.',
      'The in-band response was an unchanged 200. You now need to determine whether the target actually performed the out-of-band request.',
      'Take exactly one tool action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors = requireSingleTool(calls);
      const call = firstTool(calls);
      if (!call) return errors;
      if (call.name !== 'oob_check_interactions') {
        errors.push(`expected oob_check_interactions to confirm the blind callback, observed ${call.name}`);
        return errors;
      }
      if (!JSON.stringify(call.args).toLowerCase().includes('oob-tok-77')) {
        errors.push('expected oob_check_interactions to reference the minted token oob-tok-77');
      }
      return errors;
    },
  },
];
