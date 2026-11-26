export type {
  ExecOptions,
  ExecResult,
  ManagedShellJobCheckOptions,
  ManagedShellJobResult,
  ManagedShellJobStartOptions,
  ManagedShellJobStatus,
  SandboxListEntry,
  SandboxStreamCallbacks,
} from '../../ports/sandboxTypes';

export type NetworkMode = 'none' | 'bridge' | `container:${string}` | (string & {});

/**
 * Identifies teardown invoked from SessionStore's removal hook. That hook
 * already owns this session's lock, so sandbox cleanup must not persist a
 * container-id update through the same lock before the session is deleted.
 * Other sessions sharing the container still receive their normal updates.
 */
export type SandboxDestroyOptions = {
  sessionRemovalId?: string;
};

export type RuntimeBundleOwnership = {
  runId: string;
  admissionEpoch: number;
};

export type NamespaceAttachment =
  | NetworkMode
  | {
      shareWith: string;
    };

export type SandboxConfig = {
  image: string;
  workspaceHostDir: string;
  stdoutLimitBytes: number;
  killGraceMs: number;
  defaultNetwork: NetworkMode;
  readonlyRootfs: boolean;
  cpuQuota?: number;
  memoryMb?: number;
  pidsLimit?: number;
  seccompProfilePath?: string;
  capDrop?: string;
  user: 'agent' | 'root' | string;
  devUnsafe: boolean;
};
