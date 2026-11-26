import fs from 'fs/promises';
import path from 'path';

import type { ManagedShellJobResult } from '@/domains/agent-brain/adapters/sandbox';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { registerToolContract } from '@/domains/agent-brain/application/tools/ToolContractRegistry';
import { resolveRunnerSessionBindingFromFlags } from '@/domains/security-ops/runners/runnerSession';
import {
  normalizePhaseKey,
  phaseProfileRegistry,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';

export const createAbortError = (reason?: string): Error => {
  const error = new Error(reason ?? 'Aborted');
  error.name = 'AbortError';
  return error;
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(createAbortError(signal.reason?.toString()));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(createAbortError(signal.reason?.toString()));
      },
      { once: true },
    );
  });

// summarizeForNote imported from @/shared/utils/text

export const streamLabel = {
  stdout: 'stdout',
  stderr: 'stderr',
} as const;

export const SHELL_RUN_DESCRIPTION = [
  'Execute a non-interactive shell command in the workspace sandbox.',
  'Long-running commands are managed jobs. If the initial wait budget expires, the command keeps running and this tool returns job metadata instead of failing the session.',
  'Use wait_for_shell_job or action="check" with the returned jobId to inspect progress. Use action="cancel" to stop a managed job.',
  '',
  'TOOL ROUTING — use dedicated tools when they exist:',
  '- File reads: use file_read (NOT cat/head/tail) for evidence-grade file content',
  '- HTTP requests: use http_payload (NOT curl/wget) for evidence-grade normal HTTP exchanges; use http_raw_send only when exact malformed wire bytes, duplicate headers, or same-socket behavior are the test',
  '- File search: use query_inventory or file tools (NOT find/grep) for inventory queries',
  '- File writes: use file_write (NOT echo >/cat <<EOF) for workspace file creation',
  'Use shell_run ONLY for: scanner invocations, package managers, git operations, OS commands, and tasks that no dedicated tool covers.',
  '',
  'SECURITY TOOL PATTERNS:',
  '- subfinder/assetfinder/amass: start with passive subdomain discovery; use dnsx or puredns to resolve and validate candidates.',
  '- urlfinder/gau: enrich confirmed domains with passive URL history after live hosts are known. Deduplicate before using historical paths against a target.',
  '- dig/whois/openssl/tlsx/testssl.sh: inspect DNS, certificates, TLS versions, and service posture before deciding whether a finding needs deeper validation.',
  '- httpx: prefer for broad HTTP probing and tech detection before deeper manual probes. Save structured output when it will inform later steps.',
  '- naabu: use for fast port confirmation on broad surfaces; escalate to nmap once a host is worth deeper service validation.',
  '- nmap: use -sV for service detection and -sC for default scripts once NSE is available. Save output with -oN for evidence. Do not use -T5 unless RoE permits aggressive timing.',
  '- katana/gospider/linkfinder/secretfinder: use to crawl SPAs, extract routes from JS, and identify client-side secrets or endpoints.',
  '- ffuf/gobuster/dirsearch/arjun/kr/unfurl/qsreplace/anew: use for directory, route, API, parameter, URL normalization, payload preparation, and deduplication workflows. Respect rate limits and save outputs.',
  '- schemathesis/grpcurl: use for schema-backed API probing and gRPC reflection/manual calls. Use http_payload, not curl, for evidence-grade final HTTP exchanges.',
  '- nuclei/cvemap/nikto/dalfox/wafw00f: use to turn fingerprints into targeted hypotheses, not as a substitute for understanding the surface.',
  '- sqlmap/jwt-tool: use for targeted confirmation when earlier evidence points to injectable parameters or token abuse paths.',
  '- trufflehog/gitleaks/retire: use for secret leakage and dependency-risk checks against fetched assets, JS bundles, or cloned repos.',
  '',
  'EVIDENCE CAPTURE:',
  '- When running a scan or exploit, redirect output to a file under /workspace/.artifacts/scans/<tool-or-task>/ (e.g., `nmap -sV target -oX /workspace/.artifacts/scans/nmap/services.xml`).',
  '- File evidence is durable; stdout evidence may be truncated by the runtime. Always save important output to files.',
  '- Structured scanner artifacts under /workspace/.artifacts/scans are auto-discoverable by ingest_scan_artifact when the selected parser has one clear match; use ingestable output flags: nuclei -jsonl -o, ffuf -of json -o, httpx -json -o, katana -jsonl -o, nmap -oX, gitleaks/trivy JSON or SARIF report flags.',
  '- After scanner ingest, prefer /workspace/scans/digest.md and recon/*.json for review. Open raw scanner artifacts only when the digest is insufficient for evidence drill-down or parser repair.',
  '- Scanner jobs in run phases inherit the phase maxScannerWallSeconds budget. If a scan is still running after wait_for_shell_job, use the returned partialIngestion args with ingest_scan_artifact(partial=true) before waiting again.',
  '- Do not use `2>&1` unless the command specifically requires merged streams; leave stderr visible so TLS, DNS, parser, and scanner diagnostics survive in the trace.',
  '',
  'ERROR RECOVERY:',
  '- If a command fails, retry ONCE with adjusted parameters (different flags, timeout, encoding).',
  '- If the same command fails twice, try an alternative approach or tool.',
  '- After 3 failures on the same step, record an approach.tried note and move on. Do NOT loop on the same failing command.',
  '- Do not repeat the same failing command with identical arguments. Change the approach, change the flags, or stop.',
  '',
  'COMMAND LIMITS:',
  '- Commands have a short initial wait budget and a longer managed lifetime. When status is "running", continue useful non-overlapping work, then call wait_for_shell_job before treating the scan output as evidence.',
  '- If the same scanner family is already running against the same target, shell_run will reuse the existing managed job instead of starting a duplicate scan.',
  '- For deterministic reconnaissance phases, prefer one shell_run that writes all planned phase artifacts, then one wait_for_shell_job, then the related ingest/report tool calls. Do not split a predefined scan phase into unnecessary model checkpoints.',
  '- Long-running scans should still use appropriate scope-limiting flags.',
  '- Do NOT start interactive sessions (vim, less, top, python REPL) — they WILL hang and consume budget.',
  '- Do NOT run background processes manually (command &) — shell_run manages long-running jobs for you.',
].join('\n');

export const SHELL_RUN_CONTRACT = registerToolContract({
  name: 'shell_run',
  description: SHELL_RUN_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute when action is run.' },
      action: {
        type: 'string',
        enum: ['run', 'check', 'cancel'],
        description: 'run starts a command; check polls an existing managed shell job; cancel stops one.',
      },
      jobId: { type: 'string', description: 'Managed shell job id returned by a previous shell_run call.' },
      waitMs: {
        type: 'number',
        description: 'Optional initial wait budget in milliseconds before returning status=running.',
      },
      hardTimeoutMs: {
        type: 'number',
        description: 'Optional maximum managed job lifetime in milliseconds.',
      },
    },
    required: [],
  },
});

export const WAIT_FOR_SHELL_JOB_DESCRIPTION = [
  'Wait for a managed shell job returned by shell_run to finish, without starting a new command.',
  'Use this for long-running scanners such as nuclei, nmap, subfinder, httpx, ffuf, and crawlers before marking coverage or evidence as complete.',
  'If the timeout expires and the job is still running, the tool returns the current job status with waitTimedOut=true plus outcome, bytesOut, bytesErr, and nextAction so you can decide whether to wait again, read output, retry once, or record a blocker.',
  'For supported scanners with structured output, a timed-out running wait may include partialIngestion args and scannerArtifacts. Call ingest_scan_artifact with partial=true before re-waiting on the same scanner.',
  'When scannerArtifacts reports exists=false, do not read the missing path. Retry once with a smaller scope/output path or record scan.coverage blocked with the job id and reason.',
  'After ingest, read /workspace/scans/digest.md before opening raw scanner output.',
  'After a deterministic scan phase finishes, issue the related ingest_scan_artifact calls together when they do not depend on each other.',
  'Do not use this as a generic sleep. Use it only when you have a jobId from shell_run.',
].join('\n');

export const WAIT_FOR_SHELL_JOB_CONTRACT = registerToolContract({
  name: 'wait_for_shell_job',
  description: WAIT_FOR_SHELL_JOB_DESCRIPTION,
  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Managed shell job id returned by shell_run.' },
      timeoutSec: {
        type: 'number',
        description: 'Maximum seconds to wait in this tool call. Defaults to 60, capped at 300.',
      },
    },
    required: ['jobId'],
  },
});

export const managedJobMonitors = new Map<string, NodeJS.Timeout>();
export const DEFAULT_WAIT_FOR_SHELL_JOB_MS = 60_000;
export const MAX_WAIT_FOR_SHELL_JOB_MS = 300_000;
export const MAX_MANAGED_CHECK_WAIT_MS = 15_000;
export const MAX_INLINE_SHELL_RESULT_CHARS = 4_096;
export const SCANNER_COMMAND_FAMILIES = new Set([
  'subfinder',
  'naabu',
  'httpx',
  'ffuf',
  'katana',
  'nuclei',
  'gitleaks',
  'trivy',
  'nmap',
  'sqlmap',
]);
export const PARTIAL_INGEST_SCANNERS = new Set([
  'subfinder',
  'naabu',
  'httpx',
  'nuclei',
  'katana',
  'gitleaks',
  'trivy',
  'sqlmap',
]);
export const SCANNER_OUTPUT_FLAG_HINTS: Record<string, string[]> = {
  subfinder: ['-json or line output', '-o /workspace/.artifacts/...'],
  naabu: ['-json or line output', '-o /workspace/.artifacts/...'],
  httpx: ['-json', '-o /workspace/.artifacts/...'],
  ffuf: ['-of json', '-o /workspace/.artifacts/...'],
  katana: ['-jsonl', '-o /workspace/.artifacts/...'],
  nuclei: ['-jsonl', '-o /workspace/.artifacts/...'],
  gitleaks: ['--report-format json or sarif', '--report-path /workspace/.artifacts/...'],
  trivy: ['--format json or sarif', '--output /workspace/.artifacts/...'],
  nmap: ['-oX /workspace/.artifacts/...'],
  sqlmap: ['--batch', '--output-dir /workspace/.artifacts/... or redirected JSON/SARIF artifact'],
};
export const FATAL_SCANNER_CONFIG_PATTERNS: Array<{ pattern: RegExp; reason: string; kind?: ShellFailureKind }> = [
  { pattern: /could not find template/i, reason: 'scanner template path was not found' },
  { pattern: /no such path found/i, reason: 'scanner referenced a missing template or input path' },
  { pattern: /\bunknown flag\b/i, reason: 'scanner received an unsupported flag' },
  { pattern: /flag provided but not defined/i, reason: 'scanner received an unsupported flag' },
  { pattern: /no such file or directory/i, reason: 'scanner referenced a missing input or template file' },
  { pattern: /no space left on device/i, reason: 'workspace storage is exhausted', kind: 'workspace_storage' },
];

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export type ShellAction = 'run' | 'check' | 'cancel';
export type ManagedShellJobOutcome = ReturnType<typeof deriveManagedShellJobOutcome>;
export type ShellJobNextAction = 'read_output' | 'wait_again' | 'record_blocked' | 'retry_once';
export type ShellFailureKind = 'scanner_config' | 'workspace_storage';
export type ScannerBudgetResponse = {
  scannerFamily: string;
  phaseKey?: RunPhaseKey;
  maxScannerWallSeconds?: number;
  elapsedMs: number;
  budgetExceeded: boolean;
  budgetExceededAt?: string;
};
export type ScannerArtifactStatus = {
  artifactPath: string;
  visiblePath: string;
  exists: boolean;
  isFile?: boolean;
  sizeBytes?: number;
  digestPath: '/workspace/scans/digest.md';
  ingest?: {
    tool: 'ingest_scan_artifact';
    args: {
      parser: string;
      artifactPath: string;
      partial?: true;
    };
  };
  missingHint?: string;
};
export type StoragePreflightResponse = {
  checked: boolean;
  ok: boolean;
  severity: 'ok' | 'warn' | 'critical' | 'unknown';
  freeMb?: number;
  usedPercent?: number;
  nextAction?: string;
  error?: string;
};
export type PartialIngestionResponse = {
  suggested: boolean;
  reason: string;
  tool: 'ingest_scan_artifact';
  args: {
    parser: string;
    artifactPath: string;
    partial: true;
  };
};

export type ManagedShellJobDiagnosis = {
  fatalConfigError: boolean;
  failureKind?: ShellFailureKind;
  failureReason?: string;
  scannerFamily?: string;
};

export const SCAN_DIGEST_PATH = '/workspace/scans/digest.md' as const;
export const SCANNER_RAW_READ_POLICY =
  'Read /workspace/scans/digest.md and projected recon files first; open raw scanner artifacts only for evidence drill-down or parser repair.';
export const WORKSPACE_STORAGE_WARN_FREE_MB = 512;
export const WORKSPACE_STORAGE_CRITICAL_FREE_MB = 128;
export const WORKSPACE_STORAGE_WARN_USED_PERCENT = 92;
export const WORKSPACE_STORAGE_CRITICAL_USED_PERCENT = 98;
export const DEFAULT_ACTIVE_SCANNER_JOB_CAP = 6;

export const resolveAction = (value: unknown, jobId: string): ShellAction => {
  if (value === 'check' || value === 'cancel' || value === 'run') {
    return value;
  }
  return jobId ? 'check' : 'run';
};

export const asOptionalPositiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
};

export const normalizeWaitForShellJobMs = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WAIT_FOR_SHELL_JOB_MS;
  }
  return Math.min(MAX_WAIT_FOR_SHELL_JOB_MS, Math.floor(value * 1000));
};

export const normalizeCommandForMatch = (command: string): string =>
  command.trim().toLowerCase().replace(/\s+/g, ' ');

export const extractScannerFamily = (command: string): string | null => {
  const segments = normalizeCommandForMatch(command)
    .split(/\r?\n|&&|;|\|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    const [firstToken] = segment.split(/\s+/);
    if (firstToken && SCANNER_COMMAND_FAMILIES.has(firstToken)) {
      return firstToken;
    }
  }
  return null;
};

export const extractScannerTargets = (command: string): string[] => {
  const matches = command.match(/https?:\/\/[^\s"'<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}/gi) ?? [];
  return Array.from(
    new Set(
      matches
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0 && !value.startsWith('/workspace')),
    ),
  ).sort();
};

export const buildScannerFingerprint = (command: string): string | null => {
  const scanner = extractScannerFamily(command);
  if (!scanner) {
    return null;
  }
  const targets = extractScannerTargets(command);
  if (targets.length === 0) {
    return null;
  }
  return `${scanner}:${targets.join(',')}`;
};

export const stripShellQuotes = (value: string): string =>
  value.replace(/^(['"])(.*)\1$/u, '$2');

export const tokenizeShellSegment = (segment: string): string[] =>
  segment.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(stripShellQuotes) ?? [];

export const extractScannerInvocation = (command: string): { family: string; segment: string; tokens: string[] } | null => {
  const segments = command
    .split(/\r?\n|&&|;|\|\|/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  for (const segment of segments) {
    const tokens = tokenizeShellSegment(segment);
    const firstToken = tokens[0]?.toLowerCase().replace(/(?:\.exe|\.cmd)$/u, '');
    if (firstToken && SCANNER_COMMAND_FAMILIES.has(firstToken)) {
      return { family: firstToken, segment, tokens };
    }
  }
  return null;
};

export const hasFlag = (tokens: readonly string[], flag: string): boolean =>
  tokens.some((token) => token === flag || token.startsWith(`${flag}=`));

export const getFlagValue = (tokens: readonly string[], flag: string): string | undefined => {
  const index = tokens.findIndex((token) => token === flag || token.startsWith(`${flag}=`));
  if (index < 0) {
    return undefined;
  }
  const token = tokens[index]!;
  if (token.startsWith(`${flag}=`)) {
    return token.slice(flag.length + 1);
  }
  return tokens[index + 1];
};

export const hasWorkspaceArtifactPath = (segment: string): boolean =>
  /(?:^|[\s"'=])(?:\/workspace\/\.artifacts|\.artifacts)\//iu.test(segment);

export const hasOutputRedirection = (tokens: readonly string[]): boolean =>
  tokens.some((token) => token === '>' || token === '1>' || token === '>>' || token === '1>>');

export const getRedirectTarget = (tokens: readonly string[]): string | undefined => {
  const index = tokens.findIndex((token) => token === '>' || token === '1>' || token === '>>' || token === '1>>');
  return index >= 0 ? tokens[index + 1] : undefined;
};

export const isWorkspaceArtifactValue = (value: string | undefined): boolean =>
  Boolean(normalizeWorkspaceArtifactPath(value));

export const hasScannerOutputArtifactPath = (family: string, tokens: readonly string[]): boolean => {
  if (isWorkspaceArtifactValue(getRedirectTarget(tokens))) {
    return true;
  }
  const outputFlagsByFamily: Record<string, string[]> = {
    subfinder: ['-o'],
    naabu: ['-o'],
    httpx: ['-o'],
    ffuf: ['-o'],
    katana: ['-o'],
    nuclei: ['-o'],
    nmap: ['-oX'],
    gitleaks: ['--report-path'],
    trivy: ['--output'],
    sqlmap: ['--output-dir'],
  };
  return (outputFlagsByFamily[family] ?? []).some((flag) => isWorkspaceArtifactValue(getFlagValue(tokens, flag)));
};

export const isJsonOrSarifFormat = (value: string | undefined): boolean =>
  typeof value === 'string' && /^(?:json|jsonl|sarif)$/iu.test(value.trim());

export const isJsonFormat = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().toLowerCase() === 'json';

export const buildScannerOutputContractFailure = (
  scannerFamily: string,
  message: string,
): Record<string, unknown> => ({
  success: false,
  error: message,
  code: 'scanner_output_contract_invalid',
  scannerFamily,
  requiredOutputFlags: SCANNER_OUTPUT_FLAG_HINTS[scannerFamily] ?? [],
});

export const validateScannerOutputContract = (command: string): Record<string, unknown> | null => {
  const invocation = extractScannerInvocation(command);
  if (!invocation) {
    return null;
  }
  const { family, segment, tokens } = invocation;
  const referencesArtifact = hasWorkspaceArtifactPath(segment);
  const writesArtifact = hasScannerOutputArtifactPath(family, tokens);
  const redirectsOutput = hasOutputRedirection(tokens);
  const hasStructuredOutputIntent =
    writesArtifact ||
    (redirectsOutput && referencesArtifact) ||
    hasFlag(tokens, '-json') ||
    hasFlag(tokens, '-jsonl') ||
    hasFlag(tokens, '-of') ||
    hasFlag(tokens, '-o') ||
    hasFlag(tokens, '-oX') ||
    hasFlag(tokens, '--output') ||
    hasFlag(tokens, '--report-path');
  if (!hasStructuredOutputIntent) {
    return null;
  }

  switch (family) {
    case 'nuclei':
      if ((writesArtifact || hasFlag(tokens, '-o')) && !hasFlag(tokens, '-jsonl')) {
        return buildScannerOutputContractFailure(
          family,
          'nuclei scanner artifacts must use -jsonl with an artifact path so ingest_scan_artifact can parse JSONL.',
        );
      }
      return null;
    case 'ffuf':
      if ((writesArtifact || hasFlag(tokens, '-of')) && !isJsonFormat(getFlagValue(tokens, '-of'))) {
        return buildScannerOutputContractFailure(
          family,
          'ffuf scanner artifacts must use -of json with -o /workspace/.artifacts/...',
        );
      }
      return null;
    case 'httpx':
      if (writesArtifact && !hasFlag(tokens, '-json')) {
        return buildScannerOutputContractFailure(
          family,
          'httpx scanner artifacts must use -json with -o /workspace/.artifacts/... so JSONL records are ingestable.',
        );
      }
      return null;
    case 'katana':
      if (writesArtifact && !hasFlag(tokens, '-jsonl') && !hasFlag(tokens, '-json')) {
        return buildScannerOutputContractFailure(
          family,
          'katana scanner artifacts must use -jsonl or -json with -o /workspace/.artifacts/...',
        );
      }
      return null;
    case 'nmap':
      if (writesArtifact && !hasFlag(tokens, '-oX')) {
        return buildScannerOutputContractFailure(
          family,
          'nmap scanner artifacts must use -oX /workspace/.artifacts/... because the ingest parser expects XML.',
        );
      }
      return null;
    case 'gitleaks':
      if (writesArtifact && !isJsonOrSarifFormat(getFlagValue(tokens, '--report-format'))) {
        return buildScannerOutputContractFailure(
          family,
          'gitleaks scanner artifacts must use --report-format json or sarif with --report-path /workspace/.artifacts/...',
        );
      }
      return null;
    case 'trivy':
      if (writesArtifact && !isJsonOrSarifFormat(getFlagValue(tokens, '--format'))) {
        return buildScannerOutputContractFailure(
          family,
          'trivy scanner artifacts must use --format json or sarif with --output /workspace/.artifacts/...',
        );
      }
      return null;
    default:
      return null;
  }
};

export const getSecurityOpsFlagRecord = (
  session: { flags?: Record<string, unknown> } | undefined,
): Record<string, unknown> =>
  isRecord(session?.flags?.securityops) ? session.flags.securityops as Record<string, unknown> : {};

export const resolveActivePhaseKey = (
  session: { flags?: Record<string, unknown> } | undefined,
): RunPhaseKey | null => {
  const securityops = getSecurityOpsFlagRecord(session);
  return normalizePhaseKey(securityops.activePhaseKey);
};

export const resolveScannerWallBudget = (
  session: { flags?: Record<string, unknown> } | undefined,
  command: string,
): { scannerFamily: string; phaseKey: RunPhaseKey; maxScannerWallSeconds: number; hardTimeoutMs: number } | null => {
  const scannerFamily = extractScannerFamily(command);
  if (!scannerFamily) {
    return null;
  }
  const phaseKey = resolveActivePhaseKey(session);
  if (!phaseKey) {
    return null;
  }
  const profile = phaseProfileRegistry.get(phaseKey);
  return {
    scannerFamily,
    phaseKey,
    maxScannerWallSeconds: profile.maxScannerWallSeconds,
    hardTimeoutMs: profile.maxScannerWallSeconds * 1000,
  };
};

export const normalizeWorkspaceArtifactPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  let normalized = value.trim().replace(/\\/g, '/').replace(/[),.;]+$/u, '');
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('/workspace/')) {
    normalized = normalized.slice('/workspace/'.length);
  } else if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.startsWith('.artifacts/') ? normalized : undefined;
};

export const extractWorkspaceArtifactPaths = (command: string): string[] =>
  Array.from(
    new Set(
      (command.match(/(?:\/workspace\/\.artifacts|\.artifacts)\/[^\s"'<>|`]+/giu) ?? [])
        .map(normalizeWorkspaceArtifactPath)
        .filter((value): value is string => Boolean(value)),
    ),
  );

export const getNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const parseTimestampMs = (value: unknown): number | undefined => {
  const raw = getString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const resolveActiveScannerJobCap = (session: { flags?: Record<string, unknown> } | undefined): number => {
  const securityops = getSecurityOpsFlagRecord(session);
  const configured =
    typeof securityops.maxActiveScannerJobs === 'number'
      ? securityops.maxActiveScannerJobs
      : typeof process.env.SECURITYOPS_MAX_ACTIVE_SCANNER_JOBS === 'string'
        ? Number(process.env.SECURITYOPS_MAX_ACTIVE_SCANNER_JOBS)
        : DEFAULT_ACTIVE_SCANNER_JOB_CAP;
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : DEFAULT_ACTIVE_SCANNER_JOB_CAP;
};

export const getActiveScannerJobAdmission = (
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  command: string,
): { scannerFamily: string; activeCount: number; cap: number; activeJobIds: string[] } | null => {
  const scannerFamily = extractScannerFamily(command);
  if (!scannerFamily) {
    return null;
  }
  const flags = isRecord(session.flags) ? session.flags : {};
  const shellJobs = isRecord(flags.shellJobs) ? flags.shellJobs : {};
  const activeJobIds = Object.values(shellJobs)
    .filter(isRecord)
    .filter((job) => {
      const jobCommand = getString(job.command) ?? '';
      const status = getString(job.status)?.toLowerCase();
      return (
        Boolean(extractScannerFamily(jobCommand)) &&
        (status === 'running' || status === 'unknown' || job.commandFinished === false)
      );
    })
    .map((job) => getString(job.jobId) ?? '')
    .filter((jobId) => jobId.length > 0);
  return {
    scannerFamily,
    activeCount: activeJobIds.length,
    cap: resolveActiveScannerJobCap(session),
    activeJobIds,
  };
};

export const buildPartialIngestionSuggestion = (
  result: ManagedShellJobResult,
): PartialIngestionResponse | undefined => {
  const scannerFamily = extractScannerFamily(result.command);
  if (!scannerFamily || !PARTIAL_INGEST_SCANNERS.has(scannerFamily)) {
    return undefined;
  }
  const artifactPath =
    extractWorkspaceArtifactPaths(result.command)[0] ??
    normalizeWorkspaceArtifactPath(result.stdoutPath);
  if (!artifactPath) {
    return undefined;
  }
  return {
    suggested: true,
    reason: 'Scanner is still running after a wait window; ingest partial structured output before waiting again.',
    tool: 'ingest_scan_artifact',
    args: {
      parser: scannerFamily,
      artifactPath,
      partial: true,
    },
  };
};

export const toWorkspaceVisiblePath = (relativePath: string): string =>
  `/workspace/${relativePath.replace(/\\/g, '/').replace(/^\/+/u, '')}`;

export const statWorkspaceArtifact = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  relativePath: string,
): Promise<{ exists: boolean; isFile: boolean; sizeBytes: number; mtimeMs: number | null }> => {
  if (typeof ctx.sandbox.statFile === 'function') {
    const stat = await ctx.sandbox.statFile(session, relativePath).catch(() => undefined);
    if (stat) {
      return stat;
    }
  }

  const workspaceDir =
    typeof session.workspaceDir === 'string' && session.workspaceDir.trim().length > 0
      ? session.workspaceDir
      : ctx.workspaceDir;
  if (workspaceDir) {
    const localPath = path.resolve(workspaceDir, relativePath);
    const stat = await fs.stat(localPath).catch(() => null);
    if (stat) {
      return {
        exists: true,
        isFile: stat.isFile(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }
  }

  return { exists: false, isFile: false, sizeBytes: 0, mtimeMs: null };
};

export const buildScannerArtifactStatuses = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  result: ManagedShellJobResult,
): Promise<ScannerArtifactStatus[] | undefined> => {
  const scannerFamily = extractScannerFamily(result.command);
  if (!scannerFamily) {
    return undefined;
  }

  const explicitArtifactPaths = extractWorkspaceArtifactPaths(result.command);
  const artifactPaths = Array.from(
    new Set(
      explicitArtifactPaths.length > 0
        ? explicitArtifactPaths
        : normalizeWorkspaceArtifactPath(result.stdoutPath)
          ? [normalizeWorkspaceArtifactPath(result.stdoutPath)!]
          : [],
    ),
  );
  if (artifactPaths.length === 0) {
    return [];
  }

  const partial = result.status === 'running' || result.status === 'unknown' || result.commandFinished === false;
  const statuses: ScannerArtifactStatus[] = [];
  for (const artifactPath of artifactPaths) {
    const stat = await statWorkspaceArtifact(ctx, session, artifactPath);
    statuses.push({
      artifactPath,
      visiblePath: toWorkspaceVisiblePath(artifactPath),
      exists: stat.exists === true,
      isFile: stat.isFile,
      sizeBytes: stat.sizeBytes,
      digestPath: SCAN_DIGEST_PATH,
      ...(stat.exists && stat.isFile
        ? {
            ingest: {
              tool: 'ingest_scan_artifact',
              args: {
                parser: scannerFamily,
                artifactPath,
                ...(partial && PARTIAL_INGEST_SCANNERS.has(scannerFamily) ? { partial: true as const } : {}),
              },
            },
          }
        : {
            missingHint:
              'The scanner output artifact is missing. Do not file_read this path; retry once with a smaller scope/output path or record scan.coverage blocked with the job id and reason.',
          }),
    });
  }

  return statuses;
};

export const parseWorkspaceDfOutput = (stdout: string): StoragePreflightResponse => {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const match = last.match(/(\d+)\s+(\d+)%?/u);
  if (!match) {
    return { checked: false, ok: true, severity: 'unknown', error: 'Could not parse workspace disk preflight output.' };
  }
  const freeKb = Number(match[1]);
  const usedPercent = Number(match[2]);
  if (!Number.isFinite(freeKb) || !Number.isFinite(usedPercent)) {
    return { checked: false, ok: true, severity: 'unknown', error: 'Workspace disk preflight returned non-numeric values.' };
  }

  const freeMb = Math.floor(freeKb / 1024);
  const critical = freeMb < WORKSPACE_STORAGE_CRITICAL_FREE_MB || usedPercent >= WORKSPACE_STORAGE_CRITICAL_USED_PERCENT;
  const warn = critical || freeMb < WORKSPACE_STORAGE_WARN_FREE_MB || usedPercent >= WORKSPACE_STORAGE_WARN_USED_PERCENT;
  return {
    checked: true,
    ok: !critical,
    severity: critical ? 'critical' : warn ? 'warn' : 'ok',
    freeMb,
    usedPercent,
    ...(warn
      ? {
          nextAction:
            'Reduce scan scope/rate/output, ingest and summarize existing artifacts, wait for active jobs, or record blocked coverage before starting more broad scanner work.',
        }
      : {}),
  };
};

export const checkWorkspaceStoragePreflight = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  command: string,
): Promise<StoragePreflightResponse | undefined> => {
  if (!extractScannerFamily(command) || typeof ctx.sandbox.exec !== 'function') {
    return undefined;
  }
  try {
    const result = await ctx.sandbox.exec({
      session,
      cmd: "df -Pk /workspace 2>/dev/null | awk 'NR==2 {gsub(/%/,\"\",$5); print $4 \" \" $5}'",
      timeoutMs: 5_000,
      signal: ctx.abortSignal,
    });
    if (!result || typeof result.stdout !== 'string') {
      return { checked: false, ok: true, severity: 'unknown', error: 'Workspace disk preflight did not return output.' };
    }
    return parseWorkspaceDfOutput(result.stdout);
  } catch (error) {
    return {
      checked: false,
      ok: true,
      severity: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const resolveHttpProxyPrefix = (session: { flags?: Record<string, unknown> } | undefined): string => {
  const proxy = session?.flags?.httpProxy;
  if (!isRecord(proxy) || proxy.enabled !== true || typeof proxy.url !== 'string' || proxy.url.trim().length === 0) {
    return '';
  }
  if (proxy.shellEnv !== true) {
    return '';
  }
  const proxyUrl = proxy.url.trim().replace(/'/g, `'\\''`);
  return [
    `export HTTP_PROXY='${proxyUrl}'`,
    `export HTTPS_PROXY='${proxyUrl}'`,
    `export http_proxy='${proxyUrl}'`,
    `export https_proxy='${proxyUrl}'`,
    "export NO_PROXY='127.0.0.1,localhost,::1'",
    "export no_proxy='127.0.0.1,localhost,::1'",
    'export NODE_TLS_REJECT_UNAUTHORIZED=0',
  ].join('\n') + '\n';
};

export const isSecurityOpsCloudSession = (session: { flags?: Record<string, unknown> } | undefined): boolean => {
  if (!isRecord(session?.flags) || !isRecord(session.flags.securityops)) {
    return false;
  }
  return resolveRunnerSessionBindingFromFlags(session.flags).executionTarget === 'cloud';
};

export const syncWorkspaceEntryToSandbox = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  workspaceDir: string,
  relativePath: string,
): Promise<void> => {
  const absolutePath = path.resolve(workspaceDir, relativePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath = path.posix.join(relativePath.replace(/\\/g, '/'), entry.name);
      if (entry.isDirectory()) {
        await syncWorkspaceEntryToSandbox(ctx, session, workspaceDir, childRelativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const content = await fs.readFile(path.resolve(workspaceDir, childRelativePath));
      await ctx.sandbox.writeFile(session, childRelativePath, content);
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }
  const content = await fs.readFile(absolutePath);
  await ctx.sandbox.writeFile(session, relativePath, content);
};

export const syncReferencedWorkspaceSupportFiles = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  command: string,
): Promise<void> => {
  if (typeof ctx.sandbox.writeFile !== 'function') {
    return;
  }

  const workspaceDir =
    typeof session.workspaceDir === 'string' && session.workspaceDir.trim().length > 0
      ? session.workspaceDir
      : ctx.workspaceDir;
  if (!workspaceDir || workspaceDir.trim().length === 0) {
    return;
  }

  const mirrors = new Set<string>();
  if (command.includes('/workspace/.skills/')) {
    mirrors.add('.skills');
  }
  if (command.includes('/workspace/.credentials')) {
    mirrors.add('.credentials');
  }

  for (const relativePath of mirrors) {
    try {
      await syncWorkspaceEntryToSandbox(ctx, session, workspaceDir, relativePath);
    } catch (error) {
      logger.warn(
        { err: error, sessionId: session.id, relativePath },
        'Failed to sync workspace support files for shell execution',
      );
    }
  }
};

export const hasManagedShellJobs = (
  sandbox: unknown,
): sandbox is {
  startManagedShellJob: (
    session: NonNullable<ReturnType<typeof getSessionFromContext>>,
    command: string,
    options: {
      waitBudgetMs?: number;
      hardTimeoutMs?: number;
      signal?: AbortSignal;
      turnNumber?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ) => Promise<ManagedShellJobResult>;
  checkManagedShellJob: (
    session: NonNullable<ReturnType<typeof getSessionFromContext>>,
    jobId: string,
    options?: { waitBudgetMs?: number; turnNumber?: number; signal?: AbortSignal },
  ) => Promise<ManagedShellJobResult>;
  cancelManagedShellJob: (
    session: NonNullable<ReturnType<typeof getSessionFromContext>>,
    jobId: string,
    reason?: string,
  ) => Promise<ManagedShellJobResult>;
} =>
  isRecord(sandbox) &&
  typeof sandbox.startManagedShellJob === 'function' &&
  typeof sandbox.checkManagedShellJob === 'function' &&
  typeof sandbox.cancelManagedShellJob === 'function';

export const isManagedShellUnsupported = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('managed_shell_jobs_not_supported');

export const isTerminalManagedShellStatus = (status: ManagedShellJobResult['status']): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

export const getTrackedManagedShellJobIds = (
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
): string[] => {
  const flags = isRecord(session.flags) ? session.flags : {};
  const shellJobs = isRecord(flags.shellJobs) ? flags.shellJobs : {};
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(shellJobs)) {
    if (key.trim()) {
      ids.add(key.trim());
    }
    if (isRecord(value)) {
      const jobId = typeof value.jobId === 'string' ? value.jobId.trim() : '';
      if (jobId) {
        ids.add(jobId);
      }
    }
  }
  return Array.from(ids).sort();
};

export const buildUnknownManagedShellJobResponse = (
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  jobId: string,
) => {
  const knownJobIds = getTrackedManagedShellJobIds(session);
  if (knownJobIds.length === 0 || knownJobIds.includes(jobId)) {
    return null;
  }

  return {
    success: false,
    error:
      `Unknown managed shell job id "${jobId}". ` +
      `Use a jobId returned by shell_run. Known job ids: ${knownJobIds.join(', ')}`,
    jobId,
    knownJobIds,
    status: 'unknown',
    outcome: 'failed',
    nextAction: 'record_blocked',
    failureKind: 'unknown_job_id',
    waitTimedOut: false,
    reusedExistingJob: false,
  };
};

export const deriveManagedShellJobOutcome = (
  result: ManagedShellJobResult,
  diagnosis: ManagedShellJobDiagnosis,
): 'running' | 'completed_with_results' | 'completed_no_reportable_output' | 'failed' | 'cancelled' | 'not_run' => {
  if (result.status === 'cancelled' || result.cancelled === true) {
    return 'cancelled';
  }
  if (diagnosis.fatalConfigError) {
    return 'failed';
  }
  if (result.status === 'failed' || result.success === false || (typeof result.exitCode === 'number' && result.exitCode !== 0)) {
    return 'failed';
  }
  if (result.status === 'running' || result.status === 'unknown' || result.commandFinished === false) {
    return 'running';
  }
  if (result.status === 'completed') {
    return result.bytesOut > 0 || result.stdout.trim().length > 0
      ? 'completed_with_results'
      : 'completed_no_reportable_output';
  }
  return 'not_run';
};

export const deriveNextAction = (
  result: Pick<ManagedShellJobResult, 'status'> & {
    exitCode?: number | null;
    cancelled?: boolean;
  },
  outcome: ManagedShellJobOutcome,
  diagnosis: ManagedShellJobDiagnosis,
): ShellJobNextAction => {
  if (diagnosis.failureKind === 'workspace_storage') {
    return 'record_blocked';
  }
  if (diagnosis.fatalConfigError) {
    return 'retry_once';
  }
  if (outcome === 'running' || result.status === 'unknown') {
    return 'wait_again';
  }
  if (outcome === 'completed_with_results' || outcome === 'completed_no_reportable_output') {
    return 'read_output';
  }
  if (outcome === 'failed') {
    return 'retry_once';
  }
  return 'record_blocked';
};

export const detectManagedShellJobDiagnosis = (
  result: Pick<ManagedShellJobResult, 'command' | 'stdout' | 'stderr'>,
): ManagedShellJobDiagnosis => {
  const scannerFamily = extractScannerFamily(result.command);
  if (!scannerFamily) {
    return { fatalConfigError: false };
  }

  for (const source of [result.stderr, result.stdout]) {
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      for (const candidate of FATAL_SCANNER_CONFIG_PATTERNS) {
        if (candidate.pattern.test(trimmed)) {
          return {
            fatalConfigError: true,
            failureKind: candidate.kind ?? 'scanner_config',
            failureReason: `${candidate.reason}: ${trimmed}`,
            scannerFamily,
          };
        }
      }
    }
  }

  return { fatalConfigError: false };
};

export const truncateInlineShellResult = (
  value: string,
  fullOutputPath: string,
): { text: string; truncated: boolean } => {
  if (value.length <= MAX_INLINE_SHELL_RESULT_CHARS) {
    return { text: value, truncated: false };
  }

  const suffix = fullOutputPath
    ? `\n[truncated; full output at ${fullOutputPath}]`
    : '\n[truncated]';
  const budget = Math.max(0, MAX_INLINE_SHELL_RESULT_CHARS - suffix.length);
  return {
    text: `${value.slice(0, budget)}${suffix}`,
    truncated: true,
  };
};

export const buildManagedShellJobResponse = (
  result: ManagedShellJobResult,
  extras: {
    waitTimedOut?: boolean;
    reusedExistingJob?: boolean;
    scannerBudget?: ScannerBudgetResponse;
    scannerArtifacts?: ScannerArtifactStatus[];
    partialIngestion?: PartialIngestionResponse;
    storagePreflight?: StoragePreflightResponse;
  } = {},
) => {
  const diagnosis = detectManagedShellJobDiagnosis(result);
  const scannerFamily = diagnosis.scannerFamily ?? extractScannerFamily(result.command) ?? undefined;
  const allArtifactsExist = extras.scannerArtifacts && extras.scannerArtifacts.length > 0
    ? extras.scannerArtifacts.every((artifact) => artifact.exists && artifact.isFile !== false)
    : undefined;
  const outcome = deriveManagedShellJobOutcome(result, diagnosis);
  const stdout = truncateInlineShellResult(result.stdout, result.stdoutPath);
  const stderr = truncateInlineShellResult(result.stderr, result.stderrPath);
  const recommendedNextAction = scannerFamily
    ? diagnosis.failureKind === 'workspace_storage'
      ? 'record_scan_blocked_due_to_storage_pressure'
      : allArtifactsExist === false
      ? 'record_scan_blocked_or_retry_once_with_smaller_scope'
      : outcome === 'running'
        ? 'wait_for_shell_job_then_ingest_partial_if_available'
        : outcome === 'completed_with_results' || outcome === 'completed_no_reportable_output'
          ? 'ingest_scan_artifact_then_read_scan_digest'
          : undefined
    : undefined;
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    outcome,
    waitTimedOut: extras.waitTimedOut ?? false,
    reusedExistingJob: extras.reusedExistingJob ?? false,
    bytesOut: result.bytesOut,
    bytesErr: result.bytesErr,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    nextAction: deriveNextAction(result, outcome, diagnosis),
    ...(recommendedNextAction ? { recommendedNextAction } : {}),
    fatalConfigError: diagnosis.fatalConfigError,
    failureKind: diagnosis.failureKind,
    failureReason: diagnosis.failureReason,
    scannerFamily,
    ...(scannerFamily
      ? {
          digestPath: SCAN_DIGEST_PATH,
          rawReadPolicy: SCANNER_RAW_READ_POLICY,
          ...(typeof allArtifactsExist === 'boolean' ? { artifactExists: allArtifactsExist } : {}),
        }
      : {}),
    ...(extras.scannerBudget ? { scannerBudget: extras.scannerBudget } : {}),
    ...(extras.scannerArtifacts ? { scannerArtifacts: extras.scannerArtifacts } : {}),
    ...(extras.partialIngestion ? { partialIngestion: extras.partialIngestion } : {}),
    ...(extras.storagePreflight ? { storagePreflight: extras.storagePreflight } : {}),
  };
};

export const isManagedShellJobResponseOk = (
  response: ReturnType<typeof buildManagedShellJobResponse>,
): boolean =>
  response.outcome === 'running' ||
  response.outcome === 'completed_with_results' ||
  response.outcome === 'completed_no_reportable_output';

export const buildManagedShellJobToolResponse = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  result: ManagedShellJobResult,
  extras: Parameters<typeof buildManagedShellJobResponse>[1] = {},
): Promise<ReturnType<typeof buildManagedShellJobResponse>> => {
  const scannerArtifacts = await buildScannerArtifactStatuses(ctx, session, result);
  return buildManagedShellJobResponse(result, {
    ...extras,
    ...(scannerArtifacts ? { scannerArtifacts } : {}),
  });
};

export const buildManagedShellJobResultFromStored = (
  sessionId: string,
  job: Record<string, unknown>,
): ManagedShellJobResult | null => {
  const jobId = typeof job.jobId === 'string' ? job.jobId.trim() : '';
  const command = typeof job.command === 'string' ? job.command : '';
  const rawStatus = typeof job.status === 'string' ? job.status : 'unknown';
  if (!jobId || !command) {
    return null;
  }

  const status =
    rawStatus === 'running' ||
    rawStatus === 'completed' ||
    rawStatus === 'failed' ||
    rawStatus === 'cancelled' ||
    rawStatus === 'unknown'
      ? rawStatus
      : 'unknown';

  return {
    jobId,
    sessionId,
    command,
    status,
    stdout: '',
    stderr: '',
    exitCode: typeof job.exitCode === 'number' ? job.exitCode : null,
    success: typeof job.success === 'boolean' ? job.success : status !== 'failed' && status !== 'cancelled',
    commandFinished: typeof job.commandFinished === 'boolean' ? job.commandFinished : status !== 'running',
    outputPath: typeof job.outputPath === 'string' ? job.outputPath : '',
    stdoutPath: typeof job.stdoutPath === 'string' ? job.stdoutPath : '',
    stderrPath: typeof job.stderrPath === 'string' ? job.stderrPath : '',
    statusPath: typeof job.statusPath === 'string' ? job.statusPath : '',
    pidPath: typeof job.pidPath === 'string' ? job.pidPath : '',
    startedAt: typeof job.startedAt === 'string' ? job.startedAt : new Date().toISOString(),
    completedAt: typeof job.completedAt === 'string' ? job.completedAt : undefined,
    nextCheckAfterMs: typeof job.nextCheckAfterMs === 'number' ? job.nextCheckAfterMs : 5_000,
    bytesOut: typeof job.bytesOut === 'number' ? job.bytesOut : 0,
    bytesErr: typeof job.bytesErr === 'number' ? job.bytesErr : 0,
    timedOut: typeof job.timedOut === 'boolean' ? job.timedOut : undefined,
    cancelled: typeof job.cancelled === 'boolean' ? job.cancelled : undefined,
    cancellationReason: typeof job.cancellationReason === 'string' ? job.cancellationReason : undefined,
  };
};

export const findReusableScannerJob = (
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  command: string,
): ManagedShellJobResult | null => {
  const fingerprint = buildScannerFingerprint(command);
  if (!fingerprint) {
    return null;
  }
  const flags = isRecord(session.flags) ? session.flags : null;
  const shellJobs = flags && isRecord(flags.shellJobs) ? flags.shellJobs : null;
  if (!shellJobs) {
    return null;
  }

  for (const job of Object.values(shellJobs)) {
    if (!isRecord(job)) {
      continue;
    }
    if (job.scannerFingerprint !== fingerprint) {
      continue;
    }
    const status = typeof job.status === 'string' ? job.status : '';
    const outcome = typeof job.outcome === 'string' ? job.outcome : '';
    if (status !== 'running' && status !== 'unknown') {
      continue;
    }
    if (job.fatalConfigError === true || outcome === 'failed') {
      continue;
    }
    const materialized = buildManagedShellJobResultFromStored(session.id, job);
    if (materialized) {
      return materialized;
    }
  }

  return null;
};

export type RecordManagedShellJobStateOptions = {
  incrementWaitCount?: boolean;
  partialIngestion?: PartialIngestionResponse;
};

export const recordScannerBudgetState = async (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  result: ManagedShellJobResult,
  options: RecordManagedShellJobStateOptions,
): Promise<{
  securityops: Record<string, unknown>;
  scannerBudget?: ScannerBudgetResponse;
}> => {
  const scannerFamily = extractScannerFamily(result.command);
  const existingSecurityOps = getSecurityOpsFlagRecord(session);
  if (!scannerFamily) {
    return { securityops: existingSecurityOps };
  }

  const budget = resolveScannerWallBudget(session, result.command);
  const existingBudgetMap = isRecord(existingSecurityOps.scannerBudget)
    ? existingSecurityOps.scannerBudget as Record<string, unknown>
    : {};
  const existingRecord = isRecord(existingBudgetMap[result.jobId])
    ? existingBudgetMap[result.jobId] as Record<string, unknown>
    : {};
  const maxScannerWallSeconds =
    budget?.maxScannerWallSeconds ??
    getNumber(existingRecord.maxScannerWallSeconds);
  const phaseKey =
    budget?.phaseKey ??
    normalizePhaseKey(existingRecord.phaseKey);
  const startedAt = getString(existingRecord.startedAt) ?? result.startedAt;
  const startedAtMs = parseTimestampMs(startedAt) ?? Date.now();
  const completedAtMs = parseTimestampMs(result.completedAt);
  const elapsedMs = Math.max(0, (completedAtMs ?? Date.now()) - startedAtMs);
  const budgetExceeded =
    existingRecord.budgetExceeded === true ||
    result.timedOut === true ||
    (typeof maxScannerWallSeconds === 'number' && elapsedMs >= maxScannerWallSeconds * 1000);
  const budgetExceededAt =
    getString(existingRecord.budgetExceededAt) ??
    (budgetExceeded ? new Date().toISOString() : undefined);
  const waitCount = Math.max(0, Math.floor(getNumber(existingRecord.waitCount) ?? 0)) +
    (options.incrementWaitCount ? 1 : 0);
  const artifactPaths = Array.from(
    new Set([
      ...(
        Array.isArray(existingRecord.artifactPaths)
          ? existingRecord.artifactPaths.filter((entry): entry is string => typeof entry === 'string')
          : []
      ),
      ...extractWorkspaceArtifactPaths(result.command),
      ...(normalizeWorkspaceArtifactPath(result.stdoutPath) ? [normalizeWorkspaceArtifactPath(result.stdoutPath)!] : []),
    ]),
  );

  const nextRecord: Record<string, unknown> = {
    ...existingRecord,
    jobId: result.jobId,
    scannerFamily,
    command: result.command,
    status: result.status,
    startedAt,
    updatedAt: new Date().toISOString(),
    elapsedMs,
    waitCount,
    artifactPaths,
    stdoutPath: normalizeWorkspaceArtifactPath(result.stdoutPath) ?? result.stdoutPath,
    ...(phaseKey ? { phaseKey } : {}),
    ...(typeof maxScannerWallSeconds === 'number' ? { maxScannerWallSeconds } : {}),
    budgetExceeded,
    ...(budgetExceededAt ? { budgetExceededAt } : {}),
    ...(options.partialIngestion ? {
      partialIngestionSuggestedAt: getString(existingRecord.partialIngestionSuggestedAt) ?? new Date().toISOString(),
      partialIngestionSuggestion: options.partialIngestion,
    } : {}),
  };
  const nextBudgetMap = {
    ...existingBudgetMap,
    [result.jobId]: nextRecord,
  };

  if (budgetExceeded && existingRecord.budgetExceeded !== true) {
    await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
      event: 'scanner.budget_exceeded',
      severity: 'warn',
      payload: {
        jobId: result.jobId,
        scannerFamily,
        command: result.command,
        phaseKey,
        maxScannerWallSeconds,
        elapsedMs,
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
      },
      note: summarizeForNote(`${scannerFamily} scanner exceeded phase budget after ${elapsedMs}ms`),
    });
  }

  return {
    securityops: {
      ...existingSecurityOps,
      scannerBudget: nextBudgetMap,
    },
    scannerBudget: {
      scannerFamily,
      ...(phaseKey ? { phaseKey } : {}),
      ...(typeof maxScannerWallSeconds === 'number' ? { maxScannerWallSeconds } : {}),
      elapsedMs,
      budgetExceeded,
      ...(budgetExceededAt ? { budgetExceededAt } : {}),
    },
  };
};

export const recordManagedShellJobState = async (
  ctx: ToolContext,
  result: ManagedShellJobResult,
  options: RecordManagedShellJobStateOptions = {},
): Promise<{ scannerBudget?: ScannerBudgetResponse }> => {
  const session = getSessionFromContext(ctx);
  if (!session || typeof ctx.sessionStore?.setAsync !== 'function') {
    return {};
  }

  const diagnosis = detectManagedShellJobDiagnosis(result);
  const flags = isRecord(session.flags) ? session.flags : {};
  const shellJobs = isRecord(flags.shellJobs) ? flags.shellJobs : {};
  const scannerState = await recordScannerBudgetState(ctx, session, result, options);
  session.flags = {
    ...flags,
    securityops: scannerState.securityops,
    shellJobs: {
      ...shellJobs,
      [result.jobId]: {
        ...diagnosis,
        jobId: result.jobId,
        command: result.command,
        status: result.status,
        outcome: deriveManagedShellJobOutcome(result, diagnosis),
        commandFinished: result.commandFinished,
        success: result.success,
        exitCode: result.exitCode,
        outputPath: result.outputPath,
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
        statusPath: result.statusPath,
        pidPath: result.pidPath,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        nextCheckAfterMs: result.nextCheckAfterMs,
        bytesOut: result.bytesOut,
        bytesErr: result.bytesErr,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        cancellationReason: result.cancellationReason,
        scannerFingerprint: buildScannerFingerprint(result.command),
        updatedAt: new Date().toISOString(),
      },
    },
  };

  try {
    await ctx.sessionStore.setAsync(session.id, session, 'shell.job_state');
  } catch (error) {
    logger.warn({ err: error, sessionId: ctx.sessionId, jobId: result.jobId }, 'Failed to record managed shell job state');
  }
  return scannerState.scannerBudget ? { scannerBudget: scannerState.scannerBudget } : {};
};

export const scheduleManagedJobMonitor = (
  ctx: ToolContext,
  session: NonNullable<ReturnType<typeof getSessionFromContext>>,
  jobId: string,
  delayMs = 2_000,
): void => {
  const key = `${ctx.sessionId}:${jobId}`;
  if (managedJobMonitors.has(key) || !hasManagedShellJobs(ctx.sandbox)) {
    return;
  }

  const poll = async (): Promise<void> => {
    const latestSession = getSessionFromContext(ctx);
    if (!latestSession) {
      managedJobMonitors.delete(key);
      return;
    }
    try {
      const result = await ctx.sandbox.checkManagedShellJob(latestSession, jobId, { turnNumber: ctx.turnNumber });
      await recordManagedShellJobState(ctx, result);
      if (result.status === 'running' || result.status === 'unknown') {
        const timer = setTimeout(() => void poll(), result.nextCheckAfterMs ?? delayMs);
        managedJobMonitors.set(key, timer);
        return;
      }

      managedJobMonitors.delete(key);
      const message = `Managed shell job ${jobId} ${result.status} (exit ${result.exitCode ?? 'n/a'}). Output: ${result.stdoutPath}`;
      ctx.streamBroker.emit(ctx.sessionId, {
        type: 'tool_output',
        data: { name: 'shell_run', chunk: message },
      });
      await ctx.trace?.write(ctx.sessionId, ctx.turnNumber ?? (session.turn ?? 0) + 1, {
        event: `shell_job.${result.status}`,
        severity: result.status === 'failed' ? 'warn' : 'info',
        payload: {
          jobId,
          status: result.status,
          exitCode: result.exitCode,
          stdoutPath: result.stdoutPath,
          stderrPath: result.stderrPath,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
        },
        note: summarizeForNote(message),
      });
    } catch (error) {
      managedJobMonitors.delete(key);
      logger.warn({ err: error, sessionId: ctx.sessionId, jobId }, 'Managed shell job monitor failed');
    }
  };

  const timer = setTimeout(() => void poll(), Math.max(500, delayMs));
  managedJobMonitors.set(key, timer);
};

