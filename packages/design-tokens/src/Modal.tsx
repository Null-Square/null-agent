import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { cn } from './cn';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Held by the labelled `<h2>`, so a node is fine — one caller composes it. */
  title: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, size = 'lg', children }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  useEffect(() => {
    setMounted(true);
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const sizeStyles = {
    sm: 'max-w-md',
    md: 'max-w-xl',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  const modalContent = (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 md:p-8 animate-in fade-in duration-300" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[5px]" />

      {/* One frame: --lift, a single hairline, radius 0, no shadow. The title is
          chrome, so it speaks sans — mono is for real data. And the close glyph
          never takes the yellow; the yellow belongs to the dialog's one verb. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-none border border-border-strong bg-background',
          sizeStyles[size],
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-8 py-6">
          <h2 id={titleId} className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-none p-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar flex-1">{children}</div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

export function ModalContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('p-6 space-y-6', className)}>{children}</div>;
}

export function ModalFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-shrink-0 items-center justify-end gap-3 border-t border-border px-8 py-6', className)}>
      {children}
    </div>
  );
}

Modal.Content = ModalContent;
Modal.Footer = ModalFooter;
