import type { SessionState } from '../../domain/types';
import { type ContainerLifecycleManager } from './ContainerLifecycleManager';
import { type SidecarManager } from './SidecarManager';
import type { SandboxDestroyOptions, SandboxListEntry } from './types';

export class SandboxLifecycle {
  constructor(
    private readonly containerManager: ContainerLifecycleManager,
    private readonly sidecarManager: SidecarManager,
    private readonly sandboxMode: 'docker',
  ) { }

  private ensureDocker(): void {
    if (this.sandboxMode !== 'docker') {
      throw new Error('sandbox_docker_required');
    }
  }

  async ensureContainer(session: SessionState): Promise<void> {
    this.ensureDocker();
    await this.containerManager.createContainer(session);
    if (!session.containerId) {
      throw new Error(`Session ${session.id} does not have an active container.`);
    }
    this.containerManager.markSessionActive(session.id);
  }

  markSessionActive(sessionId: string): void {
    this.containerManager.markSessionActive(sessionId);
  }

  async destroy(
    session: SessionState,
    options: SandboxDestroyOptions = {},
  ): Promise<void> {
    this.ensureDocker();
    await this.sidecarManager.stopSidecars(session.id);
    await this.containerManager.destroyContainer(session, options);
  }

  async list(): Promise<SandboxListEntry[]> {
    this.ensureDocker();
    return this.containerManager.listActiveContainers();
  }

  async restart(containerId: string): Promise<void> {
    this.ensureDocker();
    await this.containerManager.restartContainer(containerId);
  }

  async pause(containerId: string): Promise<void> {
    this.ensureDocker();
    await this.containerManager.pauseContainer(containerId);
  }

  async unpause(containerId: string): Promise<void> {
    this.ensureDocker();
    await this.containerManager.unpauseContainer(containerId);
  }

  async stop(containerId: string): Promise<void> {
    this.ensureDocker();
    await this.containerManager.stopContainer(containerId);
  }

  async stopSidecars(sessionId: string, containerId?: string): Promise<void> {
    await this.sidecarManager.stopSidecars(sessionId, containerId);
  }
}
