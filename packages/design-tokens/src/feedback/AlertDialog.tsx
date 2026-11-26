
import React from 'react';
import { X } from 'lucide-react';

interface AlertDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

// Same frame as Modal — header/body/footer, radius 0, the one decided scrim.
// The confirm button carries the variant's colour; the header doesn't
// restate it with an icon or a colour-matched border.
export const AlertDialog: React.FC<AlertDialogProps> = ({
  isOpen,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null;

  const confirmStyle = {
    danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    warning: 'bg-warning text-black hover:bg-warning/90',
    info: 'bg-info text-white hover:bg-info/90',
  }[variant];

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/55 backdrop-blur-[5px] animate-in fade-in duration-200">
      <div className="relative w-full max-w-md border border-border-strong bg-background">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <span className="font-medium text-foreground">{title}</span>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        {/* The message is prose, so it's sans, not mono. */}
        <div className="p-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {description}
          </p>
        </div>

        <div className="flex gap-4 p-4 border-t border-border">
          <button
            onClick={onCancel}
            className="flex-1 py-3 border border-border text-muted-foreground font-medium text-xs hover:bg-ns-elevated hover:text-foreground transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-3 font-medium text-xs transition-colors ${confirmStyle}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
