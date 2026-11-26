export { Avatar, AvatarImage, AvatarFallback } from './Avatar';

export { Progress } from './Progress';

export { AlertDialog } from './AlertDialog';

export { EmptyState } from './EmptyState';

export { NotificationDot } from './NotificationDot';

export { PendingNote } from './PendingNote';
export type { PendingNoteProps } from './PendingNote';

/* The boot screen, and the hook that stops it flickering. Use them together —
   see `LoadingScreen` for why either alone leaves a window that blinks. */
export { LoadingScreen } from './LoadingScreen';
export type { LoadingScreenProps } from './LoadingScreen';
export { useMinimumVisible } from './useMinimumVisible';

/* One boot screen for the whole app — see BootScreen for why a shared component
   was not enough on its own. */
export { BootScreenProvider, useBootScreen } from './BootScreen';
export type { BootScreenProviderProps } from './BootScreen';

export { ErrorNotice } from './ErrorNotice';
export type { ErrorNoticeProps } from './ErrorNotice';

export { CellMeter } from './CellMeter';
export type { CellMeterProps } from './CellMeter';


/* The two full-screen moments: the good news, and the long wait. Both draw
   the same lattice — see CellField for why nothing here spins. */
export { CellField } from './CellField';
export type { CellFieldProps, CellFieldMode } from './CellField';
export { CelebrationOverlay } from './CelebrationOverlay';
export type { CelebrationOverlayProps } from './CelebrationOverlay';
export { WorkingOverlay } from './WorkingOverlay';
export type { WorkingOverlayProps } from './WorkingOverlay';
