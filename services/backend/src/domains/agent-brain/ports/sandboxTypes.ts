export type ExecOptions = {
  cmd: string;
  user?: 'root' | 'agent';
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string | Buffer;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ManagedShellJobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export type ManagedShellJobResult = {
  jobId: string;
  sessionId: string;
  command: string;
  status: ManagedShellJobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  commandFinished: boolean;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
  statusPath: string;
  pidPath: string;
  startedAt: string;
  completedAt?: string;
  nextCheckAfterMs?: number;
  bytesOut: number;
  bytesErr: number;
  timedOut?: boolean;
  cancelled?: boolean;
  cancellationReason?: string;
};

export type ManagedShellJobStartOptions = {
  waitBudgetMs?: number;
  hardTimeoutMs?: number;
  nextCheckAfterMs?: number;
  turnNumber?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ManagedShellJobCheckOptions = {
  waitBudgetMs?: number;
  turnNumber?: number;
  signal?: AbortSignal;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts?: {
    stdoutPath?: string;
    stderrPath?: string;
  };
  bytesOut: number;
  bytesErr: number;
  timedOut?: boolean;
  aborted?: boolean;
  abortReason?: string;
};

export type SandboxListEntry = {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  CreatedAt: string;
};

export interface SandboxStreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SandboxSidecarRequest {
  name: string;
  image: string;
  command: string[];
  env?: Record<string, string>;
  capabilityProfile?: string;
}

export type SandboxExecRequest = ExecOptions & {
  containerId?: string;
};

export type SandboxExecResult = ExecResult;
