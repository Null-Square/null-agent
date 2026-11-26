import { type DockerDriver } from './DockerDriver';
import type { NamespaceAttachment } from './types';
import { logger } from '@/shared/logger';

export type NetworkDependencies = {
  docker: DockerDriver;
};

export class NetworkService {
  constructor(private readonly deps: NetworkDependencies) {}

  async attach(_containerId: string, _namespace: NamespaceAttachment): Promise<void> {
    // Network attachment semantics will be implemented alongside namespace sharing work.
    return Promise.resolve();
  }

  async egressCheck(containerId: string): Promise<{ ip?: string; ok: boolean }> {
    try {
      const result = await this.deps.docker.exec(containerId, {
        cmd: 'curl -s --max-time 5 https://ifconfig.io || wget -qO- --timeout=5 https://ifconfig.io || true',
        timeoutMs: 6_000,
      });

      const output = result.stdout?.trim();
      if (result.exitCode === 0 && output) {
        const ip = output.split('\n')[0]?.trim();
        return { ok: true, ip };
      }

      return { ok: false };
    } catch (error) {
      logger.warn({ err: error, containerId }, 'NetworkService.egressCheck failed');
      return { ok: false };
    }
  }
}
