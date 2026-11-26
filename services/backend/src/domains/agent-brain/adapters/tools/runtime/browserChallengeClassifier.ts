import type { BrowserConsoleEntry, BrowserNetworkEntry } from './browserSessionManager';

export type BrowserChallengeKind =
  | 'cloudflare_challenge'
  | 'radware_challenge'
  | 'akamai_challenge'
  | 'turnstile_or_captcha'
  | 'generic_bot_management'
  | 'login_wall'
  | 'auth_post_blocked'
  | 'waf_block'
  | 'network_block'
  | 'unknown_challenge';

export type BrowserChallengeBlockingStage =
  | 'render'
  | 'navigation'
  | 'form_submit'
  | 'xhr_fetch'
  | 'authentication'
  | 'network'
  | 'unknown';

export type BrowserChallengeClassification = {
  kind: BrowserChallengeKind;
  confidence: 'low' | 'medium' | 'high';
  blocking_stage: BrowserChallengeBlockingStage;
  evidence_summary: string;
  recommended_authorized_path: string;
  retryable: boolean;
};

export type BrowserChallengeClassifierInput = {
  url?: string;
  title?: string;
  text?: string;
  source?: string;
  console?: BrowserConsoleEntry[];
  network?: BrowserNetworkEntry[];
};

const includesAny = (haystack: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(haystack));

const recommendedPath = (kind: BrowserChallengeKind): string => {
  switch (kind) {
    case 'login_wall':
      return 'Provide authorized test credentials, session cookies, or a browser storage-state handoff for this scoped target.';
    case 'auth_post_blocked':
      return 'Use customer-approved credentials/session state or a private runner from an allowlisted network before retrying authenticated POST flows.';
    case 'network_block':
      return 'Confirm target availability and route this assessment through an authorized private runner if the surface is private or allowlisted.';
    default:
      return 'Use an authorized path such as test-account cookies, browser storage state, IP allowlisting, or a private runner; do not attempt generic challenge evasion.';
  }
};

const classifyStage = (kind: BrowserChallengeKind, network: BrowserNetworkEntry[]): BrowserChallengeBlockingStage => {
  if (kind === 'login_wall') return 'authentication';
  if (kind === 'network_block') return 'network';
  if (kind === 'auth_post_blocked') return 'form_submit';
  const blockedPost = network.some((entry) => entry.method.toUpperCase() === 'POST' && [401, 403, 429].includes(entry.status ?? 0));
  if (blockedPost) return 'form_submit';
  const blockedFetch = network.some((entry) => ['xhr', 'fetch'].includes(entry.resourceType) && [401, 403, 429].includes(entry.status ?? 0));
  if (blockedFetch) return 'xhr_fetch';
  return 'render';
};

const summarize = (kind: BrowserChallengeKind, evidence: string[]): string =>
  `${kind}: ${evidence.slice(0, 4).join('; ') || 'challenge indicators detected'}`;

export const classifyBrowserChallenge = (
  input: BrowserChallengeClassifierInput,
): BrowserChallengeClassification | null => {
  const url = input.url ?? '';
  const title = input.title ?? '';
  const text = input.text ?? '';
  const source = input.source ?? '';
  const consoleText = (input.console ?? []).map((entry) => `${entry.type}: ${entry.text}`).join('\n');
  const network = input.network ?? [];
  const combined = [url, title, text, source, consoleText].join('\n').toLowerCase();
  const evidence: string[] = [];

  const networkBlocked = network.find((entry) => entry.failureText || entry.status === 0);
  if (networkBlocked) {
    evidence.push(`${networkBlocked.method} ${networkBlocked.url} failed: ${networkBlocked.failureText ?? 'network failure'}`);
    const kind: BrowserChallengeKind = 'network_block';
    return {
      kind,
      confidence: 'medium',
      blocking_stage: classifyStage(kind, network),
      evidence_summary: summarize(kind, evidence),
      recommended_authorized_path: recommendedPath(kind),
      retryable: false,
    };
  }

  const authBlockedPost = network.find(
    (entry) => entry.method.toUpperCase() === 'POST' && [401, 403, 429].includes(entry.status ?? 0),
  );
  if (authBlockedPost) {
    evidence.push(`${authBlockedPost.method} ${authBlockedPost.url} returned ${authBlockedPost.status}`);
    const kind: BrowserChallengeKind = 'auth_post_blocked';
    return {
      kind,
      confidence: 'medium',
      blocking_stage: classifyStage(kind, network),
      evidence_summary: summarize(kind, evidence),
      recommended_authorized_path: recommendedPath(kind),
      retryable: false,
    };
  }

  const candidates: Array<{
    kind: BrowserChallengeKind;
    confidence: BrowserChallengeClassification['confidence'];
    patterns: RegExp[];
    evidence: string;
  }> = [
    {
      kind: 'cloudflare_challenge',
      confidence: 'high',
      patterns: [
        /\bcloudflare\b/u,
        /\bcf-chl\b/u,
        /\bchecking your browser\b/u,
        /\bverify you are human\b/u,
        /\/cdn-cgi\/challenge-platform\//u,
      ],
      evidence: 'Cloudflare challenge markers in rendered page or URL',
    },
    {
      kind: 'radware_challenge',
      confidence: 'high',
      patterns: [/\bradware\b/u, /\bperimeterx\b/u, /\bbot manager\b/u, /\bprotected by radware\b/u],
      evidence: 'Radware or bot-manager challenge markers in rendered page',
    },
    {
      kind: 'akamai_challenge',
      confidence: 'high',
      patterns: [/\bakamai\b/u, /\babck\b/u, /\bbm_sz\b/u, /\bak_bmsc\b/u],
      evidence: 'Akamai bot-management markers in rendered page or cookies/scripts',
    },
    {
      kind: 'turnstile_or_captcha',
      confidence: 'high',
      patterns: [/\bturnstile\b/u, /\bcaptcha\b/u, /\brecaptcha\b/u, /\bhcaptcha\b/u, /\bdata-sitekey\b/u],
      evidence: 'Human-verification challenge markers in rendered page',
    },
    {
      kind: 'waf_block',
      confidence: 'medium',
      patterns: [/\bwaf\b/u, /\bweb application firewall\b/u, /\baccess denied\b/u, /\brequest blocked\b/u],
      evidence: 'WAF or access-denied language in rendered page',
    },
    {
      kind: 'login_wall',
      confidence: 'medium',
      patterns: [/\bsign in\b/u, /\blog in\b/u, /\bauthentication required\b/u, /\bplease authenticate\b/u],
      evidence: 'Login-wall language in rendered page',
    },
    {
      kind: 'generic_bot_management',
      confidence: 'medium',
      patterns: [/\bbot detection\b/u, /\bautomated traffic\b/u, /\bunusual traffic\b/u, /\bsecurity check\b/u],
      evidence: 'Generic bot-management language in rendered page',
    },
  ];

  for (const candidate of candidates) {
    if (!includesAny(combined, candidate.patterns)) {
      continue;
    }
    evidence.push(candidate.evidence);
    return {
      kind: candidate.kind,
      confidence: candidate.confidence,
      blocking_stage: classifyStage(candidate.kind, network),
      evidence_summary: summarize(candidate.kind, evidence),
      recommended_authorized_path: recommendedPath(candidate.kind),
      retryable: candidate.kind === 'login_wall',
    };
  }

  const protectedStatus = network.find((entry) => [401, 403, 429, 503].includes(entry.status ?? 0));
  if (protectedStatus) {
    evidence.push(`${protectedStatus.method} ${protectedStatus.url} returned ${protectedStatus.status}`);
    const kind: BrowserChallengeKind = protectedStatus.status === 401 ? 'login_wall' : 'unknown_challenge';
    return {
      kind,
      confidence: 'low',
      blocking_stage: classifyStage(kind, network),
      evidence_summary: summarize(kind, evidence),
      recommended_authorized_path: recommendedPath(kind),
      retryable: false,
    };
  }

  return null;
};
