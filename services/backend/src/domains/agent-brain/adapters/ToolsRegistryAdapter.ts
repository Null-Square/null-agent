import type { ToolExecutionOptions, ToolRegistryPort } from '../ports';

export class ToolsRegistryAdapter implements ToolRegistryPort {
  constructor(private readonly registry: ToolRegistryPort) { }

  async execute(
    toolId: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionOptions,
  ): Promise<unknown> {
    return this.registry.execute(toolId, args, {
      sessionId: ctx.sessionId,
      modelRequestId: ctx.modelRequestId,
      abortSignal: ctx.abortSignal,
      toolCallId: ctx.toolCallId,
      budget: ctx.budget,
      turnNumber: ctx.turnNumber,
      turnId: ctx.turnId,
      rawArgsJson: ctx.rawArgsJson,
      stream: ctx.stream,
      executeModelCall: ctx.executeModelCall,
    });
  }

  async executeWithReceipt(
    toolId: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionOptions,
  ) {
    return this.registry.executeWithReceipt(toolId, args, {
      sessionId: ctx.sessionId,
      modelRequestId: ctx.modelRequestId,
      abortSignal: ctx.abortSignal,
      toolCallId: ctx.toolCallId,
      budget: ctx.budget,
      turnNumber: ctx.turnNumber,
      turnId: ctx.turnId,
      rawArgsJson: ctx.rawArgsJson,
      stream: ctx.stream,
      executeModelCall: ctx.executeModelCall,
    });
  }

  getToolSchemas() {
    return this.registry.getToolSchemas();
  }

  getUnifiedPipelineCoverage() {
    const coverage = this.registry.getUnifiedPipelineCoverage;
    if (!coverage) {
      const executableToolIds = this.registry.getToolSchemas().map(({ name }) => name);
      return Promise.resolve({
        schema: 'tool-execution-pipeline/v1' as const,
        owner: 'ToolsRegistry.executeResolvedTool' as const,
        executableToolIds,
        uncoveredToolIds: executableToolIds,
      });
    }
    return coverage.call(this.registry);
  }

  // ToolRegistryPort passthroughs
  listManifests() {
    return (this.registry as ToolRegistryPort).listManifests();
  }

  getManifest(id: string) {
    return (this.registry as ToolRegistryPort).getManifest(id);
  }

  handleApprovalDecision(sessionId: string, actionId: string, status: 'granted' | 'denied', reason?: string) {
    return (this.registry as ToolRegistryPort).handleApprovalDecision(sessionId, actionId, status, reason);
  }

  getPendingApprovals(sessionId: string) {
    const reg = this.registry as ToolRegistryPort;
    if (reg.getPendingApprovals) {
      return reg.getPendingApprovals(sessionId);
    }
    return Promise.resolve([]);
  }
}
