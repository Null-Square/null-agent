import { useMemo, useState } from 'react';
import {
  findScopeWideningReasons,
  type ScopeContract,
  type ScopeWideningReason,
} from '@null-ai/contracts';
import type { ScopeTarget } from '@/modules/security-ops/api';
import type {
  ComplianceFrameworkKey,
  ImpactTolerance,
  Scope,
  ScopeExclusion,
} from '@/modules/security-ops/types';

/**
 * Everything the scope page has changed but not yet saved.
 *
 * The page used to write on every click — an added target was a request, a
 * removed exclusion was a request, a compliance toggle was a request — which
 * left the customer with no moment to review a boundary change and forced a
 * separate consent control onto each panel. One draft and one Save gives the
 * change a shape, so there is one thing to confirm and one statement to record.
 *
 * A draft holds *edits*, not a copy of the scope: `null` means "unchanged", so
 * a field nobody touched is never sent and never overwrites a concurrent edit
 * from somewhere else.
 */
export interface PendingTarget {
  /** Local identity; the row has no server id until Save. */
  key: string;
  type: 'domain' | 'ip' | 'cidr' | 'url';
  value: string;
  verificationMethod?: string;
}

export interface PendingExclusion {
  key: string;
  type: 'domain' | 'cidr';
  value: string;
}

export interface ScopeDraft {
  targetsToAdd: PendingTarget[];
  targetIdsToRemove: string[];
  exclusionsToAdd: PendingExclusion[];
  exclusionIdsToRemove: string[];
  /* `undefined` is untouched and `null` is cleared — mission is the one field
     whose empty value is a real edit, so the two cannot share a sentinel. */
  mission: string | null | undefined;
  impactTolerance: ImpactTolerance | null;
  complianceFrameworks: ComplianceFrameworkKey[] | null;
}

export const EMPTY_SCOPE_DRAFT: ScopeDraft = {
  targetsToAdd: [],
  targetIdsToRemove: [],
  exclusionsToAdd: [],
  exclusionIdsToRemove: [],
  mission: undefined,
  impactTolerance: null,
  complianceFrameworks: null,
};

/** One line per staged edit, for the confirm dialog and the save bar count. */
export interface ScopeDraftChange {
  key: string;
  label: string;
  detail: string;
}

const newKey = (): string =>
  `pending-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

const sameValue = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export const isScopeDraftDirty = (draft: ScopeDraft): boolean =>
  draft.targetsToAdd.length > 0 ||
  draft.targetIdsToRemove.length > 0 ||
  draft.exclusionsToAdd.length > 0 ||
  draft.exclusionIdsToRemove.length > 0 ||
  draft.mission !== undefined ||
  draft.impactTolerance !== null ||
  draft.complianceFrameworks !== null;

const IMPACT_LABELS: Record<ImpactTolerance, string> = {
  non_destructive: 'Observation only',
  poc: 'Bounded proof of concept',
  full: 'Full exploitation',
};

export const scopeImpactLabel = (impact: ImpactTolerance): string => IMPACT_LABELS[impact];

/**
 * What full exploitation means, in the words shown both at the control and in
 * the confirm step that authorizes it.
 *
 * It used to be a modal with an acknowledgement checkbox that was reset on
 * close and stored nowhere — a speed bump, not evidence. Raising the impact
 * limit is a widening, so the page's Save already asks for the authorization
 * statement; these conditions are shown there, beside the statement, which is
 * the record that is actually kept.
 */
export const FULL_EXPLOITATION_HEADLINE = 'Highest-impact testing mode';

export const FULL_EXPLOITATION_SUMMARY =
  'Full exploitation may modify application data, accounts, files, configuration or database contents, and may extract authorized test data to prove impact.';

export const FULL_EXPLOITATION_CONDITIONS = [
  'Use only on systems you own or are explicitly authorized to test.',
  'Use only in a resettable testing or staging environment.',
  'Do not enable this mode for production targets.',
];

/**
 * Only the parts of the contract this page can move.
 *
 * `executionNetwork` is carried through unchanged: binding a private runner is
 * a separate decision about where tests run from, and the scope column this
 * compares is not what that binding writes.
 */
const buildContract = (input: {
  roots: Array<{ type: string; value: string }>;
  exclusions: Array<{ type: string; value: string }>;
  impactTolerance: ImpactTolerance;
  executionNetwork: string;
}): ScopeContract => ({
  /* The contract speaks in domains and CIDRs. A url or ip target still names a
     host, so it is compared as one rather than dropped from the comparison. */
  roots: input.roots.map((root) => ({
    type: root.type === 'cidr' ? ('cidr' as const) : ('domain' as const),
    value: root.value,
  })),
  exclusions: input.exclusions.map((exclusion) => ({
    type: exclusion.type === 'cidr' ? ('cidr' as const) : ('domain' as const),
    value: exclusion.value,
  })),
  impactTolerance: input.impactTolerance,
  executionNetwork: input.executionNetwork,
});

export interface ScopeDraftView {
  draft: ScopeDraft;
  dirty: boolean;
  changes: ScopeDraftChange[];
  /** Empty when the save only narrows the boundary or renames things. */
  wideningReasons: ScopeWideningReason[];
  /** Server targets minus staged removals, plus staged additions. */
  effectiveTargets: Array<ScopeTarget | (PendingTarget & { pending: true })>;
  effectiveExclusions: Array<ScopeExclusion | (PendingExclusion & { pending: true })>;
  impactTolerance: ImpactTolerance;
  mission: string | null;
  complianceFrameworks: ComplianceFrameworkKey[];
}

export interface ScopeDraftActions {
  addTarget: (target: Omit<PendingTarget, 'key'>) => void;
  removeTarget: (target: ScopeTarget | (PendingTarget & { pending: true })) => void;
  restoreTarget: (targetId: string) => void;
  addExclusion: (exclusion: Omit<PendingExclusion, 'key'>) => void;
  removeExclusion: (exclusion: ScopeExclusion | (PendingExclusion & { pending: true })) => void;
  restoreExclusion: (exclusionId: string) => void;
  setBrief: (brief: { mission: string | null; impactTolerance: ImpactTolerance }) => void;
  setComplianceFrameworks: (frameworks: ComplianceFrameworkKey[]) => void;
  discard: () => void;
}

const isPending = (row: { pending?: true }): row is PendingTarget & { pending: true } =>
  row.pending === true;

/**
 * The draft, what it adds up to, and how to change it.
 *
 * `wideningReasons` is computed here with the same rule the API enforces
 * (`@null-ai/contracts`), so the dialog asks for the statement exactly when the
 * save would otherwise be refused — never as a precaution.
 */
export function useScopeDraft(
  scope: Scope | undefined,
  targets: ScopeTarget[],
  exclusions: ScopeExclusion[],
): ScopeDraftView & { actions: ScopeDraftActions } {
  const [draft, setDraft] = useState<ScopeDraft>(EMPTY_SCOPE_DRAFT);

  const serverImpact: ImpactTolerance = scope?.impactTolerance ?? 'poc';
  const serverMission = scope?.mission ?? null;
  const serverFrameworks = useMemo(
    () => scope?.complianceFrameworks ?? [],
    [scope?.complianceFrameworks],
  );
  const executionNetwork = scope?.executionNetwork ?? 'cloud';

  const impactTolerance = draft.impactTolerance ?? serverImpact;
  const mission = draft.mission !== undefined ? draft.mission : serverMission;
  const complianceFrameworks = draft.complianceFrameworks ?? serverFrameworks;

  const effectiveTargets = useMemo(
    () => [
      ...targets.filter((target) => !draft.targetIdsToRemove.includes(target.id)),
      ...draft.targetsToAdd.map((target) => ({ ...target, pending: true as const })),
    ],
    [targets, draft.targetIdsToRemove, draft.targetsToAdd],
  );

  const effectiveExclusions = useMemo(
    () => [
      ...exclusions.filter((exclusion) => !draft.exclusionIdsToRemove.includes(exclusion.id)),
      ...draft.exclusionsToAdd.map((exclusion) => ({ ...exclusion, pending: true as const })),
    ],
    [exclusions, draft.exclusionIdsToRemove, draft.exclusionsToAdd],
  );

  const wideningReasons = useMemo(() => {
    if (!scope) return [];
    const authorized = buildContract({
      roots: targets,
      exclusions,
      impactTolerance: serverImpact,
      executionNetwork,
    });
    const next = buildContract({
      roots: effectiveTargets,
      exclusions: effectiveExclusions,
      impactTolerance,
      executionNetwork,
    });
    return findScopeWideningReasons(authorized, next);
  }, [
    scope,
    targets,
    exclusions,
    serverImpact,
    executionNetwork,
    effectiveTargets,
    effectiveExclusions,
    impactTolerance,
  ]);

  const changes = useMemo<ScopeDraftChange[]>(() => {
    const list: ScopeDraftChange[] = [];
    for (const target of draft.targetsToAdd) {
      list.push({ key: `add-target-${target.key}`, label: 'Add target', detail: target.value });
    }
    for (const targetId of draft.targetIdsToRemove) {
      const removed = targets.find((target) => target.id === targetId);
      list.push({
        key: `remove-target-${targetId}`,
        label: 'Remove target',
        detail: removed?.value ?? targetId,
      });
    }
    for (const exclusion of draft.exclusionsToAdd) {
      list.push({
        key: `add-exclusion-${exclusion.key}`,
        label: 'Add exclusion',
        detail: `${exclusion.type}: ${exclusion.value}`,
      });
    }
    for (const exclusionId of draft.exclusionIdsToRemove) {
      const removed = exclusions.find((exclusion) => exclusion.id === exclusionId);
      list.push({
        key: `remove-exclusion-${exclusionId}`,
        label: 'Remove exclusion',
        detail: removed ? `${removed.type}: ${removed.value}` : exclusionId,
      });
    }
    if (draft.impactTolerance !== null && draft.impactTolerance !== serverImpact) {
      list.push({
        key: 'impact',
        label: 'Impact limit',
        detail: `${IMPACT_LABELS[serverImpact]} → ${IMPACT_LABELS[draft.impactTolerance]}`,
      });
    }
    if (draft.mission !== undefined && draft.mission !== serverMission) {
      list.push({
        key: 'mission',
        label: 'Mission guidance',
        detail: draft.mission?.trim() ? 'Rewritten' : 'Cleared',
      });
    }
    if (draft.complianceFrameworks !== null) {
      list.push({
        key: 'frameworks',
        label: 'Compliance frameworks',
        detail:
          draft.complianceFrameworks.length === 0
            ? 'None'
            : draft.complianceFrameworks.join(', ').toUpperCase(),
      });
    }
    return list;
  }, [draft, targets, exclusions, serverImpact, serverMission]);

  const actions: ScopeDraftActions = useMemo(
    () => ({
      addTarget: (target) =>
        setDraft((current) => ({
          ...current,
          targetsToAdd: [...current.targetsToAdd, { ...target, key: newKey() }],
        })),
      removeTarget: (target) =>
        setDraft((current) =>
          isPending(target as { pending?: true })
            ? {
                ...current,
                targetsToAdd: current.targetsToAdd.filter(
                  (pending) => pending.key !== (target as PendingTarget).key,
                ),
              }
            : {
                ...current,
                targetIdsToRemove: current.targetIdsToRemove.includes((target as ScopeTarget).id)
                  ? current.targetIdsToRemove
                  : [...current.targetIdsToRemove, (target as ScopeTarget).id],
              },
        ),
      restoreTarget: (targetId) =>
        setDraft((current) => ({
          ...current,
          targetIdsToRemove: current.targetIdsToRemove.filter((id) => id !== targetId),
        })),
      addExclusion: (exclusion) =>
        setDraft((current) =>
          current.exclusionsToAdd.some(
            (pending) => pending.type === exclusion.type && sameValue(pending.value, exclusion.value),
          )
            ? current
            : {
                ...current,
                exclusionsToAdd: [...current.exclusionsToAdd, { ...exclusion, key: newKey() }],
              },
        ),
      removeExclusion: (exclusion) =>
        setDraft((current) =>
          'pending' in exclusion && exclusion.pending
            ? {
                ...current,
                exclusionsToAdd: current.exclusionsToAdd.filter(
                  (pending) => pending.key !== (exclusion as PendingExclusion).key,
                ),
              }
            : {
                ...current,
                exclusionIdsToRemove: current.exclusionIdsToRemove.includes(
                  (exclusion as ScopeExclusion).id,
                )
                  ? current.exclusionIdsToRemove
                  : [...current.exclusionIdsToRemove, (exclusion as ScopeExclusion).id],
              },
        ),
      restoreExclusion: (exclusionId) =>
        setDraft((current) => ({
          ...current,
          exclusionIdsToRemove: current.exclusionIdsToRemove.filter((id) => id !== exclusionId),
        })),
      setBrief: (brief) =>
        setDraft((current) => ({
          ...current,
          mission: brief.mission,
          impactTolerance: brief.impactTolerance,
        })),
      setComplianceFrameworks: (frameworks) =>
        setDraft((current) => ({ ...current, complianceFrameworks: frameworks })),
      discard: () => setDraft(EMPTY_SCOPE_DRAFT),
    }),
    [],
  );

  return {
    draft,
    dirty: isScopeDraftDirty(draft),
    changes,
    wideningReasons,
    effectiveTargets,
    effectiveExclusions,
    impactTolerance,
    mission,
    complianceFrameworks,
    actions,
  };
}
