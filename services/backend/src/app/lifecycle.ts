type Cleanup = () => Promise<void> | void;
import { logger } from '@/shared/logger';

export class LifecycleManager {
  private readonly cleanupFns: Cleanup[] = [];
  private readonly intervalFns: Array<() => void> = [];

  track(cleanup: Cleanup): void {
    this.cleanupFns.push(cleanup);
  }

  trackInterval(timer: NodeJS.Timeout): void {
    timer.unref?.();
    this.intervalFns.push(() => clearInterval(timer));
  }

  async dispose(): Promise<void> {
    this.intervalFns.splice(0).forEach((stop) => stop());
    for (const fn of this.cleanupFns.splice(0)) {
      try {
        await fn();
      } catch (error) {
        logger.warn({ err: error }, '[LifecycleManager] cleanup failed');
      }
    }
  }
}
