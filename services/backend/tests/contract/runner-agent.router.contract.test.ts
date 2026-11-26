import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRunnerAgentRouter } from '@/interfaces/http/controllers/runner-agent.router';

describe('runner-agent.router contract', () => {
  it('returns upgrade required for HTTP connect requests', async () => {
    const app = express();
    app.use('/api/app/runner-agent', createRunnerAgentRouter());

    const response = await request(app).get('/api/app/runner-agent/connect');

    expect(response.status).toBe(426);
    expect(response.body?.error?.code ?? response.body?.code).toBeDefined();
  });

  it('does not expose legacy poll endpoints', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/runner-agent', createRunnerAgentRouter());

    const pollResponse = await request(app).get('/api/app/runner-agent/poll');
    const heartbeatResponse = await request(app)
      .post('/api/app/runner-agent/heartbeat')
      .send({});
    const resultResponse = await request(app)
      .post('/api/app/runner-agent/result')
      .send({});

    expect(pollResponse.status).toBe(404);
    expect(heartbeatResponse.status).toBe(404);
    expect(resultResponse.status).toBe(404);
  });
});
