import { ContextGateway } from '../adapters/context';
import type { ContextProviderPort } from '../ports';
import type { ContextBlocks, ContextRequest } from '../domain/types';
import type { SessionTraceRecorder } from '../infrastructure/telemetry';

export class ContextGatewayAdapter implements ContextProviderPort {
  private readonly gateway: ContextGateway;

  constructor(
    traceRecorder?: SessionTraceRecorder,
    gateway?: ContextGateway,
  ) {
    this.gateway = gateway ?? new ContextGateway(traceRecorder);
  }

  async getContext(request: ContextRequest): Promise<ContextBlocks> {
    const turn = request.turn ?? 1;
    return this.gateway.getContext(request.sessionId, turn, {
      extraContext: request.extraContext,
      taskBlocks: request.taskBlocks,
    });
  }

  async getShortRules(): Promise<ContextBlocks> {
    return this.gateway.getShortRulesHeader();
  }
}
