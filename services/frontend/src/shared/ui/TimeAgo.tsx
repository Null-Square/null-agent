import { formatDistanceToNow } from 'date-fns';

interface TimeAgoProps {
  date: string | null;
  className?: string;
}

/**
 * Relative time display — "2h ago", "3d ago", etc.
 * Returns "—" for null dates.
 */
export function TimeAgo({ date, className }: TimeAgoProps) {
  if (!date) return <span className={className}>—</span>;

  const formatted = formatDistanceToNow(new Date(date), { addSuffix: true });
  return (
    <time dateTime={date} title={new Date(date).toLocaleString()} className={className}>
      {formatted}
    </time>
  );
}
