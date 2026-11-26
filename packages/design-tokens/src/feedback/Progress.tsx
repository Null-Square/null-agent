
import React from 'react';

interface ProgressProps {
  value: number; // 0 to 100
  max?: number;
  label?: string;
  showValue?: boolean;
  color?: string; // Tailwind color class, e.g., 'bg-ns-yellow'
  className?: string;
}

export const Progress: React.FC<ProgressProps> = ({
  value,
  max = 100,
  label,
  showValue = true,
  color = 'bg-ns-yellow',
  className = ''
}) => {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className={`w-full font-mono ${className}`}>
      {(label || showValue) && (
        <div className="flex justify-between items-end mb-1 text-[10px] font-medium text-muted-foreground">
          <span>{label}</span>
          {showValue && <span>{Math.round(percentage)}%</span>}
        </div>
      )}
      
      <div className="relative w-full h-4 bg-background border border-border p-[2px]">
        {/* Fill Bar */}
        <div
          className={`h-full ${color} relative overflow-hidden transition-all duration-300 ease-out`}
          style={{ width: `${percentage}%` }}
        >
          {/* Leading edge — a clean bright terminus, no scanlines, no neon glow. */}
          <div className="absolute top-0 right-0 w-[2px] h-full bg-white/60"></div>
        </div>
      </div>
    </div>
  );
};
