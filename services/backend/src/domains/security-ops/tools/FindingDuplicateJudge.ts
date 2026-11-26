import type OpenAI from 'openai';

import type { TurnExecutorPort } from '@/domains/agent-brain/ports';
import { logger } from '@/shared/logger';

export type FindingDuplicateReport = {
  id?: string;
  title?: string;
  description?: string;
  impact?: string;
  target?: string;
  technicalAnalysis?: string;
  pocDescription?: string;
  endpoint?: string;
  method?: string;
};

export type FindingDuplicateDecision = {
  isDuplicate: boolean;
  duplicateId: string;
  confidence: number;
  reason: string;
  error?: string;
};

export interface FindingDuplicateJudge {
  checkDuplicate(
    candidate: FindingDuplicateReport,
    existingReports: FindingDuplicateReport[],
    runtime?: {
      sessionId: string;
      turnNumber: number;
      abortSignal: AbortSignal;
      executeModelCall: NonNullable<TurnExecutorPort['executeModelCall']>;
    },
  ): Promise<FindingDuplicateDecision>;
}

const DEDUPE_TIMEOUT_MS = 120_000;
const DEDUPE_MAX_OUTPUT_TOKENS = 800;
const MAX_FIELD_LENGTH = 8_000;

const DEDUPE_SYSTEM_PROMPT = `You are an expert vulnerability report deduplication judge.
Your task is to determine if a candidate vulnerability report describes the SAME vulnerability
as any existing report.

CRITICAL DEDUPLICATION RULES:

1. SAME VULNERABILITY means:
   - Same root cause
   - Same affected component, endpoint, or file
   - Same exploitation method or attack vector
   - Would be fixed by the same code change or patch

2. NOT DUPLICATES if:
   - Different endpoints even with same vulnerability type
   - Different parameters in the same endpoint
   - Different root causes
   - Different severity due to materially different impact
   - One is authenticated and the other is unauthenticated

3. ARE DUPLICATES even if:
   - Titles are worded differently
   - Descriptions have different detail levels
   - PoC uses different payloads but exploits the same issue
   - One report is more thorough than another
   - Technical analysis wording differs

COMPARISON GUIDELINES:
- Focus on technical root cause, not surface-level similarity
- Same vulnerability class does not imply duplicate
- Consider the fix: would fixing one also fix the other?
- When uncertain, lean towards NOT duplicate

FIELDS TO ANALYZE:
- title, description
- target, endpoint, method
- technicalAnalysis
- pocDescription
- impact

YOU MUST RESPOND WITH EXACTLY THIS XML FORMAT AND NOTHING ELSE:

<dedupe_result>
<is_duplicate>true</is_duplicate>
<duplicate_id>finding-id</duplicate_id>
<confidence>0.95</confidence>
<reason>Both reports describe the same issue in the same location</reason>
</dedupe_result>

OR if not a duplicate:

<dedupe_result>
<is_duplicate>false</is_duplicate>
<duplicate_id></duplicate_id>
<confidence>0.90</confidence>
<reason>Different endpoint or root cause</reason>
</dedupe_result>

RULES:
- is_duplicate MUST be exactly "true" or "false"
- duplicate_id MUST be the exact ID from existing reports or empty if not duplicate
- confidence MUST be a decimal
- reason MUST specifically mention location or root cause
- DO NOT include any text outside the <dedupe_result> tags`;

const cleanReport = (report: FindingDuplicateReport): FindingDuplicateReport => {
  const relevantFields: Array<keyof FindingDuplicateReport> = [
    'id',
    'title',
    'description',
    'impact',
    'target',
    'technicalAnalysis',
    'pocDescription',
    'endpoint',
    'method',
  ];

  const cleaned: FindingDuplicateReport = {};
  for (const field of relevantFields) {
    const value = report[field];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    cleaned[field] = trimmed.length > MAX_FIELD_LENGTH
      ? `${trimmed.slice(0, MAX_FIELD_LENGTH)}...[truncated]`
      : trimmed;
  }
  return cleaned;
};

const extractXmlField = (content: string, field: string): string => {
  const pattern = new RegExp(`<${field}>(.*?)</${field}>`, 'is');
  const match = pattern.exec(content);
  return match?.[1]?.trim() ?? '';
};

const parseDecision = (content: string, validIds: Set<string>): FindingDuplicateDecision => {
  const blockMatch = /<dedupe_result>(.*?)<\/dedupe_result>/is.exec(content);
  if (!blockMatch?.[1]) {
    throw new Error('No <dedupe_result> block found in response');
  }

  const resultContent = blockMatch[1];
  const isDuplicate = extractXmlField(resultContent, 'is_duplicate').toLowerCase() === 'true';
  const duplicateId = extractXmlField(resultContent, 'duplicate_id').slice(0, 64);
  const confidenceRaw = extractXmlField(resultContent, 'confidence');
  const reason = extractXmlField(resultContent, 'reason').slice(0, 500);
  const confidence = Number.isFinite(Number(confidenceRaw)) ? Number(confidenceRaw) : 0;

  if (isDuplicate && duplicateId && !validIds.has(duplicateId)) {
    throw new Error(`Duplicate judge returned unknown finding id: ${duplicateId}`);
  }

  return {
    isDuplicate,
    duplicateId: isDuplicate ? duplicateId : '',
    confidence,
    reason,
  };
};

export class LlmFindingDuplicateJudge implements FindingDuplicateJudge {
  private readonly log = logger.child({ scope: 'LlmFindingDuplicateJudge' });

  async checkDuplicate(
    candidate: FindingDuplicateReport,
    existingReports: FindingDuplicateReport[],
    runtime?: {
      sessionId: string;
      turnNumber: number;
      abortSignal: AbortSignal;
      executeModelCall: NonNullable<TurnExecutorPort['executeModelCall']>;
    },
  ): Promise<FindingDuplicateDecision> {
    if (existingReports.length === 0) {
      return {
        isDuplicate: false,
        duplicateId: '',
        confidence: 1,
        reason: 'No existing reports to compare against',
      };
    }

    try {
      if (!runtime) throw new Error('ModelRuntime is unavailable for duplicate judging');

      const comparisonPayload = {
        candidate: cleanReport(candidate),
        existingReports: existingReports.map((report) => cleanReport(report)),
      };

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: DEDUPE_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Compare this candidate vulnerability against existing reports:\n\n${JSON.stringify(comparisonPayload, null, 2)}\n\n` +
            'Respond with ONLY the <dedupe_result> XML block.',
        },
      ];

      const result = await runtime.executeModelCall({
        sessionId: runtime.sessionId,
        turnNumber: runtime.turnNumber,
        routeReason: 'finding_duplicate_judge',
        messages,
        tools: [],
        signal: AbortSignal.any([runtime.abortSignal, AbortSignal.timeout(DEDUPE_TIMEOUT_MS)]),
        maxTokens: DEDUPE_MAX_OUTPUT_TOKENS,
        temperature: 0,
      });
      const responseContent = result.content;

      if (!responseContent.trim()) {
        return {
          isDuplicate: false,
          duplicateId: '',
          confidence: 0,
          reason: 'Empty response from duplicate judge',
          error: 'empty_response',
        };
      }

      const validIds = new Set(
        existingReports
          .map((report) => report.id)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      );

      const decision = parseDecision(responseContent, validIds);
      this.log.info(
        {
          isDuplicate: decision.isDuplicate,
          duplicateId: decision.duplicateId,
          confidence: decision.confidence,
        },
        '[security-ops] Duplicate judge completed',
      );
      return decision;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn({ err: error }, '[security-ops] Duplicate judge failed, falling back to exact dedupe');
      return {
        isDuplicate: false,
        duplicateId: '',
        confidence: 0,
        reason: `Duplicate judge failed: ${message}`,
        error: message,
      };
    }
  }
}
