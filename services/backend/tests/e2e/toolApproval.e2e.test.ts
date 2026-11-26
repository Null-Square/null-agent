import { describe, it, expect } from 'vitest';
import request from 'supertest';

const API_BASE = process.env.E2E_API_BASE || 'http://localhost:3001';
const API_KEY = process.env.E2E_API_KEY || 'test-api-key';
const INTERNAL_TOKEN = process.env.E2E_INTERNAL_TOKEN;

const skipUnlessE2E = () => !process.env.RUN_E2E_TESTS;

const buildAuthHeaders = (): Record<string, string> =>
  INTERNAL_TOKEN
    ? { 'x-agent-internal-token': INTERNAL_TOKEN }
    : { Authorization: `Bearer ${API_KEY}` };

type ApprovalDTO = {
  actionId?: string;
};

describe('E2E: Tool Approval', () => {
  const sessionId = process.env.E2E_APPROVAL_SESSION_ID;
  const actionId = process.env.E2E_APPROVAL_ACTION_ID;

  it('approves a pending tool action when provided', async () => {
    if (skipUnlessE2E() || !sessionId || !actionId) return;

    const approvalsRes = await request(API_BASE)
      .get(`/api/ai-agent/sessions/${sessionId}/approvals`)
      .set(buildAuthHeaders())
      .expect(200);

    const approval = approvalsRes.body.approval as ApprovalDTO | null | undefined;
    if (!approval || approval.actionId !== actionId) {
      return;
    }

    const approveRes = await request(API_BASE)
      .post(`/api/ai-agent/sessions/${sessionId}/approve`)
      .set(buildAuthHeaders())
      .send({ actionId })
      .expect(200);

    expect(approveRes.body.actionId).toBe(actionId);
  });
});
