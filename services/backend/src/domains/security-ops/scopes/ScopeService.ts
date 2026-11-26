import { eq, and, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import type { DatabaseClient } from '@/db/client';
import {
  checkDnsTxt,
  checkHttpWellKnown,
  isLabTarget,
  type VerificationReason,
} from './verificationChecks';
import {
  scopes,
  scopeExclusions,
  scopeTargets,
  runnerScopeAssignments,
  runners,
  type ScopeRow,
  type NewScopeRow,
  type ScopeTargetRow,
} from '@/db/schema';
import {
  ScopeAccessMaterialService,
  type ScopeAccessMaterialContextEntry,
} from './ScopeAccessMaterialService';
import {
  deriveTestingPosture,
  type TestingPosture,
} from './testingPosture';
import {
  isPrivateIpv4CidrTarget,
  isValidIpv4Cidr,
  parseIpv4Address,
} from './networkTargetPolicy';
import {
  buildScopeDomainBoundaryConflictMessage,
  findScopeDomainBoundaryConflict,
  isStrictSubdomainOfTarget,
} from './scopeTargetBoundary';
import type { ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
import {
  connectedRepositoryOf,
  createDrizzleCodeSourceStore,
  toPublicCodeSource,
  type CodeSourceStore,
  type PublicCodeSource,
} from '@/domains/security-ops/code-sources/CodeSourceService';
import { scopeVerificationGate } from './securityOpsScopeVerificationGate';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { decideScopeNamespace } from './scopeBoundaryPolicy';

export {
  isCloudBlockedIpv4CidrTarget,
  isIpv4InCidr,
  isPrivateIpv4CidrTarget,
  isValidIpv4Cidr,
} from './networkTargetPolicy';

// ============================================================================
// Types
// ============================================================================

export type ImpactTolerance = 'non_destructive' | 'poc' | 'full';

export interface ScopeEngagementBriefInput {
  mission?: string | null;
  impactTolerance?: ImpactTolerance;
  complianceFrameworks?: ComplianceFrameworkKey[] | null;
}

export interface CreateScopeInput extends ScopeEngagementBriefInput {
  name: string;
}

export interface UpdateScopeInput extends ScopeEngagementBriefInput {
  name?: string;
  status?: string;
}

export type ScopeTargetType = 'domain' | 'cidr';
export type ScopeTargetVerificationMethod =
  | 'dns_txt'
  | 'http_well_known'
  | 'manual_review'
  | 'none'
  | 'legacy_auto'
  | 'connected_site'
  | 'wordpress_plugin'
  | 'lab';

export interface AddTargetInput {
  type: ScopeTargetType;
  value: string;
  verificationMethod?: ScopeTargetVerificationMethod;
}

export interface ScopeDetail {
  scope: ScopeWithSummary;
  targets: ScopeTargetRow[];
  exclusions: Array<{ id: string; type: 'domain' | 'cidr'; value: string; createdAt: Date }>;
}

export interface ScopeSummary {
  whiteboxEnabled: boolean;
  connectedRepoCount: number;
  /** Where the scope's code comes from (a folder or a git URL), or null. */
  codeSource: PublicCodeSource | null;
  accessMaterialCount: number;
  targetCount: number;
  verifiedTargetCount: number;
  attachedRunner: ScopeAttachedRunnerSummary | null;
}

export type ScopeWithSummary = ScopeRow & ScopeSummary;

export interface ScopeAttachedRunnerSummary {
  id: string;
  name: string;
  status: string;
  type: string;
  metadata?: Record<string, string> | null;
}

export interface ScopeConnectedRepository {
  id: string;
  fullName: string;
  defaultBranch: string | null;
  ownerLogin: string;
  name: string;
  htmlUrl: string;
}

export interface ScopeContext {
  name: string;
  executionNetwork: 'external' | 'internal';
  attachedRunner: ScopeAttachedRunnerSummary | null;
  targets: Array<{ type: string; value: string; verified: boolean }>;
  exclusions: Array<{ type: 'domain' | 'cidr'; value: string }>;
  mission: string | null;
  impactTolerance: ImpactTolerance;
  complianceFrameworks: ComplianceFrameworkKey[];
  testingPosture: TestingPosture;
  testingPostureReason: string;
  whiteboxEnabled: boolean;
  connectedRepoCount: number;
  connectedRepositories: ScopeConnectedRepository[];
  accessMaterialCount: number;
  accessMaterials: ScopeAccessMaterialContextEntry[];
}

export interface VerificationResult {
  verified: boolean;
  message: string;
  /** Categorized outcome so the UI can guide the user (e.g. keep polling vs fix value). */
  reason?: VerificationReason;
}

export interface VerificationStatus {
  targetId: string;
  type: string;
  value: string;
  verified: boolean;
  verificationMethod: string | null;
  verificationToken: string | null;
  verifiedAt: Date | null;
}

type TargetAuthorizationResolution = {
  autoVerified: boolean;
  verifiedByTargetValue?: string;
};

const DOMAIN_LABEL_REGEX = /^[a-z0-9-]{1,63}$/;

export const isValidDomainTarget = (value: string): boolean => {
  if (!value || value.length > 253 || !value.includes('.')) {
    return false;
  }

  const labels = value.split('.');
  if (labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) {
    return false;
  }

  return labels.every((label) => DOMAIN_LABEL_REGEX.test(label));
};

// Strip protocol, www prefix, and trailing slashes/paths so users can paste
// a URL or www-prefixed domain and still get a correct apex domain stored.
// Examples:
//   "https://www.adu.ac.ae"  → "adu.ac.ae"
//   "www.example.com"        → "example.com"
//   "http://example.com/"    → "example.com"
//   "192.168.1.0/24"         → "192.168.1.0/24"  (CIDRs pass through unchanged)
export const normalizeScopeTargetValue = (type: 'domain' | 'cidr', value: string): string => {
  const trimmed = value.toLowerCase().trim();
  if (type !== 'domain') {
    const normalizedIp = parseIpv4Address(trimmed);
    if (normalizedIp !== null && !trimmed.includes('/')) {
      return `${trimmed}/32`;
    }
    return trimmed;
  }
  // Strip protocol
  let domain = trimmed.replace(/^https?:\/\//, '');
  // Strip path, query, fragment (keep only the hostname portion)
  domain = domain.split('/')[0].split('?')[0].split('#')[0];
  // Strip port
  domain = domain.split(':')[0];
  // Strip www. prefix
  if (domain.startsWith('www.')) {
    domain = domain.slice(4);
  }
  return domain;
};

const resolveVerificationMethod = (
  type: ScopeTargetType,
  normalizedValue: string,
  requested?: ScopeTargetVerificationMethod,
): ScopeTargetVerificationMethod => {
  if (type === 'cidr') {
    if (isPrivateIpv4CidrTarget(normalizedValue)) {
      if (!requested || requested === 'manual_review' || requested === 'none') {
        return 'none';
      }

      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'Private CIDR targets do not use DNS or HTTP ownership verification.',
      );
    }

    if (!requested || requested === 'manual_review') {
      return 'manual_review';
    }

    throw new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      'Public CIDR targets only support manual review verification.',
    );
  }

  if (!requested) {
    return 'dns_txt';
  }

  if (
    requested === 'dns_txt' ||
    requested === 'http_well_known'
  ) {
    return requested;
  }

  throw new AppError(
    ERROR_CODES.VALIDATION_INVALID_FORMAT,
    'Domain targets support dns_txt or http_well_known verification.',
  );
};

// ============================================================================
// Service
// ============================================================================

export class ScopeService {
  private readonly accessMaterialService: ScopeAccessMaterialService;
  private readonly codeSourceStore: CodeSourceStore;

  constructor(private readonly db: DatabaseClient) {
    this.accessMaterialService = new ScopeAccessMaterialService(db);
    this.codeSourceStore = createDrizzleCodeSourceStore(db);
  }

  async list(orgId: string): Promise<ScopeWithSummary[]> {
    const rows = await this.db
      .select()
      .from(scopes)
      .where(eq(scopes.organizationId, orgId))
      .orderBy(scopes.createdAt);

    const summaries = await this.getScopeSummaryMap(rows.map((row) => row.id));
    return rows.map((row) => this.withScopeSummary(row, summaries.get(row.id)));
  }

  async countActive(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(scopes)
      .where(and(eq(scopes.organizationId, orgId), eq(scopes.status, 'active')));

    return Number(row?.count ?? 0);
  }

  async create(orgId: string, input: CreateScopeInput): Promise<ScopeWithSummary> {
    const [scope] = await this.db
      .insert(scopes)
      .values({
        organizationId: orgId,
        name: input.name,
        executionNetwork: 'external',
        mission: input.mission ?? null,
        impactTolerance: input.impactTolerance ?? 'poc',
        complianceFrameworks: input.complianceFrameworks ?? [],
      } satisfies Partial<NewScopeRow> as NewScopeRow)
      .returning();

    return this.withScopeSummary(scope);
  }

  async getById(orgId: string, scopeId: string): Promise<ScopeDetail> {
    const [scope] = await this.db
      .select()
      .from(scopes)
      .where(and(eq(scopes.id, scopeId), eq(scopes.organizationId, orgId)))
      .limit(1);

    if (!scope) {
      throw new Error('Scope not found');
    }

    const targets = await this.db
      .select()
      .from(scopeTargets)
      .where(eq(scopeTargets.scopeId, scopeId));

    const exclusions = await this.db
      .select({
        id: scopeExclusions.id,
        type: scopeExclusions.type,
        value: scopeExclusions.value,
        createdAt: scopeExclusions.createdAt,
      })
      .from(scopeExclusions)
      .where(eq(scopeExclusions.scopeId, scopeId));

    return {
      scope: this.withScopeSummary(scope, await this.getScopeSummary(scope.id)),
      targets,
      exclusions: exclusions.map((exclusion) => ({
        ...exclusion,
        type: exclusion.type as 'domain' | 'cidr',
      })),
    };
  }

  async update(orgId: string, scopeId: string, updates: UpdateScopeInput): Promise<ScopeWithSummary> {
    const { complianceFrameworks, ...rest } = updates;
    const normalizedUpdates = {
      ...rest,
      ...(complianceFrameworks !== undefined && {
        complianceFrameworks: complianceFrameworks ?? [],
      }),
    };
    const [updated] = await this.db
      .update(scopes)
      .set({ ...normalizedUpdates, updatedAt: new Date() })
      .where(and(eq(scopes.id, scopeId), eq(scopes.organizationId, orgId)))
      .returning();

    if (!updated) {
      throw new Error('Scope not found');
    }

    return this.withScopeSummary(updated, await this.getScopeSummary(updated.id));
  }

  async archive(orgId: string, scopeId: string): Promise<void> {
    await this.update(orgId, scopeId, { status: 'archived' });
  }

  // ---- Targets ----

  async addTarget(scopeId: string, input: AddTargetInput): Promise<ScopeTargetRow> {
    const normalizedValue = normalizeScopeTargetValue(input.type, input.value);

    if (input.type === 'domain') {
      if (!isValidDomainTarget(normalizedValue)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_INVALID_FORMAT,
          'Domain targets must be a valid hostname like example.com or api.example.com.',
        );
      }
    } else if (!isValidIpv4Cidr(normalizedValue)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'CIDR targets must be valid IPv4 CIDR ranges like 192.168.1.0/24 or single IPs like 192.168.1.10.',
      );
    }

    const authorization = await this.resolveTargetAuthorization(scopeId, {
      type: input.type,
      value: normalizedValue,
    });

    const verificationMethod = authorization.autoVerified
      ? 'none'
      : resolveVerificationMethod(input.type, normalizedValue, input.verificationMethod);
    const token = input.type === 'domain' && !authorization.autoVerified
      ? randomBytes(16).toString('hex')
      : undefined;
    const privateCidrAutoVerified = input.type === 'cidr' && isPrivateIpv4CidrTarget(normalizedValue);
    const autoVerified = authorization.autoVerified || privateCidrAutoVerified;

    const [target] = await this.db
      .insert(scopeTargets)
      .values({
        scopeId,
        type: input.type,
        value: normalizedValue,
        verified: autoVerified,
        verificationMethod,
        verificationToken: token,
        verifiedAt: autoVerified ? new Date() : null,
      })
      .returning();

    return target;
  }

  private async resolveTargetAuthorization(
    scopeId: string,
    candidate: { type: ScopeTargetType; value: string },
  ): Promise<TargetAuthorizationResolution> {
    const existingTargets = await this.db
      .select({
        type: scopeTargets.type,
        value: scopeTargets.value,
        verified: scopeTargets.verified,
        verificationMethod: scopeTargets.verificationMethod,
      })
      .from(scopeTargets)
      .where(eq(scopeTargets.scopeId, scopeId));

    const conflict = findScopeDomainBoundaryConflict([
      ...existingTargets,
      candidate,
    ]);

    if (!conflict) {
      if (candidate.type !== 'domain') {
        return { autoVerified: false };
      }

      const domainTargets = existingTargets
        .filter((target) => target.type === 'domain')
        .sort((left, right) => right.value.length - left.value.length);
      const parentTarget = domainTargets.find((target) =>
        isStrictSubdomainOfTarget(candidate.value, target.value),
      );

      if (parentTarget) {
        if (!parentTarget.verified) {
          throw new AppError(
            ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            `Verify ${parentTarget.value} before adding subdomains under it.`,
            {
              context: {
                parentTarget: parentTarget.value,
                receivedTarget: candidate.value,
              },
            },
          );
        }

        // A practice target proves only its own host, so a subdomain under it proves itself.
        if (parentTarget.verificationMethod === 'lab') {
          return { autoVerified: false };
        }

        return {
          autoVerified: true,
          verifiedByTargetValue: parentTarget.value,
        };
      }

      const hasSiblingDomainInBoundary = domainTargets.some((target) =>
        findScopeDomainBoundaryConflict([
          target,
          candidate,
        ]) === null &&
        !isStrictSubdomainOfTarget(target.value, candidate.value) &&
        target.value !== candidate.value,
      );

      if (hasSiblingDomainInBoundary) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          `Add and verify the root domain before adding sibling subdomains like ${candidate.value}.`,
          {
            context: {
              receivedTarget: candidate.value,
            },
          },
        );
      }

      return { autoVerified: false };
    }

    throw new AppError(
      ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      buildScopeDomainBoundaryConflictMessage(conflict),
      {
        context: {
          expectedBoundary: conflict.expected.boundary,
          existingTarget: conflict.expected.value,
          receivedBoundary: conflict.received.boundary,
          receivedTarget: conflict.received.value,
        },
      },
    );
  }

  async removeTarget(scopeId: string, targetId: string): Promise<void> {
    await this.db
      .delete(scopeTargets)
      .where(and(eq(scopeTargets.id, targetId), eq(scopeTargets.scopeId, scopeId)));
    // Removing the last verified target revokes the scope's authorization to do
    // metered work; drop the cached allow so the next turn re-checks the DB.
    scopeVerificationGate.invalidate(scopeId);
  }

  async verifyTarget(
    scopeId: string,
    targetId: string,
    requestedMethod?: ScopeTargetVerificationMethod,
  ): Promise<VerificationResult> {
    const [target] = await this.db
      .select()
      .from(scopeTargets)
      .where(and(eq(scopeTargets.id, targetId), eq(scopeTargets.scopeId, scopeId)))
      .limit(1);

    if (!target) {
      throw new Error('Target not found');
    }

    if (target.verified) {
      return { verified: true, message: 'Already verified' };
    }

    if (target.type === 'cidr' && isPrivateIpv4CidrTarget(target.value)) {
      await this.db
        .update(scopeTargets)
        .set({ verified: true, verificationMethod: 'none', verifiedAt: new Date() })
        .where(eq(scopeTargets.id, targetId));

      return {
        verified: true,
        message: 'Private CIDR targets do not require ownership verification. Use an attached private runner for assessment.',
      };
    }

    if (target.type === 'cidr' || target.verificationMethod === 'manual_review') {
      return {
        verified: false,
        message: 'Public CIDR targets require admin review approval before runs can start.',
      };
    }

    // A practice target named exactly in NULL_AI_LAB_TARGETS has no zone or web root to prove
    // ownership on; the person's naming it is the proof. Only that exact host, not its subdomains.
    if (target.type === 'domain' && isLabTarget(target.value)) {
      await this.markTargetVerified(targetId, 'lab');
      return {
        verified: true,
        message: `${target.value} is a practice target named in NULL_AI_LAB_TARGETS.`,
        reason: 'verified',
      };
    }

    // Domain targets accept DNS TXT or HTTP well-known. The same token verifies
    // via either path, so honor the method the user picked in the UI and fall
    // back to the target's stored method.
    const method: ScopeTargetVerificationMethod =
      requestedMethod === 'http_well_known' || requestedMethod === 'dns_txt'
        ? requestedMethod
        : target.verificationMethod === 'http_well_known'
          ? 'http_well_known'
          : 'dns_txt';

    return method === 'http_well_known'
      ? this.verifyHttpWellKnownTarget(scopeId, target.id, target.value, target.verificationToken)
      : this.verifyDnsTxtTarget(scopeId, target.id, target.value, target.verificationToken);
  }

  /**
   * Testing-only override: mark a target as verified without DNS validation.
   * Intended for local/dev workflows to unblock end-to-end testing.
   */
  async autoVerifyTarget(scopeId: string, targetId: string): Promise<VerificationResult> {
    const [target] = await this.db
      .select()
      .from(scopeTargets)
      .where(and(eq(scopeTargets.id, targetId), eq(scopeTargets.scopeId, scopeId)))
      .limit(1);

    if (!target) {
      throw new Error('Target not found');
    }

    if (target.verified) {
      return { verified: true, message: 'Already verified' };
    }

    await this.db
      .update(scopeTargets)
      .set({ verified: true, verifiedAt: new Date() })
      .where(eq(scopeTargets.id, targetId));

    return { verified: true, message: 'Target auto-verified (testing override)' };
  }

  async approveTargetVerification(
    scopeId: string,
    targetId: string,
    options: { force?: boolean } = {},
  ): Promise<VerificationResult> {
    const [target] = await this.db
      .select()
      .from(scopeTargets)
      .where(and(eq(scopeTargets.id, targetId), eq(scopeTargets.scopeId, scopeId)))
      .limit(1);

    if (!target) {
      throw new Error('Target not found');
    }

    if (target.verified) {
      return { verified: true, message: 'Already verified' };
    }

    if (target.verificationMethod !== 'manual_review' && !options.force) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'Only manual review targets can be approved from the admin review surface.',
      );
    }

    await this.db
      .update(scopeTargets)
      .set({ verified: true, verifiedAt: new Date() })
      .where(eq(scopeTargets.id, targetId));

    if (target.type === 'domain') {
      await this.markDescendantDomainTargetsVerified(scopeId, target.value);
    }

    return {
      verified: true,
      message: options.force
        ? 'Target force-approved through admin review.'
        : 'Target approved through manual review.',
    };
  }

  async checkVerificationStatus(scopeId: string, targetId: string): Promise<VerificationStatus> {
    const [target] = await this.db
      .select()
      .from(scopeTargets)
      .where(and(eq(scopeTargets.id, targetId), eq(scopeTargets.scopeId, scopeId)))
      .limit(1);

    if (!target) {
      throw new Error('Target not found');
    }

    return {
      targetId: target.id,
      type: target.type,
      value: target.value,
      verified: target.verified,
      verificationMethod: target.verificationMethod ?? null,
      verificationToken: target.verificationToken ?? null,
      verifiedAt: target.verifiedAt ?? null,
    };
  }

  private async verifyDnsTxtTarget(
    scopeId: string,
    targetId: string,
    value: string,
    verificationToken: string | null,
  ): Promise<VerificationResult> {
    const check = await checkDnsTxt(value, verificationToken);
    if (check.verified) {
      await this.markTargetVerified(targetId, 'dns_txt', {
        scopeId,
        domainValue: value,
      });
    }
    return { verified: check.verified, message: check.message, reason: check.reason };
  }

  private async verifyHttpWellKnownTarget(
    scopeId: string,
    targetId: string,
    value: string,
    verificationToken: string | null,
  ): Promise<VerificationResult> {
    const check = await checkHttpWellKnown(value, verificationToken);
    if (check.verified) {
      await this.markTargetVerified(targetId, 'http_well_known', {
        scopeId,
        domainValue: value,
      });
    }
    return { verified: check.verified, message: check.message, reason: check.reason };
  }

  // Persist the method that actually succeeded so the stored record reflects
  // how the target was verified (the user may have switched DNS↔HTTP in the UI).
  private async markTargetVerified(
    targetId: string,
    method: ScopeTargetVerificationMethod,
    options?: { scopeId?: string; domainValue?: string },
  ): Promise<void> {
    await this.db
      .update(scopeTargets)
      .set({ verified: true, verifiedAt: new Date(), verificationMethod: method })
      .where(eq(scopeTargets.id, targetId));

    if (options?.scopeId && options.domainValue) {
      await this.markDescendantDomainTargetsVerified(options.scopeId, options.domainValue);
    }
  }

  private async markDescendantDomainTargetsVerified(
    scopeId: string,
    parentDomain: string,
  ): Promise<void> {
    const pendingTargets = await this.db
      .select({
        id: scopeTargets.id,
        value: scopeTargets.value,
      })
      .from(scopeTargets)
      .where(and(
        eq(scopeTargets.scopeId, scopeId),
        eq(scopeTargets.type, 'domain'),
        eq(scopeTargets.verified, false),
      ));

    const descendants = pendingTargets.filter((target) =>
      isStrictSubdomainOfTarget(target.value, parentDomain),
    );

    const verifiedAt = new Date();
    for (const descendant of descendants) {
      await this.db
        .update(scopeTargets)
        .set({
          verified: true,
          verifiedAt,
          verificationMethod: 'none',
          verificationToken: null,
        })
        .where(eq(scopeTargets.id, descendant.id));
    }
  }

  // ---- Context for agent prompt ----

  async getScopeContext(scopeId: string): Promise<ScopeContext> {
    const [scope] = await this.db
      .select()
      .from(scopes)
      .where(eq(scopes.id, scopeId))
      .limit(1);

    if (!scope) {
      throw new Error('Scope not found');
    }

    const targets = await this.db
      .select()
      .from(scopeTargets)
      .where(eq(scopeTargets.scopeId, scopeId));

    const exclusions = await this.db
      .select({ type: scopeExclusions.type, value: scopeExclusions.value })
      .from(scopeExclusions)
      .where(eq(scopeExclusions.scopeId, scopeId));

    const [codeSource] = await this.codeSourceStore.listByScopes([scopeId]);
    const connectedRepositories: ScopeConnectedRepository[] =
      codeSource?.status === 'ready' ? [connectedRepositoryOf(codeSource)] : [];
    const accessMaterials = await this.accessMaterialService.listScopeContextMaterials(scopeId);

    const whiteboxEnabled = connectedRepositories.length > 0;
    const accessMaterialCount = accessMaterials.length;
    const { posture: testingPosture, reason: testingPostureReason } = deriveTestingPosture({
      whiteboxEnabled,
      accessMaterialCount,
    });

    return {
      name: scope.name,
      executionNetwork: (scope.executionNetwork === 'internal' ? 'internal' : 'external'),
      attachedRunner: await this.getAttachedRunnerSummary(scopeId),
      targets: targets.map((t) => ({
        type: t.type,
        value: t.value,
        verified: t.verified,
      })),
      exclusions: exclusions.map((exclusion) => ({
        type: exclusion.type as 'domain' | 'cidr',
        value: exclusion.value,
      })),
      mission: scope.mission ?? null,
      impactTolerance: (scope.impactTolerance as ImpactTolerance) ?? 'poc',
      complianceFrameworks: (scope.complianceFrameworks ?? []) as ComplianceFrameworkKey[],
      testingPosture,
      testingPostureReason,
      whiteboxEnabled,
      connectedRepoCount: connectedRepositories.length,
      connectedRepositories,
      accessMaterialCount,
      accessMaterials,
    };
  }

  // ---- Scope enforcement ----

  /**
   * Check if an asset (by kind+value) falls within the scope's verified targets.
   * - Domains: exact match or descendant match against verified domain roots
   * - IPs: CIDR containment against verified CIDR roots only
   * - Explicit exclusions always win
   */
  async isAssetInScope(
    scopeId: string,
    kind: string,
    value: string,
  ): Promise<boolean> {
    const [targets, exclusions] = await Promise.all([
      this.db
        .select({ type: scopeTargets.type, value: scopeTargets.value })
        .from(scopeTargets)
        .where(and(eq(scopeTargets.scopeId, scopeId), eq(scopeTargets.verified, true))),
      this.db
        .select({ type: scopeExclusions.type, value: scopeExclusions.value })
        .from(scopeExclusions)
        .where(eq(scopeExclusions.scopeId, scopeId)),
    ]);

    if (targets.length === 0) {
      // Fail closed: without verified targets we should not authorize writes.
      return false;
    }

    if (kind !== 'domain' && kind !== 'ip') {
      return false;
    }
    return decideScopeNamespace({
      kind,
      value,
      roots: targets as Array<{ type: 'domain' | 'cidr'; value: string }>,
      exclusions: exclusions as Array<{ type: 'domain' | 'cidr'; value: string }>,
    }).allowed;
  }

  private withScopeSummary(scope: ScopeRow, summary?: ScopeSummary): ScopeWithSummary {
      return {
        ...scope,
        whiteboxEnabled: summary?.whiteboxEnabled ?? false,
        connectedRepoCount: summary?.connectedRepoCount ?? 0,
        codeSource: summary?.codeSource ?? null,
        accessMaterialCount: summary?.accessMaterialCount ?? 0,
        targetCount: summary?.targetCount ?? 0,
        verifiedTargetCount: summary?.verifiedTargetCount ?? 0,
        attachedRunner: summary?.attachedRunner ?? null,
      };
    }

  private async getScopeSummary(scopeId: string): Promise<ScopeSummary> {
    const summaries = await this.getScopeSummaryMap([scopeId]);
      return summaries.get(scopeId) ?? {
        whiteboxEnabled: false,
        connectedRepoCount: 0,
        codeSource: null,
        accessMaterialCount: 0,
        targetCount: 0,
        verifiedTargetCount: 0,
        attachedRunner: null,
      };
  }

  private async getScopeSummaryMap(scopeIds: readonly string[]): Promise<Map<string, ScopeSummary>> {
    const normalizedScopeIds = scopeIds.filter((scopeId): scopeId is string => typeof scopeId === 'string' && scopeId.length > 0);
    if (normalizedScopeIds.length === 0) {
      return new Map();
    }

      const [codeSourceRows, targetRows, accessMaterialCounts, runnerRows] = await Promise.all([
        this.codeSourceStore.listByScopes(normalizedScopeIds),
        this.db
        .select({
          scopeId: scopeTargets.scopeId,
          verified: scopeTargets.verified,
        })
        .from(scopeTargets)
        .where(inArray(scopeTargets.scopeId, [...normalizedScopeIds])),
        this.accessMaterialService.getAccessMaterialCountMap(normalizedScopeIds),
        this.db
          .select({
            scopeId: runnerScopeAssignments.scopeId,
            runnerId: runners.id,
            runnerName: runners.name,
            runnerStatus: runners.status,
            runnerType: runners.type,
            runnerMetadata: runners.metadata,
          })
          .from(runnerScopeAssignments)
          .innerJoin(runners, eq(runners.id, runnerScopeAssignments.runnerId))
          .where(inArray(runnerScopeAssignments.scopeId, [...normalizedScopeIds])),
      ]);

      const codeSourceByScopeId = new Map(codeSourceRows.map((row) => [row.scopeId, row]));

      const targetCounts = new Map<string, number>();
      const verifiedTargetCounts = new Map<string, number>();
      for (const row of targetRows) {
        targetCounts.set(row.scopeId, (targetCounts.get(row.scopeId) ?? 0) + 1);
        if (row.verified) {
          verifiedTargetCounts.set(
            row.scopeId,
            (verifiedTargetCounts.get(row.scopeId) ?? 0) + 1,
          );
        }
      }

      const runnerByScopeId = new Map<string, ScopeAttachedRunnerSummary>();
      for (const row of runnerRows) {
        runnerByScopeId.set(row.scopeId, {
          id: row.runnerId,
          name: row.runnerName,
          status: row.runnerStatus,
          type: row.runnerType,
          metadata: row.runnerMetadata,
        });
      }

      return new Map(
        normalizedScopeIds.map((scopeId) => {
          const codeSource = codeSourceByScopeId.get(scopeId) ?? null;
          const connectedRepoCount = codeSource?.status === 'ready' ? 1 : 0;
          return [
            scopeId,
            {
              connectedRepoCount,
              whiteboxEnabled: connectedRepoCount > 0,
              codeSource: toPublicCodeSource(codeSource),
              accessMaterialCount: accessMaterialCounts.get(scopeId) ?? 0,
              targetCount: targetCounts.get(scopeId) ?? 0,
              verifiedTargetCount: verifiedTargetCounts.get(scopeId) ?? 0,
              attachedRunner: runnerByScopeId.get(scopeId) ?? null,
            },
          ];
        }),
      );
  }

  async getAttachedRunnerSummary(scopeId: string): Promise<ScopeAttachedRunnerSummary | null> {
    const [row] = await this.db
      .select({
        id: runners.id,
        name: runners.name,
        status: runners.status,
        type: runners.type,
        metadata: runners.metadata,
      })
      .from(runnerScopeAssignments)
      .innerJoin(runners, eq(runners.id, runnerScopeAssignments.runnerId))
      .where(eq(runnerScopeAssignments.scopeId, scopeId))
      .limit(1);

    if (!row) {
      return null;
    }

    return row;
  }
}
