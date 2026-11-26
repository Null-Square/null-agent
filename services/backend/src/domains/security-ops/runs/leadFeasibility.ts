/**
 * D14 — a replan should answer new *executable* work, not new work of any kind.
 *
 * Production run r1 had no replan in 3.1 and one in 3.2. It fired because enumeration
 * reported two new routes and three new high-priority leads. That trigger is reasonable in
 * principle; what followed was not. Roughly 414k input tokens, 28k output tokens, 21 tools
 * and several minutes went into introducing validation tasks 3 through 6 — and all four
 * transitioned to blocked together at validation closeout, because their prerequisites
 * (credentials, evaluator-owned accounts) did not exist in that run.
 *
 * The planner spent a plan rebuild giving structure to work that could never run.
 *
 * A lead needing a capability the run does not have is still real and still belongs on the
 * validation queue. It is simply not a reason to restructure the active plan. The separation
 * this module exists to enforce is: **the plan is a stable mission skeleton, the validation
 * queue is the dynamically growing work set.**
 */

export interface RunExecutionCapabilities {
  /** Scope credentials are available to the run. */
  hasCredentials: boolean;
  /** Evaluator-owned accounts exist, which multi-tenant checks need. */
  hasEvaluatorAccounts: boolean;
  /** A private runner can reach internal surfaces. */
  hasPrivateRunner: boolean;
  /** Missing credentials can be created through an authorized public synthetic-account flow. */
  credentialAvailability?: CapabilityAvailability;
  /** Missing evaluator identities can be created safely and cleaned up under the PoC contract. */
  evaluatorAccountAvailability?: CapabilityAvailability;
  privateRunnerAvailability?: CapabilityAvailability;
}

export type CapabilityAvailability = 'available' | 'provisionable' | 'blocked' | 'prohibited';

export const NO_EXECUTION_CAPABILITIES: RunExecutionCapabilities = {
  hasCredentials: false,
  hasEvaluatorAccounts: false,
  hasPrivateRunner: false,
  credentialAvailability: 'blocked',
  evaluatorAccountAvailability: 'blocked',
  privateRunnerAvailability: 'blocked',
};

export type RequiredCapability = 'credentials' | 'evaluator_accounts' | 'private_runner';

export interface FeasibilityLead {
  id?: string;
  priority?: string | null;
  status?: string | null;
  riskFamily?: string | null;
  requiredPrerequisites?: readonly string[] | null;
  requiredControls?: readonly string[] | null;
}

export interface LeadFeasibility {
  actionable: boolean;
  missingCapabilities: RequiredCapability[];
  provisionableCapabilities?: RequiredCapability[];
}

/** Risk families that cannot be demonstrated without an authenticated session. */
const AUTHENTICATED_RISK_FAMILIES = [
  'idor',
  'access-control',
  'authorization',
  'privilege',
  'tenant',
  'broken-object-level',
  'session',
];

/** Risk families that need two distinct principals to prove anything. */
const MULTI_PRINCIPAL_RISK_FAMILIES = ['idor', 'tenant', 'broken-object-level'];

const CREDENTIAL_PHRASES = [
  'credential', 'password', 'api key', 'api-key', 'apikey', 'token', 'login',
  'authenticated', 'authentication', 'sign in', 'sign-in', 'session cookie',
];

const EVALUATOR_ACCOUNT_PHRASES = [
  'evaluator', 'second account', 'two accounts', 'another tenant', 'victim account',
  'test account', 'controlled account',
];

const PRIVATE_RUNNER_PHRASES = [
  'internal network', 'private network', 'vpn', 'private runner', 'internal host',
  'behind the firewall', 'intranet',
];

const normalize = (value: string): string => value.trim().toLowerCase();

const mentions = (haystack: readonly string[], phrases: readonly string[]): boolean =>
  haystack.some((entry) => phrases.some((phrase) => entry.includes(phrase)));

const familyMatches = (riskFamily: string, families: readonly string[]): boolean =>
  families.some((family) => riskFamily.includes(family));

const capabilityAvailability = (
  available: boolean,
  explicit: CapabilityAvailability | undefined,
): CapabilityAvailability => available ? 'available' : (explicit ?? 'blocked');

/**
 * What this lead needs that the run does not have. Empty means the lead is executable now.
 *
 * Deliberately conservative: a lead is only called out when its own text or its risk family
 * says plainly that it needs a capability. Guessing would push real work off the plan.
 */
export const classifyLeadFeasibility = (
  lead: FeasibilityLead,
  capabilities: RunExecutionCapabilities,
): LeadFeasibility => {
  const text = [
    ...(lead.requiredPrerequisites ?? []),
    ...(lead.requiredControls ?? []),
  ].map(normalize);
  const riskFamily = normalize(lead.riskFamily ?? '');
  const missing = new Set<RequiredCapability>();
  const provisionable = new Set<RequiredCapability>();

  const needsCredentials = mentions(text, CREDENTIAL_PHRASES)
    || familyMatches(riskFamily, AUTHENTICATED_RISK_FAMILIES);
  if (needsCredentials) {
    const availability = capabilityAvailability(
      capabilities.hasCredentials,
      capabilities.credentialAvailability,
    );
    if (availability === 'provisionable') provisionable.add('credentials');
    else if (availability !== 'available') missing.add('credentials');
  }

  const needsEvaluatorAccounts = mentions(text, EVALUATOR_ACCOUNT_PHRASES)
    || familyMatches(riskFamily, MULTI_PRINCIPAL_RISK_FAMILIES);
  if (needsEvaluatorAccounts) {
    const availability = capabilityAvailability(
      capabilities.hasEvaluatorAccounts,
      capabilities.evaluatorAccountAvailability,
    );
    if (availability === 'provisionable') provisionable.add('evaluator_accounts');
    else if (availability !== 'available') missing.add('evaluator_accounts');
  }

  if (mentions(text, PRIVATE_RUNNER_PHRASES)) {
    const availability = capabilityAvailability(
      capabilities.hasPrivateRunner,
      capabilities.privateRunnerAvailability,
    );
    if (availability === 'provisionable') provisionable.add('private_runner');
    else if (availability !== 'available') missing.add('private_runner');
  }

  const missingCapabilities = [...missing].sort();
  const provisionableCapabilities = [...provisionable].sort();
  return {
    actionable: missingCapabilities.length === 0,
    missingCapabilities,
    ...(provisionableCapabilities.length > 0 ? { provisionableCapabilities } : {}),
  };
};

export interface LeadFeasibilityPartition {
  /** Leads this run can actually work. Only these may argue for a plan rebuild. */
  actionable: FeasibilityLead[];
  /** Real leads that belong on the queue and not in the plan. */
  needsCapability: Array<FeasibilityLead & { missingCapabilities: RequiredCapability[] }>;
}

export const partitionLeadsByFeasibility = (
  leads: readonly FeasibilityLead[],
  capabilities: RunExecutionCapabilities,
): LeadFeasibilityPartition => {
  const actionable: FeasibilityLead[] = [];
  const needsCapability: LeadFeasibilityPartition['needsCapability'] = [];

  for (const lead of leads) {
    const feasibility = classifyLeadFeasibility(lead, capabilities);
    if (feasibility.actionable) {
      actionable.push(lead);
    } else {
      needsCapability.push({ ...lead, missingCapabilities: feasibility.missingCapabilities });
    }
  }

  return { actionable, needsCapability };
};
