export type SandboxHealth = {
  healthy: boolean;
  containerId: string;
  containerRunning: boolean;
  diskSpaceOk: boolean;
  lastCheckAt: number;
  errors: string[];
  uptimeMs?: number;
};

export interface SandboxHealthPort {
  check(containerId: string): Promise<SandboxHealth>;
}
