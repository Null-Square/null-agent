import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import OpenAI from 'openai';
import path from 'path';

import { parseXmlToolCalls } from '../src/domains/agent-brain/application/orchestration/parsing/XmlToolCallParser';
import { asRecord } from '../tests/behavior/assertions';
import { scenarios } from '../tests/behavior/scenarios';
import type { BehaviorScenario, ObservedToolCall, ScenarioResult } from '../tests/behavior/types';

type BehaviorMode = 'model-choice' | 'assembled-runtime';

/**
 * Resolved the same way the sibling release scripts do.
 *
 * This was referenced when reading the model seed but never defined, so every
 * live run failed with "BACKEND_ROOT is not defined" while dry runs passed —
 * dry runs never reach model resolution, which is exactly why it went unnoticed.
 */
const BACKEND_ROOT = path.resolve(__dirname, '..');

type CliOptions = {
  mode: BehaviorMode;
  live: boolean;
  list: boolean;
  family: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  scenarioIds: string[];
  maxOutputTokens: number;
  output?: string;
};

type ModelSeed = {
  name?: string;
  provider: string;
  modelName: string;
  isDefault?: boolean;
  selectionPriority?: number;
  maxOutputTokens?: number;
  apiBaseUrl?: string;
  apiKeyEnv?: string;
};

const familyProviderAliases: Record<string, string> = {
  anthropic: 'ANTHROPIC',
  claude: 'ANTHROPIC',
  deepseel: 'DEEPSEEK',
  deepseek: 'DEEPSEEK',
  gpt: 'OPENAI',
  kimi: 'MOONSHOT',
  moonshot: 'MOONSHOT',
  openai: 'OPENAI',
  qwen: 'QWEN',
};

const modelApiKeyEnvByProvider: Record<string, string> = {
  ANTHROPIC: 'ANTHROPIC_API_KEY',
  DEEPSEEK: 'DEEPSEEK_API_KEY',
  MOONSHOT: 'MOONSHOT_API_KEY',
  OPENAI: 'OPENAI_API_KEY',
  QWEN: 'QWEN_API_KEY',
};

const c = {
  green: (value: string) => `\x1b[32m${value}\x1b[0m`,
  red: (value: string) => `\x1b[31m${value}\x1b[0m`,
  yellow: (value: string) => `\x1b[33m${value}\x1b[0m`,
  dim: (value: string) => `\x1b[2m${value}\x1b[0m`,
  bold: (value: string) => `\x1b[1m${value}\x1b[0m`,
};

const staticHarnessPrompt = [
  'You are a NULL-AI behavior canary, not a full pentest agent.',
  'This is a bounded one-turn model-in-the-loop smoke test.',
  'Use exactly one tool call for the next harness action, then stop.',
  'Do not solve the whole assessment. Do not write explanatory prose when a tool call is available.',
  'Do not invent evidence, hashes, findings, credentials, or completed validation.',
  'If native function calling is unavailable, output exactly one XML call in this format:',
  '<function=tool_name><parameter=name>value</parameter></function>',
].join('\n');

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    mode: process.env.BEHAVIOR_MODE?.trim() === 'assembled-runtime'
      ? 'assembled-runtime'
      : 'model-choice',
    live: false,
    list: false,
    family: process.env.BEHAVIOR_FAMILY?.trim().toLowerCase()
      || process.env.BEHAVIOR_PROVIDER?.trim().toLowerCase()
      || 'deepseek',
    model: process.env.BEHAVIOR_MODEL?.trim(),
    apiKey: process.env.BEHAVIOR_API_KEY?.trim(),
    baseUrl: process.env.BEHAVIOR_API_BASE_URL?.trim(),
    scenarioIds: (process.env.BEHAVIOR_SCENARIO ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    maxOutputTokens: Number(process.env.BEHAVIOR_MAX_OUTPUT_TOKENS ?? 1024),
    output: process.env.BEHAVIOR_OUTPUT?.trim(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--live':
        options.live = true;
        break;
      case '--assembled':
        options.mode = 'assembled-runtime';
        break;
      case '--mode':
        if (next !== 'model-choice' && next !== 'assembled-runtime') {
          throw new Error('--mode requires model-choice or assembled-runtime');
        }
        options.mode = next;
        index += 1;
        break;
      case '--dry-run':
        options.live = false;
        break;
      case '--list':
        options.list = true;
        break;
      case '--family':
        if (!next) throw new Error('--family requires a value');
        options.family = next.toLowerCase();
        index += 1;
        break;
      case '--provider':
        if (!next) throw new Error('--provider requires a value');
        options.family = next.toLowerCase();
        index += 1;
        break;
      case '--model':
        if (!next) throw new Error('--model requires a value');
        options.model = next;
        index += 1;
        break;
      case '--api-key':
        if (!next) throw new Error('--api-key requires a value');
        options.apiKey = next;
        index += 1;
        break;
      case '--base-url':
        if (!next) throw new Error('--base-url requires a value');
        options.baseUrl = next;
        index += 1;
        break;
      case '--scenario':
        if (!next) throw new Error('--scenario requires a value');
        options.scenarioIds.push(...next.split(',').map((entry) => entry.trim()).filter(Boolean));
        index += 1;
        break;
      case '--max-output-tokens':
        if (!next) throw new Error('--max-output-tokens requires a value');
        options.maxOutputTokens = Number(next);
        index += 1;
        break;
      case '--output':
        if (!next) throw new Error('--output requires a value');
        options.output = next;
        index += 1;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.maxOutputTokens) || options.maxOutputTokens < 64) {
    options.maxOutputTokens = 1024;
  }

  return options;
};

const printHelp = (): void => {
  console.log([
    'Manual model behavior smoke tests.',
    '',
    'Dry run, no model spend:',
    '  npm run test:behavior -w services/backend',
    '  npm run test:behavior:list -w services/backend',
    '  npm run test:behavior:assembled:run -w services/backend',
    '',
    'Live one-turn canaries:',
    '  npm run test:behavior:live -w services/backend',
    '  $env:BEHAVIOR_FAMILY="moonshot"; npm run test:behavior:live -w services/backend',
    '',
    'Useful options:',
    '  --list',
    '  --mode model-choice|assembled-runtime',
    '  --assembled',
    '  --family deepseek|gpt|claude|moonshot',
    '  --scenario validation-open-lead-without-visible-hash',
    '  --max-output-tokens 1024',
    '  --output tests/behavior/results/latest.json',
  ].join('\n'));
};

const makeOpenAiTool = (scenario: BehaviorScenario): OpenAI.Chat.ChatCompletionTool[] =>
  scenario.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.meta.name,
      description: tool.meta.description,
      parameters: tool.meta.schema,
    },
  }));

const makeAnthropicTool = (scenario: BehaviorScenario): Anthropic.Tool[] =>
  scenario.tools.map((tool) => ({
    name: tool.meta.name,
    description: tool.meta.description,
    input_schema: tool.meta.schema as Anthropic.Tool.InputSchema,
  }));

const resolveScenarios = (ids: string[]): BehaviorScenario[] => {
  if (ids.length === 0) return scenarios;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return ids.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(`Unknown scenario "${id}". Run with --list to see valid IDs.`);
    }
    return scenario;
  });
};

const validateToolSchemas = (scenario: BehaviorScenario): string[] => {
  const errors: string[] = [];
  for (const tool of scenario.tools) {
    if (!tool.meta.name) errors.push(`${scenario.id}: tool missing name`);
    if (!tool.meta.description) errors.push(`${scenario.id}: ${tool.meta.name} missing description`);
    if (!asRecord(tool.meta.schema).type) errors.push(`${scenario.id}: ${tool.meta.name} schema missing type`);
  }
  errors.push(...(scenario.preflight?.() ?? []));
  return errors;
};

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const loadModelSeeds = (): ModelSeed[] => {
  const seedPath = path.join(BACKEND_ROOT, 'config', 'seeds', 'models.seed.json');
  return JSON.parse(readFileSync(seedPath, 'utf8')) as ModelSeed[];
};

const resolveProviderFromFamily = (family: string): string => {
  const normalized = family.trim().toLowerCase();
  const provider = familyProviderAliases[normalized];
  if (!provider) {
    throw new Error(`Unknown behavior family "${family}". Use deepseek, gpt, claude, moonshot, or qwen.`);
  }
  return provider;
};

const pickModelSeed = (provider: string, modelOverride?: string): ModelSeed => {
  const seeds = loadModelSeeds().filter((seed) => seed.provider.toUpperCase() === provider);
  if (modelOverride) {
    return seeds.find((seed) => seed.modelName === modelOverride) ?? { provider, modelName: modelOverride };
  }

  const sorted = [...seeds].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return (left.selectionPriority ?? Number.MAX_SAFE_INTEGER) - (right.selectionPriority ?? Number.MAX_SAFE_INTEGER);
  });
  const selected = sorted[0];
  if (!selected) {
    throw new Error(`No seeded model found for behavior family provider ${provider}. Set BEHAVIOR_MODEL or pass --model.`);
  }
  return selected;
};

const resolveLiveConfig = (
  options: CliOptions,
): { family: string; provider: string; model: string; apiKey: string; baseUrl?: string } => {
  const provider = resolveProviderFromFamily(options.family);
  const seed = pickModelSeed(provider, options.model);
  const envKey = seed.apiKeyEnv ?? modelApiKeyEnvByProvider[provider] ?? `${provider}_API_KEY`;
  const apiKey = options.apiKey ?? process.env[envKey]?.trim();
  const model = seed.modelName;
  const baseUrl = options.baseUrl ?? seed.apiBaseUrl;
  if (!apiKey) {
    throw new Error(`Missing API key. Set BEHAVIOR_API_KEY or ${envKey}, or pass --api-key.`);
  }
  return { family: options.family, provider, model, apiKey, baseUrl };
};

const extractOpenAiToolCalls = (message: OpenAI.Chat.ChatCompletionMessage): ObservedToolCall[] => {
  const nativeCalls = (message.tool_calls ?? [])
    .filter((call) => call.type === 'function')
    .map((call): ObservedToolCall => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = { __rawArguments: call.function.arguments };
      }
      return {
        name: call.function.name,
        args,
        source: 'native',
      };
    });
  if (nativeCalls.length > 0) return nativeCalls;

  const content = typeof message.content === 'string' ? message.content : '';
  if (!content) return [];
  return parseXmlToolCalls(content).toolCalls.map((call): ObservedToolCall => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = { __rawArguments: call.function.arguments };
    }
    return {
      name: call.function.name,
      args,
      source: 'xml',
    };
  });
};

const extractAnthropicToolCalls = (message: Anthropic.Message): ObservedToolCall[] =>
  message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block): ObservedToolCall => ({
      name: block.name,
      args: asRecord(block.input),
      source: 'native',
    }));

const runOpenAiLiveScenario = async (
  client: OpenAI,
  liveConfig: { provider: string; model: string },
  scenario: BehaviorScenario,
  options: CliOptions,
): Promise<ScenarioResult> => {
  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: liveConfig.model,
    messages: [
      { role: 'system', content: staticHarnessPrompt },
      { role: 'user', content: scenario.prompt },
    ],
    tools: makeOpenAiTool(scenario),
    tool_choice: 'auto',
  };

  if (liveConfig.provider === 'OPENAI') {
    body.max_completion_tokens = options.maxOutputTokens;
  } else {
    body.max_tokens = options.maxOutputTokens;
  }

  const response = await client.chat.completions.create(body);
  const message = response.choices[0]?.message;
  const observedToolCalls = message ? extractOpenAiToolCalls(message) : [];
  const errors = scenario.expect(observedToolCalls);
  return {
    id: scenario.id,
    title: scenario.title,
    passed: errors.length === 0,
    dryRun: false,
    observedToolCalls,
    usage: {
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
    },
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
};

const runAnthropicLiveScenario = async (
  client: Anthropic,
  liveConfig: { model: string },
  scenario: BehaviorScenario,
  options: CliOptions,
): Promise<ScenarioResult> => {
  const response = await client.messages.create({
    model: liveConfig.model,
    max_tokens: options.maxOutputTokens,
    system: staticHarnessPrompt,
    messages: [
      { role: 'user', content: scenario.prompt },
    ],
    tools: makeAnthropicTool(scenario),
    tool_choice: { type: 'auto' },
  });
  const observedToolCalls = extractAnthropicToolCalls(response);
  const errors = scenario.expect(observedToolCalls);
  return {
    id: scenario.id,
    title: scenario.title,
    passed: errors.length === 0,
    dryRun: false,
    observedToolCalls,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    },
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
};

const runLiveScenario = async (
  client: OpenAI | Anthropic,
  liveConfig: { provider: string; model: string },
  scenario: BehaviorScenario,
  options: CliOptions,
): Promise<ScenarioResult> => {
  if (liveConfig.provider === 'ANTHROPIC') {
    return runAnthropicLiveScenario(client as Anthropic, liveConfig, scenario, options);
  }
  return runOpenAiLiveScenario(client as OpenAI, liveConfig, scenario, options);
};

const runDryScenario = (scenario: BehaviorScenario): ScenarioResult => {
  const schemaErrors = validateToolSchemas(scenario);
  return {
    id: scenario.id,
    title: scenario.title,
    passed: schemaErrors.length === 0,
    dryRun: true,
    observedToolCalls: [],
    usage: {
      promptTokens: estimateTokens(staticHarnessPrompt) + estimateTokens(scenario.prompt),
    },
    ...(schemaErrors.length > 0 ? { error: schemaErrors.join('; ') } : {}),
  };
};

const printScenarioList = (): void => {
  for (const scenario of scenarios) {
    console.log(`${c.bold(scenario.id)}\n  ${scenario.title}\n  ${c.dim(scenario.why)}\n`);
  }
};

const printResult = (result: ScenarioResult): void => {
  const status = result.passed ? c.green('PASS') : c.red('FAIL');
  const mode = result.dryRun ? c.dim('dry') : 'live';
  console.log(`${status} ${c.bold(result.id)} ${c.dim(`(${mode})`)}`);
  if (result.observedToolCalls.length > 0) {
    for (const call of result.observedToolCalls) {
      console.log(`  tool: ${call.name} ${c.dim(call.source)} ${JSON.stringify(call.args)}`);
    }
  }
  if (result.usage?.totalTokens || result.usage?.promptTokens) {
    console.log(`  tokens: ${JSON.stringify(result.usage)}`);
  }
  if (result.error) {
    console.log(`  ${c.red(result.error)}`);
  }
};

const writeResults = (outputPath: string, results: unknown[]): void => {
  const absolutePath = path.resolve(process.cwd(), outputPath);
  const dir = path.dirname(absolutePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    absolutePath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      results,
    }, null, 2)}\n`,
    'utf8',
  );
  console.log(c.dim(`wrote ${absolutePath}`));
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === 'assembled-runtime') {
    // Assembled scenarios are deterministic by default. A scenario that owns a live probe
    // reads this flag and opts in; nothing else in the suite changes behaviour.
    if (options.live) process.env.BEHAVIOR_LIVE = '1';
    const { assembledScenarios } = await import('../tests/behavior/assembled');
    const selected = options.scenarioIds.length === 0
      ? assembledScenarios
      : options.scenarioIds.map((id) => {
        const scenario = assembledScenarios.find((candidate) => candidate.id === id);
        if (!scenario) {
          throw new Error(`Unknown assembled scenario "${id}". Run with --assembled --list to see valid IDs.`);
        }
        return scenario;
      });

    if (options.list) {
      for (const scenario of selected) {
        console.log(`${c.bold(scenario.id)}\n  ${scenario.title}\n  ${c.dim(scenario.why)}\n`);
      }
      return;
    }

    console.log(c.bold('NULL-AI behavior smoke'));
    console.log(options.live
      ? c.yellow('assembled-runtime mode; live probes enabled where a scenario declares one')
      : c.dim('assembled-runtime mode; deterministic provider; no model spend'));
    const results = [];
    for (const scenario of selected) {
      const result = await scenario.run();
      results.push(result);
      const status = result.passed ? c.green('PASS') : c.red('FAIL');
      console.log(`${status} ${c.bold(result.id)} ${c.dim('(assembled-runtime)')}`);
      console.log(`  corrected=${result.evidence.verdict.correctedFixturePassed} negativeControlDetected=${result.evidence.verdict.negativeControlDetected}`);
      if (result.evidence.verdict.namedMismatches.length > 0) {
        console.log(`  negative-control mismatches: ${result.evidence.verdict.namedMismatches.join(', ')}`);
      }
      if (result.error) console.log(`  ${c.red(result.error)}`);
    }

    writeResults(
      options.output ?? path.join('tests', 'behavior', 'results', 'assembled-latest.json'),
      results,
    );
    if (results.some((result) => !result.passed)) process.exitCode = 1;
    return;
  }

  if (options.list) {
    printScenarioList();
    return;
  }

  const selected = resolveScenarios(options.scenarioIds);
  console.log(c.bold('NULL-AI behavior smoke'));
  console.log(options.live ? c.yellow('live model calls enabled') : c.dim('dry run only; pass --live to call a model'));
  console.log(c.dim(`scenarios: ${selected.map((scenario) => scenario.id).join(', ')}`));

  let client: OpenAI | Anthropic | undefined;
  let liveConfig: { family: string; provider: string; model: string; apiKey: string; baseUrl?: string } | undefined;
  if (options.live) {
    liveConfig = resolveLiveConfig(options);
    client = liveConfig.provider === 'ANTHROPIC'
      ? new Anthropic({
        apiKey: liveConfig.apiKey,
        ...(liveConfig.baseUrl ? { baseURL: liveConfig.baseUrl } : {}),
      })
      : new OpenAI({
        apiKey: liveConfig.apiKey,
        ...(liveConfig.baseUrl ? { baseURL: liveConfig.baseUrl } : {}),
      });
    console.log(c.dim(`family=${liveConfig.family} provider=${liveConfig.provider} model=${liveConfig.model}`));
  }

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const result = options.live && client && liveConfig
      ? await runLiveScenario(client, liveConfig, scenario, options)
      : runDryScenario(scenario);
    results.push(result);
    printResult(result);
  }

  if (options.output) {
    writeResults(options.output, results);
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(c.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
