import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestServer } from '../unit/helpers/testAppHarness.helper';

vi.mock('@/db/client', () => ({
  db: {},
  checkDbHealth: vi.fn(async () => ({ ok: true, ms: 0 })),
}));

describe('HTTP contracts - health endpoints', () => {
  it('ready: returns 200 when dependencies are healthy', async () => {
    const { server, close } = createTestServer();
    try {
      const res = await request(server).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OK');
    } finally {
      await close();
    }
  });

  it('extended: returns 503 when sandbox list fails', async () => {
    const { server, close } = createTestServer({
      sandbox: { listSandboxes: vi.fn(async () => { throw new Error('boom'); }) } as any,
    });
    try {
      const res = await request(server).get('/health/extended');
      expect(res.status).toBe(503);
      expect(res.body.sandboxes).toBe('error');
    } finally {
      await close();
    }
  });
});






