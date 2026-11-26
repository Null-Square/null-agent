import type { SessionTraceRecorder } from '../../infrastructure/telemetry';

const wrapSection = (title: string, content: string): string =>
  `## ${title}\n${content.trim()}`;

export interface ContextEnvelope {
  hard: string;
  soft?: string;
}

export interface ContextInput {
  extraContext?: string;
  taskBlocks?: string[];
}

export class ContextGateway {
  constructor(
    private readonly traceRecorder?: SessionTraceRecorder,
  ) { }

  async getContext(sessionId: string, turn: number, input: ContextInput): Promise<ContextEnvelope> {
    const taskBlocks = Array.isArray(input.taskBlocks)
      ? input.taskBlocks
        .map((block) => (typeof block === 'string' ? block.trim() : ''))
        .filter((block) => block.length > 0)
      : [];
    const softSections: string[] = [];
    if (taskBlocks.length > 0) {
      softSections.push(wrapSection('TASK CONTEXT', taskBlocks.join('\n\n')));
    }
    const soft = softSections.length > 0 ? softSections.join('\n\n') : undefined;

    return { hard: '', soft };
  }

  async getShortRulesHeader(): Promise<ContextEnvelope> {
    return { hard: '' };
  }
}
