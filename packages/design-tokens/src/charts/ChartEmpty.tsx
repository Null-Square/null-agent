import React from 'react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * ChartEmpty — what a widget draws when there is nothing to draw.
 *
 * Every chart here had grown the same centred grey sentence by copy-paste,
 * which is how a board of eight widgets ends up saying "no data" eight
 * slightly different ways. Written once, they say it the same way.
 *
 * A dashboard where several widgets are empty is the common case on day one,
 * so this has to read as a calm state rather than eight failures: the icon is
 * dimmed to the same step as the seams, and the line under it says what would
 * be here rather than that something is missing.
 *
 * `icon` names the absent subject — the same reasoning as `ListEmptyState`,
 * and the icon doc's stated use for empty states.
 */

export interface ChartEmptyProps {
  label: string;
  icon?: CellIconName;
  className?: string;
}

export const ChartEmpty: React.FC<ChartEmptyProps> = ({ label, icon, className }) => (
  <div
    className={cn(
      'flex h-full min-h-[120px] flex-col items-center justify-center gap-4 text-center',
      className,
    )}
  >
    {icon ? <CellIcon name={icon} size={32} className="text-foreground/20" /> : null}
    <span className="max-w-[26ch] text-sm leading-relaxed text-muted-foreground">{label}</span>
  </div>
);
