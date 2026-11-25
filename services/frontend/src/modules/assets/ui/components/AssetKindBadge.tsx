import { Badge } from '@null-ai/design-tokens/ui';

// Asset kind is a category, not a status — so it's a neutral badge and the
// label carries the meaning (brand rule: flatten categories to mono + label,
// no ad-hoc per-category hues).
const kindLabels: Record<string, string> = {
  domain: 'DOMAIN',
  ip: 'IP',
  repository: 'REPOSITORY',
};

export function AssetKindBadge({ kind }: { kind: string }) {
  const label = kindLabels[kind] ?? kind.toUpperCase();
  return (
    <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
      {label}
    </Badge>
  );
}
