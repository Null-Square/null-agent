import { useState } from 'react';

import type { ScopeExclusion } from '@/modules/security-ops/types';
import type { PendingExclusion } from '@/modules/scopes/model/scopeDraft';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
} from '@null-ai/design-tokens/ui';

export type ExclusionRow = ScopeExclusion | (PendingExclusion & { pending: true });

interface ScopeExclusionsPanelProps {
  /** Server exclusions minus staged removals, plus staged additions. */
  exclusions: ExclusionRow[];
  /** Staged for deletion, kept visible so the removal can be undone. */
  removedExclusions: ScopeExclusion[];
  canManage: boolean;
  onAdd: (exclusion: Omit<PendingExclusion, 'key'>) => void;
  onRemove: (exclusion: ExclusionRow) => void;
  onRestore: (exclusionId: string) => void;
}

const isPending = (exclusion: ExclusionRow): exclusion is PendingExclusion & { pending: true } =>
  'pending' in exclusion && exclusion.pending === true;

const rowKey = (exclusion: ExclusionRow): string =>
  isPending(exclusion) ? exclusion.key : exclusion.id;

export default function ScopeExclusionsPanel({
  exclusions,
  removedExclusions,
  canManage,
  onAdd,
  onRemove,
  onRestore,
}: ScopeExclusionsPanelProps) {
  const [exclusionType, setExclusionType] = useState<'domain' | 'cidr'>('domain');
  const [exclusionValue, setExclusionValue] = useState('');

  /* Staged, not written. Removing an exclusion widens the boundary, and the
     scope's Save is the one place that change is confirmed and recorded. */
  const stageExclusion = () => {
    const value = exclusionValue.trim();
    if (!value) return;
    onAdd({ type: exclusionType, value });
    setExclusionValue('');
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Exclusions</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A verified domain covers its apex and every subdomain. Add only what must not be tested.
        </p>
      </div>

      {exclusions.length > 0 ? (
        <div className="divide-y divide-border border border-border">
          {exclusions.map((exclusion) => (
            <div key={rowKey(exclusion)} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
                {exclusion.type}: {exclusion.value}
              </span>
              <div className="flex shrink-0 items-center gap-3">
                {isPending(exclusion) ? (
                  <StatusPill tone="signal" showDot={false}>
                    Added on save
                  </StatusPill>
                ) : null}
                {canManage ? (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onRemove(exclusion)}>
                    {isPending(exclusion) ? 'Discard' : 'Remove'}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="font-mono text-[13px] italic text-muted-foreground">No exclusions.</p>
      )}

      {removedExclusions.length > 0 ? (
        <div className="divide-y divide-border border border-border">
          {removedExclusions.map((exclusion) => (
            <div key={exclusion.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground line-through">
                {exclusion.type}: {exclusion.value}
              </span>
              <div className="flex shrink-0 items-center gap-3">
                <StatusPill tone="warning" showDot={false}>
                  Removed on save
                </StatusPill>
                <Button size="sm" variant="ghost" onClick={() => onRestore(exclusion.id)}>
                  Undo
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {canManage ? (
        <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="exclusion-type">Type</Label>
            <Select
              value={exclusionType}
              onValueChange={(value) => setExclusionType(value as 'domain' | 'cidr')}
            >
              <SelectTrigger id="exclusion-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="domain">Domain subtree</SelectItem>
                <SelectItem value="cidr">CIDR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exclusion-value">Excluded namespace</Label>
            <Input
              id="exclusion-value"
              value={exclusionValue}
              onChange={(event) => setExclusionValue(event.target.value)}
              placeholder={exclusionType === 'domain' ? 'billing.example.com' : '10.10.0.0/16'}
              className="font-mono"
            />
          </div>
          <Button variant="outline" onClick={stageExclusion} disabled={!exclusionValue.trim()}>
            Exclude
          </Button>
        </div>
      ) : null}
    </section>
  );
}
