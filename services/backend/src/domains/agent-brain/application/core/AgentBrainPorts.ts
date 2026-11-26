import type {
  ContextProviderPort,
  ToolRegistryPort,
  SandboxProvisioningPort,
  SandboxRuntimePort,
  TelemetryPort,
  SessionEventPublisher,
} from '../../ports';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';

export interface AgentBrainPorts {
  context: ContextProviderPort & { setTraceRecorder?(trace?: SessionTraceRecorder): void };
  tools: ToolRegistryPort;
  sandbox: {
    provision: SandboxProvisioningPort;
    runtime: SandboxRuntimePort;
  };
  telemetry?: TelemetryPort;
  events: SessionEventPublisher;
}
