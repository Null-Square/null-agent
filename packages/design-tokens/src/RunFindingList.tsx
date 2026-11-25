import * as React from 'react';

import { cn } from './cn';
import type { CellIconName } from './CellIcon';
import { ListEmptyState } from './lists/ListEmptyState';

export interface RunFindingListItem {
  id: string;
  title: string;
  severity?: string | null;
  target?: string | null;
}

export interface RunFindingListProps {
  findings: RunFindingListItem[];
  onSelect: (finding: RunFindingListItem) => void;
  /** Headline for the empty state. */
  emptyTitle?: string;
  emptyMessage?: string;
  /** Names the absent thing. Defaults to . */
  emptyIcon?: CellIconName;
  className?: string;
}

const severityLabel = (severity?: string | null) => {
  const normalized = severity?.trim().toLowerCase() || 'unknown';
  return normalized === 'unknown'
    ? 'Unknown'
    : normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

export const RunFindingList: React.FC<RunFindingListProps> = ({
  findings,
  onSelect,
  emptyTitle = 'No risks discovered',
  emptyMessage = 'Nothing was proven exploitable during this assessment.',
  emptyIcon = 'findings',
  className,
}) => {
  if (findings.length === 0) {
    // The empty state is the app's, not a bare line of text: an assessment
    // that proved nothing is a result, and it should read like one.
    return (
      <ListEmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyMessage}
        className={className}
      />
    );
  }

  return (
    <div className={cn('ns-run-finding-list', className)}>
      {findings.map((finding) => {
        const severity = finding.severity?.trim().toLowerCase() || 'unknown';
        return (
          <button
            type="button"
            className={`ns-run-finding-list__row is-${severity}`}
            key={finding.id}
            onClick={() => onSelect(finding)}
          >
            <span className="ns-run-finding-list__severity">
              {severityLabel(finding.severity)}
            </span>
            <span className="ns-run-finding-list__copy">
              <strong>{finding.title}</strong>
              <small>{finding.target?.trim() || 'Global'}</small>
            </span>
            <span className="ns-run-finding-list__arrow" aria-hidden="true">→</span>
          </button>
        );
      })}
    </div>
  );
};
