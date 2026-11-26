import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkService } from '@/domains/agent-brain/adapters/sandbox';

describe('NetworkService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok true with ip from stdout', async () => {
    const docker = {
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '1.2.3.4\nextra',
        stderr: '',
        bytesOut: 0,
        bytesErr: 0,
      }),
    };
    const service = new NetworkService({ docker } as any);

    const result = await service.egressCheck('c-1');

    expect(docker.exec).toHaveBeenCalledWith('c-1', {
      cmd: 'curl -s --max-time 5 https://ifconfig.io || wget -qO- --timeout=5 https://ifconfig.io || true',
      timeoutMs: 6_000,
    });
    expect(result).toEqual({ ok: true, ip: '1.2.3.4' });
  });

  it('no-ops attach calls', async () => {
    const docker = { exec: vi.fn() };
    const service = new NetworkService({ docker } as any);

    await expect(service.attach('c-1', { pid: 123 } as any)).resolves.toBeUndefined();

    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('returns ok false when no ip is detected', async () => {
    const docker = {
      exec: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
        bytesOut: 0,
        bytesErr: 0,
      }),
    };
    const service = new NetworkService({ docker } as any);

    const result = await service.egressCheck('c-2');

    expect(result).toEqual({ ok: false });
  });

  it('returns ok false when exec throws', async () => {
    const docker = {
      exec: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const service = new NetworkService({ docker } as any);

    const result = await service.egressCheck('c-3');

    expect(result).toEqual({ ok: false });
  });
});
