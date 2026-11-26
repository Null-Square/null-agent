import { type SandboxAdapter } from '../adapters/sandbox';
import type { SessionState } from '../domain/types';
import type {
  SandboxProvisioningPort,
  SandboxRuntimePort,
  SandboxSidecarRequest,
  SandboxExecRequest,
  SandboxExecResult,
} from '../ports';

export class SandboxManagerAdapter
  implements SandboxProvisioningPort, SandboxRuntimePort
{
  constructor(private readonly manager: SandboxAdapter) {}

  async create(session: SessionState): Promise<void> {
    await this.manager.create(session);
  }

  async stop(session: SessionState, reason?: string): Promise<void> {
    await this.manager.stop(session, reason);
  }

  async destroy(session: SessionState): Promise<void> {
    await this.manager.destroy(session);
  }

  async getPolicy(sessionId: string) {
    return this.manager.getAppliedPolicy(sessionId);
  }

  async exec(session: SessionState, request: SandboxExecRequest): Promise<SandboxExecResult> {
    return this.manager.exec({
      ...request,
      session,
    });
  }

  async runSidecar(session: SessionState, request: SandboxSidecarRequest) {
    return this.manager.runSidecar({
      session,
      name: request.name,
      image: request.image,
      command: request.command,
      env: request.env,
      capabilityProfile: request.capabilityProfile,
    });
  }

  async stopSidecars(sessionId: string, sidecarId?: string): Promise<void> {
    await this.manager.stopSidecars(sessionId, sidecarId);
  }

  async writeFile(session: SessionState, path: string, contents: string | Buffer): Promise<void> {
    await this.manager.writeFile(session, path, contents);
  }

  async readFile(session: SessionState, path: string): Promise<Buffer> {
    return this.manager.readFile(session, path);
  }
}

