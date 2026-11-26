/**
 * D19 — severity assigned at discovery and inherited without recalibration.
 *
 * In production run r1, recon probed `GET grafana.<customer domain>/api/health`, saw a version
 * string, and immediately filed a **Medium, CVSS 5.3** customer finding: *"Publicly exposed
 * Grafana monitoring panel with version disclosure."* 3.1's final judgement on the same
 * observation was **Info**, explicitly noting no unauthenticated exploitation was
 * demonstrated. 3.2's own finding text still admitted no version-specific exploit, that the
 * login page is merely public, and that exploitation would depend on another vulnerability.
 * It stayed Medium anyway, because nothing downstream recalibrated it.
 *
 * The lifecycle this enforces is: **observation → candidate with provisional severity →
 * validation → final severity.** A severity nobody validated is a claim about what we think,
 * not a claim about what we proved, and it must be labelled and capped as such.
 *
 * Nothing is discarded. The declared severity is always carried alongside the calibrated one,
 * so raising it after validation is a recalculation, not a rediscovery.
 */

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_ORDER: readonly FindingSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

const rank = (severity: FindingSeverity): number => {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index < 0 ? 0 : index;
};

/** The most a finding may claim when nothing has been proven and nothing is evidenced. */
export const UNEVIDENCED_PROVISIONAL_CEILING: FindingSeverity = 'low';

/** The most a finding may claim when it carries evidence but no validation outcome. */
export const EVIDENCED_PROVISIONAL_CEILING: FindingSeverity = 'medium';

export interface SeverityCalibrationInput {
  declaredSeverity: FindingSeverity;
  /** The finding's lifecycle state. Only `confirmed` means validation has spoken. */
  state: string;
  /** True when a validation outcome recorded exploitation, not merely an observation. */
  exploitationDemonstrated?: boolean;
  /** True when the finding carries reproduction steps or a proof artifact. */
  hasProofEvidence?: boolean;
}

export interface CalibratedSeverity {
  /** What the finding may claim to a customer right now. */
  severity: FindingSeverity;
  /** What the discovering phase asked for. Never lost. */
  declaredSeverity: FindingSeverity;
  /** True while the severity rests on judgement rather than a validation outcome. */
  provisional: boolean;
  /** True when the ceiling actually lowered the declared severity. */
  ceilingApplied: boolean;
  ceiling: FindingSeverity | null;
  reason: string;
}

/**
 * The states in which validation has spoken. Deliberately the same three states the risk
 * lifecycle calls reportable — a guard test holds the two together, because a severity ceiling
 * that disagreed with the lifecycle would cap findings the product considers settled.
 */
export const VALIDATED_STATES = new Set(['confirmed', 'resolved', 'accepted']);

/** Reads a stored severity string, or null when it is not one of ours. */
export const asFindingSeverity = (value: string | null | undefined): FindingSeverity | null =>
  typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value)
    ? (value as FindingSeverity)
    : null;

/**
 * Applies the provisional ceiling. Pure, so the same finding calibrates identically wherever
 * it is read — the reporting phase, the customer report and the dashboard cannot disagree.
 */
export const calibrateSeverity = (input: SeverityCalibrationInput): CalibratedSeverity => {
  const declaredSeverity = input.declaredSeverity;

  if (VALIDATED_STATES.has(input.state) || input.exploitationDemonstrated === true) {
    return {
      severity: declaredSeverity,
      declaredSeverity,
      provisional: false,
      ceilingApplied: false,
      ceiling: null,
      reason: input.exploitationDemonstrated === true
        ? 'exploitation was demonstrated, so the severity is a finding about what was proven'
        : `state "${input.state}" means validation has spoken`,
    };
  }

  const ceiling = input.hasProofEvidence === true
    ? EVIDENCED_PROVISIONAL_CEILING
    : UNEVIDENCED_PROVISIONAL_CEILING;
  const capped = rank(declaredSeverity) > rank(ceiling);

  return {
    severity: capped ? ceiling : declaredSeverity,
    declaredSeverity,
    provisional: true,
    ceilingApplied: capped,
    ceiling,
    reason: capped
      ? `no validation outcome and ${input.hasProofEvidence === true ? 'evidence but no demonstrated exploitation' : 'no proof evidence'}, so "${declaredSeverity}" is capped at "${ceiling}" until validation raises it`
      : 'the declared severity is already within what an unvalidated finding may claim',
  };
};

/** How a provisional severity should read to a human, so the cap is never silent. */
export const describeCalibration = (calibration: CalibratedSeverity): string => {
  if (!calibration.provisional) return calibration.severity;
  return calibration.ceilingApplied
    ? `${calibration.severity} (provisional; ${calibration.declaredSeverity} claimed, awaiting validation)`
    : `${calibration.severity} (provisional; awaiting validation)`;
};

/**
 * D20 — the reporting phase may organize evidence and write customer language. It may not
 * decide that something is worse than the phase that validated it decided.
 *
 * Returns a refusal message when the write would raise severity, or null when it would not.
 */
export const findReportingSeverityEscalation = (input: {
  existingSeverity: string | null | undefined;
  requestedSeverity: string | null | undefined;
}): string | null => {
  const existing = input.existingSeverity as FindingSeverity | null | undefined;
  const requested = input.requestedSeverity as FindingSeverity | null | undefined;
  if (!existing || !requested) return null;
  if (!SEVERITY_ORDER.includes(existing) || !SEVERITY_ORDER.includes(requested)) return null;
  if (rank(requested) <= rank(existing)) return null;

  return `report_finding cannot raise severity from "${existing}" to "${requested}" in the `
    + 'reporting phase. Reporting organizes evidence and writes customer language; raising '
    + 'severity is a validation outcome. Call submit_validation_outcome with the evidence that '
    + 'justifies it, or report the finding at the severity validation gave it.';
};

/**
 * D25 — an impact claim must be supported by the evidence the finding actually carries.
 *
 * The r1 CORS finding's lifecycle state was honest: it stayed `verifying` and never reached
 * confirmed, because the validation gate demanded a real browser exchange and the browser run
 * was inconclusive. Its prose was not. It asserted that an attacker-controlled sibling
 * subdomain using `credentials: include` causes the browser to send the victim's **bearer
 * token** and session cookie.
 *
 * The bearer half is unsupported and technically wrong. If the access token lives in
 * `localStorage` on `app.example.com`, script on `evil.example.com` cannot read it — browser
 * storage is origin-scoped — and `credentials: 'include'` does not turn another origin's
 * `localStorage` token into an `Authorization` header. The cookie half may hold, depending on
 * cookie domain and SameSite. They are different claims and needed separate proof.
 *
 * The agent discovered this through browser testing, which is why the outcome stayed
 * inconclusive. Only the prose failed to follow the evidence.
 */
export interface ImpactClaimMechanism {
  /** The mechanism a claim rests on, e.g. `bearer_token_exfiltration`. */
  id: string;
  /** Phrases in the finding's prose that assert this mechanism. */
  phrases: readonly string[];
  /** Phrases in the evidence that would support it. */
  supportingEvidencePhrases: readonly string[];
  /** What to say when it is asserted without support. */
  refusal: string;
}

export const IMPACT_CLAIM_MECHANISMS: readonly ImpactClaimMechanism[] = [
  {
    id: 'bearer_token_exfiltration',
    phrases: ['bearer token', 'authorization header', 'access token is sent', 'sends the token'],
    supportingEvidencePhrases: ['authorization: bearer', 'authorization header observed', 'token in request'],
    refusal:
      'The finding asserts a bearer token is sent cross-origin. Browser storage is '
      + 'origin-scoped and `credentials: include` does not attach another origin\'s stored '
      + 'token, so this needs an observed Authorization header in the evidence. Attach that '
      + 'exchange or state the cookie-only impact.',
  },
  {
    id: 'session_cookie_exfiltration',
    phrases: ['session cookie is sent', 'victim\'s session cookie', 'cookies are sent'],
    supportingEvidencePhrases: ['set-cookie', 'cookie:', 'samesite', 'withcredentials'],
    refusal:
      'The finding asserts the victim\'s session cookie is sent cross-origin. That depends on '
      + 'the cookie\'s domain and SameSite attributes, so it needs an observed exchange or the '
      + 'cookie attributes in the evidence.',
  },
  {
    id: 'account_takeover',
    phrases: ['account takeover', 'full account compromise', 'take over the account'],
    supportingEvidencePhrases: ['authenticated as', 'session established', 'logged in as'],
    refusal:
      'The finding asserts account takeover. That is a demonstrated outcome, not an inferred '
      + 'one, so it needs evidence of an authenticated session obtained through the issue.',
  },
];

export interface UnsupportedImpactClaim {
  mechanism: string;
  refusal: string;
}

/**
 * Renders structured evidence as the `key: value` text the phrase checks read.
 *
 * Evidence is usually a captured HTTP exchange, not prose. Serialising it as JSON puts
 * `"authorization":"Bearer ..."` in front of a check looking for `authorization: bearer`, so
 * a finding that carries exactly the proof it needs reads as unsupported. That failure is
 * the expensive direction: it accuses a correct finding.
 */
export const flattenEvidenceText = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (depth > 8) return '';
  if (Array.isArray(value)) {
    return value.map((entry) => flattenEvidenceText(entry, depth + 1)).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const rendered = flattenEvidenceText(entry, depth + 1);
        if (rendered === '') return key;
        return rendered.includes('\n') ? `${key}\n${rendered}` : `${key}: ${rendered}`;
      })
      .join('\n');
  }
  return '';
};

const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

/**
 * Finds impact claims the finding's own evidence does not support. Pure and conservative: a
 * mechanism is only flagged when the prose plainly asserts it and nothing in the evidence
 * plainly supports it. A finding whose validation demonstrated exploitation is not second
 * guessed.
 */
export const findUnsupportedImpactClaims = (input: {
  prose: readonly (string | null | undefined)[];
  evidence: readonly (string | null | undefined)[];
  exploitationDemonstrated?: boolean;
}): UnsupportedImpactClaim[] => {
  if (input.exploitationDemonstrated === true) return [];

  const prose = input.prose
    .filter((entry): entry is string => typeof entry === 'string')
    .join(' \n ')
    .toLowerCase();
  const evidence = input.evidence
    .filter((entry): entry is string => typeof entry === 'string')
    .join(' \n ')
    .toLowerCase();

  return IMPACT_CLAIM_MECHANISMS
    .filter((mechanism) => containsAny(prose, mechanism.phrases)
      && !containsAny(evidence, mechanism.supportingEvidencePhrases))
    .map((mechanism) => ({ mechanism: mechanism.id, refusal: mechanism.refusal }));
};

/**
 * What the report boundary needs to know about one finding's severity and claims.
 *
 * Both checks live here so the answer is a pure function of the row: the preflight, the
 * report context and anything else that reads a finding cannot reach different conclusions
 * about whether a severity is provisional.
 */
export interface FindingReportSeverityProjection {
  /** What the report should say. Equal to the declared severity unless a ceiling applied. */
  severityForReport: string;
  /** The same value written for a human, carrying the claim it was capped from. */
  severityLabel: string;
  calibration: CalibratedSeverity | null;
  unsupportedImpactClaims: UnsupportedImpactClaim[];
}

export const projectFindingForReport = (input: {
  severity: string | null | undefined;
  state: string;
  hasDurableEvidence: boolean;
  prose: readonly (string | null | undefined)[];
  evidence: readonly (string | null | undefined)[];
}): FindingReportSeverityProjection => {
  const declaredSeverity = asFindingSeverity(input.severity);
  const validated = VALIDATED_STATES.has(input.state);
  const calibration = declaredSeverity === null
    ? null
    : calibrateSeverity({
      declaredSeverity,
      state: input.state,
      hasProofEvidence: input.hasDurableEvidence,
    });

  return {
    severityForReport: calibration?.severity ?? (input.severity ?? 'info'),
    severityLabel: calibration ? describeCalibration(calibration) : (input.severity ?? 'info'),
    calibration,
    unsupportedImpactClaims: findUnsupportedImpactClaims({
      prose: input.prose,
      evidence: input.evidence,
      exploitationDemonstrated: validated,
    }),
  };
};
