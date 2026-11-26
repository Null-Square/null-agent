import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { approvalsRouter } from '@/interfaces/http/controllers/ai-agent/routes/approvals.router';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware';
import { ERROR_CODES } from '@null-ai/contracts';

const buildServices = (session: any) => {
  const services: any = {
    sessionStore: {
      get: vi.fn(() => session),
      getJournalProjection: vi.fn().mockResolvedValue(undefined),
    },
    ports: {
      tools: {
        handleApprovalDecision: vi.fn().mockResolvedValue({ handled: true, needsResume: false }),
      },
      events: {
        emit: vi.fn(),
      },
    },
    orchestrator: {
      processMessage: vi.fn().mockResolvedValue(undefined),
      handleApprovalResume: vi.fn().mockResolvedValue(undefined),
    },
  };
  return services;
};

const buildApp = (services: any, userId: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: userId };
    next();
  });
  app.use(approvalsRouter(services));
  app.use(errorHandler);
  return app;
};

describe('approvals.router contract', () => {
  it('returns 404 for missing session', async () => {
    const services = buildServices(undefined);
    const app = buildApp(services, 'u1');

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.SESSION_NOT_FOUND);
  });

  it('returns 403 when user does not own the session', async () => {
    const services = buildServices({ id: 's1', userId: 'owner', pendingApproval: undefined });
    const app = buildApp(services, 'other');

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });

  it('approves when owned and emits event', async () => {
    const session = {
      id: 's1',
      userId: 'owner',
      pendingApproval: { actionId: 'a1', tool: 'run_command', toolCallId: 'a1' },
    };
    const services = buildServices(session);
    const app = buildApp(services, 'owner');

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(200);
    expect(services.ports.events.emit).toHaveBeenCalledWith('s1', {
      type: 'approval_granted',
      data: { actionId: 'a1' },
    });
  });

  it('is idempotent on approve with Idempotency-Key and avoids duplicate handling', async () => {
    const session = {
      id: 's1',
      userId: 'owner',
      pendingApproval: { actionId: 'a1', tool: 'run_command', toolCallId: 'a1' },
    };
    const services = buildServices(session);
    const app = buildApp(services, 'owner');

    const headers = { 'Idempotency-Key': 'key-1' };

    const first = await request(app)
      .post('/sessions/s1/approve')
      .set(headers)
      .send({ actionId: 'a1' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/sessions/s1/approve')
      .set(headers)
      .send({ actionId: 'a1' });
    expect(second.status).toBe(200);

    // handleApprovalDecision should only run once
    expect(services.ports.tools.handleApprovalDecision).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for stale actionId when not handled anywhere', async () => {
    const session = { id: 's1', userId: 'owner', pendingApproval: undefined };
    const services = buildServices(session);
    services.ports.tools.handleApprovalDecision = vi.fn().mockResolvedValue({ handled: false, needsResume: false });
    const app = buildApp(services, 'owner');

    const res = await request(app)
      .post('/sessions/s1/approve')
      .send({ actionId: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('resumes approvals via handleApprovalResume when tool metadata exists', async () => {
    const session = {
      id: 's1',
      userId: 'owner',
      pendingApproval: {
        actionId: 'a1',
        toolCallId: 'call-1',
        tool: 'run_command',
        args: { cmd: 'ls' },
      },
    };
    const services = buildServices(session);
    services.ports.tools.handleApprovalDecision.mockResolvedValue({ handled: true, needsResume: true });
    const app = buildApp(services, 'owner');

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(200);
    expect(services.orchestrator.handleApprovalResume).toHaveBeenCalledWith('s1', {
      actionId: 'a1',
      toolCallId: 'call-1',
      toolName: 'run_command',
      args: { cmd: 'ls' },
    });
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
  });

  it('lets the durable journal worker own granted approval continuation', async () => {
    const session = {
      id: 's1',
      userId: 'owner',
      pendingApproval: {
        actionId: 'a1',
        toolCallId: 'call-1',
        tool: 'run_command',
        args: { cmd: 'ls' },
      },
    };
    const services = buildServices(session);
    services.ports.tools.handleApprovalDecision.mockResolvedValue({ handled: true, needsResume: true });
    services.sessionStore.getJournalProjection.mockResolvedValue({ desiredExecution: 'running' });
    const app = buildApp(services, 'owner');

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actionId: 'a1', resumed: true, scheduled: true });
    expect(services.orchestrator.handleApprovalResume).not.toHaveBeenCalled();
    expect(services.orchestrator.processMessage).not.toHaveBeenCalled();
  });

  it('falls back to processMessage when approval resume metadata is missing', async () => {
    const session = { id: 's1', userId: 'owner', pendingApproval: { actionId: 'a1', tool: 'run_command' } };
    const services = buildServices(session);
    services.ports.tools.handleApprovalDecision.mockResolvedValue({ handled: true, needsResume: true });
    const app = buildApp(services, 'owner');

    const res = await request(app).post('/sessions/s1/approve').send({ actionId: 'a1' });

    expect(res.status).toBe(200);
    expect(services.orchestrator.processMessage).toHaveBeenCalledWith('s1', 'continue');
  });

  it('denies approvals and emits an event with a reason', async () => {
    const session = {
      id: 's1',
      userId: 'owner',
      pendingApproval: { actionId: 'a1', tool: 'run_command', toolCallId: 'a1' },
    };
    const services = buildServices(session);
    const app = buildApp(services, 'owner');

    const res = await request(app)
      .post('/sessions/s1/deny')
      .send({ actionId: 'a1', reason: 'nope' });

    expect(res.status).toBe(200);
    expect(services.ports.tools.handleApprovalDecision).toHaveBeenCalledWith('s1', 'a1', 'denied', 'nope');
    expect(services.ports.events.emit).toHaveBeenCalledWith('s1', {
      type: 'approval_denied',
      data: { actionId: 'a1', reason: 'nope' },
    });
  });
});







