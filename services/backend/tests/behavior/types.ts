import type { ToolImpl } from '../../src/domains/agent-brain/application/tools/runtime/Tool';

export type ObservedToolCall = {
  name: string;
  args: Record<string, unknown>;
  source: 'native' | 'xml';
};

export type BehaviorScenario = {
  id: string;
  title: string;
  why: string;
  tools: ToolImpl[];
  prompt: string;
  preflight?: () => string[];
  expect: (calls: ObservedToolCall[]) => string[];
};

export type ScenarioResult = {
  id: string;
  title: string;
  passed: boolean;
  dryRun: boolean;
  observedToolCalls: ObservedToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: string;
};
