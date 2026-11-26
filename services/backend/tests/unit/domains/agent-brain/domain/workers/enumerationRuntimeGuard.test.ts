import { describe, expect, it } from 'vitest';

import type { SessionState } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';
import {
  assessEnumerationWorkerToolUse,
  getEnumerationWorkerUrlBlockReason,
} from '@/domains/agent-brain/domain/workers/enumerationRuntimeGuard';

const buildSession = (): SessionState => ({
  id: 'worker-session',
  userId: 'user',
  profileKey: 'executor',
  messages: [],
  plan: [],
  memory: createEmptyMemory(),
  flags: {},
  status: 'idle',
  mode: 'automated',
  agentType: 'executor',
  createdAt: Date.now(),
  lastActive: Date.now(),
  turn: 0,
  checkpoints: {},
  workspaceDir: '/workspace',
  coordination: {
    role: 'worker',
    workerType: 'enumeration_worker',
    maxTargetRequests: 5,
    targetRequestsUsed: 0,
    maxRequestConcurrency: 2,
    activeTargetRequests: 0,
    deadlineAt: Date.now() + 60_000,
  },
  task: {
    id: 'task',
    title: 'bounded enumeration',
    vars: {
      mission: {
        enumeration: {
          kind: 'enumeration_hunt_v1',
          targetRef: 'https://app.example.com',
          surface: { kind: 'path_prefix_set', refs: ['/api'] },
        },
      },
    },
  },
});

describe('enumeration worker runtime guard', () => {
  it('meters scoped requests and blocks foreign target/surface URLs', () => {
    const session = buildSession();
    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://app.example.com/api/users',
      method: 'GET',
    })).toMatchObject({ requestCost: 1, requestConcurrency: 1 });
    expect(getEnumerationWorkerUrlBlockReason(
      session,
      'https://other.example.com/api/users',
    )).toMatch(/target_scope_denied/u);
    expect(getEnumerationWorkerUrlBlockReason(
      session,
      'https://app.example.com/admin',
    )).toMatch(/surface_scope_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'http_raw_send', {
      url: 'https://app.example.com',
      raw_request: 'GET /admin HTTP/1.1\r\nHost: app.example.com\r\n\r\n',
    }).blockedReason).toMatch(/surface_scope_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'http_raw_send', {
      url: 'https://app.example.com',
      raw_request: 'GET /api/users HTTP/1.1\r\nHost: other.example.com\r\n\r\n',
    }).blockedReason).toMatch(/target_scope_denied/u);
  });

  it('fails closed on state changes and unmetered network paths', () => {
    const session = buildSession();
    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://app.example.com/api/users',
      method: 'POST',
    }).blockedReason).toMatch(/state_change_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'http_raw_send', {
      url: 'https://app.example.com/api/users',
      raw_request_base64: 'UE9TVCAv',
    }).blockedReason).toMatch(/opaque_raw_request_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'shell_run', {
      command: 'curl https://app.example.com/api/users',
    }).blockedReason).toMatch(/unmetered_network_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'shell_run', {
      command: 'python -c "import socket"',
    }).blockedReason).toMatch(/approved local parser/u);
    expect(assessEnumerationWorkerToolUse(session, 'shell_run', {
      command: 'jq . evidence.json | rg admin',
    }).blockedReason).toBeUndefined();
    expect(assessEnumerationWorkerToolUse(session, 'python_session', {
      action: 'replay',
      exchange_id: 'exchange-1',
    }).blockedReason).toMatch(/unmetered_network_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'python_session', {
      action: 'exec',
      code: '__import__("socket").socket().connect(("app.example.com", 443))',
    }).blockedReason).toMatch(/unmetered_network_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'browser_action', {
      action: 'submit',
    }).blockedReason).toMatch(/browser_state_change_denied/u);
  });

  it('allows scoped interactive discovery and reversible request methods under bounded PoC', () => {
    const session = buildSession();
    session.flags = {
      securityops: {
        enumerationImpactTolerance: 'poc',
      },
    };

    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://app.example.com/api/signup',
      method: 'POST',
    }).blockedReason).toBeUndefined();
    expect(assessEnumerationWorkerToolUse(session, 'browser_action', {
      action: 'submit',
    }).blockedReason).toBeUndefined();
    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://app.example.com/api/users/1',
      method: 'DELETE',
    }).blockedReason).toMatch(/state_change_denied/u);
    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://other.example.com/api/signup',
      method: 'POST',
    }).blockedReason).toMatch(/target_scope_denied/u);
  });

  it('enforces request and concurrency budgets', () => {
    const session = buildSession();
    session.coordination!.targetRequestsUsed = 5;
    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://app.example.com/api/users',
    }).blockedReason).toMatch(/request_budget_exhausted/u);
    session.coordination!.targetRequestsUsed = 0;
    session.coordination!.activeTargetRequests = 2;
    expect(assessEnumerationWorkerToolUse(session, 'http_payload', {
      url: 'https://app.example.com/api/users',
    }).blockedReason).toMatch(/request_concurrency_denied/u);
  });

  it('does not expose connected repository tools to Pentest enumeration workers', () => {
    const session = buildSession();
    session.flags = {
      securityops: {
        workflowDiscipline: 'pentest',
      },
    };

    for (const toolName of [
      'list_connected_repositories',
      'search_connected_repository',
      'read_connected_repository_file',
    ]) {
      expect(
        assessEnumerationWorkerToolUse(session, toolName, {}).blockedReason,
      ).toMatch(/mission_scope_missing|repository_scope_denied/u);
    }
  });
});
