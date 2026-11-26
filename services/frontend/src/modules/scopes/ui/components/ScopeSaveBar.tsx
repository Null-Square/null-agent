import { useState } from 'react';
import {
  SCOPE_AUTHORIZATION_STATEMENT,
  SCOPE_WIDENING_REASON_LABELS,
  type ScopeWideningReason,
} from '@null-ai/contracts';
import {
  Button,
  Modal,
  ModalContent,
  ModalFooter,
} from '@null-ai/design-tokens/ui';
import type { ImpactTolerance } from '@/modules/security-ops/types';
import {
  FULL_EXPLOITATION_CONDITIONS,
  FULL_EXPLOITATION_HEADLINE,
  FULL_EXPLOITATION_SUMMARY,
  type ScopeDraftChange,
} from '@/modules/scopes/model/scopeDraft';

interface ScopeSaveBarProps {
  changes: ScopeDraftChange[];
  /** Empty when the save only narrows the boundary or renames things. */
  wideningReasons: ScopeWideningReason[];
  /** The level being saved, so the confirm step can state what it means. */
  impactTolerance: ImpactTolerance;
  isSaving: boolean;
  onDiscard: () => void;
  onSave: (authorization: { accepted: true } | undefined) => void;
}

/**
 * The one place the scope page writes.
 *
 * Every panel above stages its edits, so there is exactly one Save, and the
 * confirm step in front of it is the only thing that ever asks for the
 * authorization statement. That replaces a checkbox per panel, which made a
 * legal warranty into something you cleared four times on the way to a change.
 *
 * The statement appears only when the save widens what may be tested, decided
 * by the same rule the API enforces (`findScopeWideningReasons`). Removing a
 * target, adding an exclusion or lowering impact is covered by the statement
 * already on file, so those saves confirm and go.
 */
export default function ScopeSaveBar({
  changes,
  wideningReasons,
  impactTolerance,
  isSaving,
  onDiscard,
  onSave,
}: ScopeSaveBarProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const needsStatement = wideningReasons.length > 0;
  /* Stated here rather than behind a warning dialog of its own: this is the
     press that authorizes it, so this is where the conditions belong. */
  const showFullExploitationConditions =
    impactTolerance === 'full' && wideningReasons.includes('impact_raised');

  const confirm = () => {
    onSave(needsStatement ? { accepted: true } : undefined);
    setIsConfirming(false);
  };

  return (
    <>
      <div
        data-testid="scope-save-bar"
        className="sticky bottom-0 z-20 -mx-6 mt-10 flex flex-col gap-4 border-t border-border bg-background px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="min-w-0 text-sm text-muted-foreground">
          <span className="font-mono text-foreground">{changes.length}</span>{' '}
          unsaved {changes.length === 1 ? 'change' : 'changes'}
          {needsStatement ? ' · widens what may be tested' : ''}
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="ghost" onClick={onDiscard} disabled={isSaving}>
            Discard
          </Button>
          <Button onClick={() => setIsConfirming(true)} loading={isSaving}>
            Save changes
          </Button>
        </div>
      </div>

      <Modal
        isOpen={isConfirming}
        onClose={() => setIsConfirming(false)}
        title={needsStatement ? 'Authorize and save' : 'Save scope changes'}
        size="md"
      >
        <ModalContent className="space-y-6 p-8">
          <div className="divide-y divide-border border border-border">
            {changes.map((change) => (
              <div key={change.key} className="flex items-baseline justify-between gap-6 px-4 py-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {change.label}
                </span>
                <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
                  {change.detail}
                </span>
              </div>
            ))}
          </div>

          {needsStatement ? (
            <div className="space-y-4 border-l-2 border-warning pl-5">
              <ul className="space-y-1">
                {wideningReasons.map((reason) => (
                  <li key={reason} className="text-sm leading-relaxed text-foreground">
                    {SCOPE_WIDENING_REASON_LABELS[reason]}
                  </li>
                ))}
              </ul>
              {showFullExploitationConditions ? (
                <div className="space-y-2" data-testid="full-exploitation-conditions">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-warning">
                    {FULL_EXPLOITATION_HEADLINE}
                  </p>
                  <p className="text-sm leading-relaxed text-foreground/90">
                    {FULL_EXPLOITATION_SUMMARY}
                  </p>
                  <ul className="space-y-1.5 text-sm leading-relaxed text-muted-foreground">
                    {FULL_EXPLOITATION_CONDITIONS.map((condition) => (
                      <li key={condition}>{condition}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p
                data-testid="scope-authorization-statement"
                className="text-[13px] leading-relaxed text-muted-foreground"
              >
                {SCOPE_AUTHORIZATION_STATEMENT}
              </p>
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              This does not widen what may be tested, so the authorization already on file still
              covers it.
            </p>
          )}
        </ModalContent>

        <ModalFooter>
          <Button variant="outline" onClick={() => setIsConfirming(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} loading={isSaving}>
            {needsStatement ? 'I authorize and save' : 'Save changes'}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
