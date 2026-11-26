import type { SessionState } from '../../../domain/types';
import type { ExecResult, SandboxStreamCallbacks } from '../types';
import { type ExecService } from '../ExecService';
import type { ResolvedConfig } from '@/config/configTypes';

export interface ExecutionStrategy {
    execute(
        session: SessionState,
        command: string,
        callbacks: SandboxStreamCallbacks,
        timeoutMs: number,
        signal?: AbortSignal,
        containerId?: string,
    ): Promise<ExecResult>;
}

export class DockerExecutionStrategy implements ExecutionStrategy {
    constructor(private readonly execService: ExecService, private readonly config?: ResolvedConfig) { }

    async execute(
        session: SessionState,
        command: string,
        callbacks: SandboxStreamCallbacks,
        timeoutMs: number,
        signal?: AbortSignal,
        containerId?: string,
    ): Promise<ExecResult> {
        if (!containerId) {
            throw new Error('DockerExecutionStrategy requires a containerId');
        }

        return this.execService.run({
            session,
            containerId,
            cmd: command,
            timeoutMs,
            signal,
            onStdout: callbacks.onStdout,
            onStderr: callbacks.onStderr,
        });
    }
}
