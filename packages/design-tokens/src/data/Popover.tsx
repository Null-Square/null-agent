
import React, { useState, useRef, useEffect } from 'react';

interface PopoverProps {
  trigger: React.ReactNode;
  content: React.ReactNode | ((args: { close: () => void }) => React.ReactNode);
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  className?: string;
}

export const Popover: React.FC<PopoverProps> = ({
  trigger,
  content,
  position = 'bottom-left',
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = () => setIsOpen(false);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const posClasses = {
    'bottom-left': 'top-full left-0 mt-2',
    'bottom-right': 'top-full right-0 mt-2',
    'top-left': 'bottom-full left-0 mb-2',
    'top-right': 'bottom-full right-0 mb-2',
  };

  return (
    <div className={`relative inline-block ${className}`} ref={containerRef}>
      <div onClick={() => setIsOpen(!isOpen)} className="cursor-pointer">
        {trigger}
      </div>

      {isOpen && (
        <div className={`absolute z-[1000] ${posClasses[position]} animate-in zoom-in-95 duration-100`}>
          {/* Anchored, not modal — opaque and no blur. Blur is spent only on
              the modal family and the sticky header. */}
          {/* Black and a full hairline, not the #08080A lift and a 60% border.
              A popover is a panel on black, which is the brand's own idiom —
              the lift plus a faded border is what made the edge read as soft. */}
          <div className="min-w-[200px] overflow-hidden border border-border bg-background">
             {typeof content === 'function' ? content({ close }) : content}
          </div>
        </div>
      )}
    </div>
  );
};
