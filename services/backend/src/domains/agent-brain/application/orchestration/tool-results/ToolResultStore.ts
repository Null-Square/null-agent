import {
  joinFsPath,
  writeTextFileEnsuringParent,
} from '../../../adapters/workspace/WorkspaceFsAdapter';
import { sha256Hex } from '@/shared/utils/hash';
import {
  defaultToolResultPolicy,
  type ToolResultPolicy,
} from './ToolResultPolicy';

const TOOL_RESULTS_SUBDIR = '.artifacts/tool-results';

export interface ToolResultProjectionInput {
  workspaceDir?: string;
  toolName: string;
  toolCallId: string;
  result: unknown;
  policy?: ToolResultPolicy;
}

export interface ToolResultProjectionStats {
  toolName: string;
  toolCallId: string;
  rawChars: number;
  promptChars: number;
  savedApproxTokens: number;
  persisted: boolean;
  artifactPath?: string;
  sha256?: string;
  policyVersion: string;
}

export interface ToolResultProjection {
  content: string;
  projectedResult: unknown;
  stats: ToolResultProjectionStats;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const safePrettyStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const tryParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const buildPersistedPromptResult = (input: {
  normalizedResult: unknown;
  toolName: string;
  artifactPath: string;
  rawChars: number;
  promptCharsBeforeEnvelope: number;
  sha256: string;
  savedApproxTokens: number;
  policyVersion: string;
}): unknown => {
  const artifact = {
    path: input.artifactPath,
    bytes: input.rawChars,
    sha256: input.sha256,
    contentType: 'application/json',
  };
  const policy = {
    reason: 'tool_result_policy',
    version: input.policyVersion,
    savedApproxTokens: input.savedApproxTokens,
    previewChars: input.promptCharsBeforeEnvelope,
  };

  if (isRecord(input.normalizedResult)) {
    return {
      ...input.normalizedResult,
      status: 'tool_result_persisted',
      tool: input.toolName,
      truncated: true,
      artifact,
      policy,
    };
  }

  return {
    status: 'tool_result_persisted',
    tool: input.toolName,
    preview: input.normalizedResult,
    truncated: true,
    artifact,
    policy,
  };
};

const buildGenericPreviewResult = (
  normalizedResult: unknown,
  maxChars: number,
): unknown => {
  const serialized = safeStringify(normalizedResult);
  if (serialized.length <= maxChars) {
    return normalizedResult;
  }
  const preview = `${serialized.slice(0, maxChars).trimEnd()}...[truncated by tool result policy]`;
  if (isRecord(normalizedResult)) {
    const ok = typeof normalizedResult.ok === 'boolean' ? normalizedResult.ok : undefined;
    return {
      ...(ok !== undefined ? { ok } : {}),
      preview,
      preview_truncated: true,
      original_chars: serialized.length,
    };
  }
  return {
    preview,
    preview_truncated: true,
    original_chars: serialized.length,
  };
};

export const projectToolResultForPrompt = async ({
  workspaceDir,
  toolName,
  toolCallId,
  result,
  policy = defaultToolResultPolicy,
}: ToolResultProjectionInput): Promise<ToolResultProjection> => {
  const config = policy.getConfig();
  const rawSerialized = safeStringify(result);
  const rawChars = rawSerialized.length;
  const rawSha256 = sha256Hex(rawSerialized);
  const normalization = policy.normalizeResult(toolName, result);
  const normalizedSerialized = safeStringify(normalization.result);
  const shouldPersist =
    Boolean(workspaceDir) &&
    (rawChars > config.persistThresholdChars || normalization.persistRecommended);

  if (!shouldPersist || !workspaceDir) {
    const savedApproxTokens = Math.max(
      normalization.rawCharsSavedByNormalization > 0
        ? Math.ceil(normalization.rawCharsSavedByNormalization / 4)
        : 0,
      0,
    );
    return {
      content: normalizedSerialized,
      projectedResult: normalization.result,
      stats: {
        toolName,
        toolCallId,
        rawChars,
        promptChars: normalizedSerialized.length,
        savedApproxTokens,
        persisted: false,
        policyVersion: policy.version,
      },
    };
  }

  const fileName = `${toolCallId}-${rawSha256.slice(0, 12)}.json`;
  const filePath = joinFsPath(workspaceDir, TOOL_RESULTS_SUBDIR, fileName);
  const workspacePath = `/workspace/${TOOL_RESULTS_SUBDIR}/${fileName}`;
  const artifactDoc = {
    schemaVersion: 1,
    toolName,
    toolCallId,
    createdAt: new Date().toISOString(),
    rawChars,
    rawApproxTokens: Math.ceil(rawChars / 4),
    sha256: rawSha256,
    policyVersion: policy.version,
    preview: normalization.result,
    rawResult: tryParseJson(rawSerialized),
  };
  await writeTextFileEnsuringParent(filePath, safePrettyStringify(artifactDoc));

  const promptPreviewResult = buildGenericPreviewResult(normalization.result, config.defaultPreviewChars);
  const promptPreviewSerialized = safeStringify(promptPreviewResult);
  const previewChars = promptPreviewSerialized.length;
  const savedApproxTokens = Math.max(0, Math.ceil((rawChars - previewChars) / 4));
  const promptResult = buildPersistedPromptResult({
    normalizedResult: promptPreviewResult,
    toolName,
    artifactPath: workspacePath,
    rawChars,
    promptCharsBeforeEnvelope: previewChars,
    sha256: rawSha256,
    savedApproxTokens,
    policyVersion: policy.version,
  });
  const content = safeStringify(promptResult);

  return {
    content,
    projectedResult: promptResult,
    stats: {
      toolName,
      toolCallId,
      rawChars,
      promptChars: content.length,
      savedApproxTokens,
      persisted: true,
      artifactPath: workspacePath,
      sha256: rawSha256,
      policyVersion: policy.version,
    },
  };
};
