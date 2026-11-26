import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

export type NavItem = {
  id: string;
  label: string;
  path: string;
  /** A lucide icon or a brand `CellIcon` glyph — see `navGlyph`. */
  icon?: LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};
