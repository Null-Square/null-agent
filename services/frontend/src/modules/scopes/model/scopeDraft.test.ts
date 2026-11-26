import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useScopeDraft } from './scopeDraft';
import type { ScopeTarget } from '@/modules/security-ops/api';
import type { Scope, ScopeExclusion } from '@/modules/security-ops/types';

const scope = (overrides: Partial<Scope> = {}): Scope =>
  ({
    id: 'scope-1',
    name: 'Acme',
    status: 'active',
    impactTolerance: 'poc',
    executionNetwork: 'cloud',
    mission: null,
    complianceFrameworks: [],
    ...overrides,
  }) as Scope;

const target = (value: string, id = value): ScopeTarget =>
  ({ id, type: 'domain', value, verified: true, verifiedAt: null }) as ScopeTarget;

const exclusion = (value: string, id = value): ScopeExclusion =>
  ({ id, type: 'domain', value, createdAt: '2026-09-01T00:00:00.000Z' }) as ScopeExclusion;

const setup = (
  current = scope(),
  targets: ScopeTarget[] = [target('example.com')],
  exclusions: ScopeExclusion[] = [],
) => renderHook(() => useScopeDraft(current, targets, exclusions));

describe('useScopeDraft', () => {
  it('starts clean and reports nothing to save', () => {
    const { result } = setup();

    expect(result.current.dirty).toBe(false);
    expect(result.current.changes).toHaveLength(0);
    expect(result.current.wideningReasons).toHaveLength(0);
  });

  /* The whole point of the draft: a click changes the page, not the database. */
  it('stages an added target without touching the server list', () => {
    const { result } = setup();

    act(() => result.current.actions.addTarget({ type: 'domain', value: 'other.com' }));

    expect(result.current.dirty).toBe(true);
    expect(result.current.effectiveTargets.map((row) => row.value)).toEqual([
      'example.com',
      'other.com',
    ]);
    expect(result.current.changes[0]).toMatchObject({ label: 'Add target', detail: 'other.com' });
  });

  it('asks for the statement when a new root widens the boundary', () => {
    const { result } = setup();

    act(() => result.current.actions.addTarget({ type: 'domain', value: 'other.com' }));

    expect(result.current.wideningReasons).toContain('root_added');
  });

  /* A statement over example.com already covers everything under it, so adding
     the subdomain is not a new warranty. */
  it('does not ask again for a subdomain of an authorized root', () => {
    const { result } = setup();

    act(() => result.current.actions.addTarget({ type: 'domain', value: 'api.example.com' }));

    expect(result.current.dirty).toBe(true);
    expect(result.current.wideningReasons).toHaveLength(0);
  });

  it('does not ask when the change only narrows', () => {
    const { result } = setup();

    act(() => result.current.actions.removeTarget(target('example.com')));
    act(() => result.current.actions.addExclusion({ type: 'domain', value: 'billing.example.com' }));

    expect(result.current.dirty).toBe(true);
    expect(result.current.wideningReasons).toHaveLength(0);
  });

  it('asks when an exclusion is removed', () => {
    const { result } = setup(scope(), [target('example.com')], [exclusion('billing.example.com')]);

    act(() => result.current.actions.removeExclusion(exclusion('billing.example.com')));

    expect(result.current.wideningReasons).toContain('exclusion_removed');
  });

  it('asks when the impact limit is raised, not when it is lowered', () => {
    const raised = setup();
    act(() => raised.result.current.actions.setBrief({ mission: null, impactTolerance: 'full' }));
    expect(raised.result.current.wideningReasons).toContain('impact_raised');

    const lowered = setup();
    act(() =>
      lowered.result.current.actions.setBrief({ mission: null, impactTolerance: 'non_destructive' }),
    );
    expect(lowered.result.current.wideningReasons).toHaveLength(0);
  });

  it('treats a rename-scale edit as a change with no statement', () => {
    const { result } = setup();

    act(() => result.current.actions.setComplianceFrameworks(['soc2']));

    expect(result.current.dirty).toBe(true);
    expect(result.current.wideningReasons).toHaveLength(0);
    expect(result.current.changes[0]?.label).toBe('Compliance frameworks');
  });

  /* Clearing the mission is an edit. Sharing a sentinel with "untouched" made
     it a silent no-op on save. */
  it('treats a cleared mission as a change', () => {
    const { result } = setup(scope({ mission: 'Focus on checkout.' }));

    act(() => result.current.actions.setBrief({ mission: null, impactTolerance: 'poc' }));

    expect(result.current.dirty).toBe(true);
    expect(result.current.mission).toBeNull();
    expect(result.current.changes).toContainEqual(
      expect.objectContaining({ label: 'Mission guidance', detail: 'Cleared' }),
    );
  });

  it('does not report a mission change when nobody touched it', () => {
    const { result } = setup(scope({ mission: 'Focus on checkout.' }));

    act(() => result.current.actions.setComplianceFrameworks(['soc2']));

    expect(result.current.mission).toBe('Focus on checkout.');
    expect(result.current.changes.map((change) => change.label)).not.toContain('Mission guidance');
  });

  it('discards everything staged', () => {
    const { result } = setup();

    act(() => result.current.actions.addTarget({ type: 'domain', value: 'other.com' }));
    act(() => result.current.actions.discard());

    expect(result.current.dirty).toBe(false);
    expect(result.current.effectiveTargets).toHaveLength(1);
  });

  it('puts a staged removal back', () => {
    const { result } = setup();

    act(() => result.current.actions.removeTarget(target('example.com')));
    expect(result.current.effectiveTargets).toHaveLength(0);

    act(() => result.current.actions.restoreTarget('example.com'));
    expect(result.current.effectiveTargets).toHaveLength(1);
    expect(result.current.dirty).toBe(false);
  });
});
