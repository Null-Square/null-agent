type KillHook = () => Promise<void> | void;
import { logger } from '@/shared/logger';

export class AbortGate {
  readonly controller = new AbortController();
  private readonly hooks: KillHook[] = [];
  private readonly log = logger.child({ scope: 'AbortGate' });

  onKill(hook: KillHook): void {
    this.hooks.push(hook);
  }

  async abort(reason?: string): Promise<void> {
    if (!this.controller.signal.aborted) {
      (this.controller as AbortController).abort(reason);
    }
    for (const hook of this.hooks) {
      try {
        await hook();
      } catch (error) {
        this.log.warn({ err: error }, 'Abort hook failed');
      }
    }
  }
}
