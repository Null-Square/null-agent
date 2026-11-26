import type { SessionState } from '../domain/types';
import type { SandboxExecRequest, SandboxExecResult, SandboxSidecarRequest } from './sandboxTypes';

export interface SandboxRuntimePort {
  exec(session: SessionState, request: SandboxExecRequest): Promise<SandboxExecResult>;
  runSidecar?(session: SessionState, request: SandboxSidecarRequest): Promise<{ containerId: string }>;
  stopSidecars?(sessionId: string, sidecarId?: string): Promise<void>;
  writeFile?(session: SessionState, path: string, contents: string | Buffer): Promise<void>;
  readFile?(session: SessionState, path: string): Promise<Buffer>;
  stop?(session: SessionState | string, reason?: string): Promise<void>;
}
