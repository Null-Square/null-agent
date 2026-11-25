import React from 'react';

import { cn } from './cn';

/**
 * CellIcon — the platform icon set, drawn on the brand's 11×11 cell matrix.
 *
 * Every icon is built from the same square cell as the wordmark and the grid,
 * and carries exactly ONE signal block (the yellow cell) placed where the
 * attention lives. Bone cells render in `currentColor` so an icon inherits the
 * surrounding text colour (like a lucide icon); the signal cell uses the brand
 * accent token (`--ns-yellow`, which the DS maps to ink in light mode).
 *
 * Pure SVG: no canvas, no effects, SSR-safe, crisp at any size.
 *
 * The set is specified in brand/production-reference/icons.html and generated from the same
 * matrices, so the two cannot drift. Three of the original icons carry more
 * than one signal cell (runs, workbench, automations) — that is a known
 * exception awaiting a decision, not a licence to add more.
 *
 * An icon names a place or a thing. Affordances — chevron, close, check,
 * arrows — stay 1.6px stroke glyphs: the lattice cannot resolve below 18px.
 * `sun` and `moon` are the one exception, because they name the two modes
 * rather than an action; do not render them under 18px.
 */

export type CellIconName =
  // Navigation and pages
  | 'home'
  | 'dashboard'
  | 'findings'
  | 'runs'
  | 'assets'
  | 'scope'
  | 'compliance'
  | 'exposures'
  | 'activity'
  // The agents
  | 'pentest'
  | 'threat'
  | 'website-watch'
  | 'code-review'
  | 'workbench'
  | 'runner'
  | 'automations'
  // Records
  | 'reports'
  | 'evidence'
  | 'trust-badge'
  | 'lock-open'
  | 'docs'
  | 'search'
  // What a page is about
  | 'repository'
  | 'database'
  | 'domain'
  | 'endpoint'
  | 'bug'
  | 'email'
  | 'schedule'
  | 'remediation'
  | 'support'
  // The account
  | 'orgs'
  | 'members'
  | 'partners'
  | 'billing'
  | 'credits'
  | 'credentials'
  | 'settings'
  | 'integrations'
  | 'notifications'
  | 'chat'
  // Mode
  | 'sun'
  | 'moon';

// '.' empty · '#' bone (currentColor) · 'Y' the one signal block.
const ICONS: Record<CellIconName, readonly string[]> = {
  // ── Navigation and pages ──
  home: ['...........', '.....#.....', '....#.#....', '...#...#...', '..#.....#..', '.#########.', '.#.......#.', '.#..###..#.', '.#..#Y#..#.', '.#..#.#..#.', '.#########.'],
  dashboard: ['...........', '.####.####.', '.#..#.#..#.', '.#..#.#..#.', '.####.####.', '...........', '.####.####.', '.#..#.#Y.#.', '.#..#.#..#.', '.####.####.', '...........'],
  findings: ['.....#.....', '....#.#....', '....#.#....', '...#...#...', '...#.#.#...', '..#..#..#..', '..#.....#..', '.#...Y...#.', '.#.......#.', '.#########.', '...........'],
  runs: ['...........', '...........', '...........', '.#..#..Y...', '..#..#..Y..', '...#..#..Y.', '..#..#..Y..', '.#..#..Y...', '...........', '...........', '...........'],
  assets: ['...........', '...........', '.#########.', '.#Y......#.', '.#########.', '...........', '.#########.', '.#.......#.', '.#########.', '...........', '...........'],
  scope: ['###.....###', '#.........#', '#.........#', '...........', '...........', '.....Y.....', '...........', '...........', '#.........#', '#.........#', '###.....###'],
  compliance: ['...........', '.#########.', '.#.......#.', '.#.......#.', '.#.....Y.#.', '.#....#..#.', '.#.#.#...#.', '.#..#....#.', '.#.......#.', '.#########.', '...........'],
  exposures: ['...........', '..###Y###..', '..#.....#..', '..#.....#..', '..#.....#..', '..#.....#..', '...#...#...', '....#.#....', '.....#.....', '...........', '...........'],
  activity: ['...........', '...........', '......Y....', '..#...#....', '..#...#..#.', '..#.#.#..#.', '..#.#.#..#.', '..#.#.#..#.', '..#.#.#..#.', '.#########.', '...........'],
  // ── The agents ──
  pentest: ['.....#.....', '.....#.....', '.....#.....', '...........', '...........', '##...Y...##', '...........', '...........', '.....#.....', '.....#.....', '.....#.....'],
  threat: ['...........', '...........', '...#####...', '..#.....#..', '.#..###..#.', '#..#.Y.#..#', '.#..###..#.', '..#.....#..', '...#####...', '...........', '...........'],
  'website-watch': ['...........', '.#########.', '.#......Y#.', '.#.#####.#.', '.#.......#.', '.#.###...#.', '.#.......#.', '.#########.', '....#.#....', '...#####...', '...........'],
  'code-review': ['...........', '...........', '###########', '#.........#', '#.####....#', '#Y######..#', '#.####....#', '#.##......#', '###########', '...........', '...........'],
  workbench: ['...........', '...........', '.#########.', '.#.......#.', '.#.#.....#.', '.#..#....#.', '.#.#.YY..#.', '.#.......#.', '.#########.', '...........', '...........'],
  runner: ['...........', '.....Y.....', '.....#.....', '.#########.', '.#.......#.', '.#..###..#.', '.#..###..#.', '.#..###..#.', '.#.......#.', '.#########.', '...........'],
  automations: ['...........', '...#####...', '..#.....#..', '.#...#...#.', '.#...#...#.', '.#...#YY.#.', '.#.......#.', '..#.....#..', '...#####...', '...........', '...........'],
  // ── Records ──
  reports: ['..#######..', '..#.....#..', '..#.###.#..', '..#.....#..', '..#.###.#..', '..#.....#..', '..#.###.#..', '..#.....#..', '..#..Y..#..', '..#.....#..', '..#######..'],
  // A pen, nib down, with the ink as the signal cell — evidence is the thing
  // somebody wrote and signed.
  //
  // It was a solid tapering slab, which at 19px read as a slash or a chart
  // line rather than an object. The silhouette was right; it had no interior.
  // Now the barrel is hollow between a solid cap and a solid nib, so the three
  // parts of a pen are all legible — and the ink cell reads as ink because
  // something recognisable is holding it.
  evidence: ['.......###.', '......####.', '......###..', '.....#.#...', '....#.#....', '...#.#.....', '..#.#......', '.###.......', '.##........', '##.........', 'Y..........'],
  // A lock, shut. The badge is the thing a customer sees, and a lock that has
  // closed says "secure" without needing to be read. Earlier drafts were a
  // shield (that is `exposures`, cell for cell) and a square with a check
  // (that is `compliance`) — check a new mark against the whole set.
  'trust-badge': ['...........', '...#####...', '..#.....#..', '..#.....#..', '..#.....#..', '.#########.', '.#.......#.', '.#...Y...#.', '.#.......#.', '.#########.', '...........'],
  // The same lock before it shuts. Only the shackle moves, so the two read as
  // one object in two states rather than two marks.
  'lock-open': ['..#####....', '.#.....#...', '.#.....#...', '.#.........', '.#.........', '.#########.', '.#.......#.', '.#...Y...#.', '.#.......#.', '.#########.', '...........'],
  docs: ['...........', '...........', '...........', '...#...#...', '..#.....#..', '.#...Y...#.', '..#.....#..', '...#...#...', '...........', '...........', '...........'],
  search: ['...........', '..#####....', '.#.....#...', '.#..Y..#...', '.#.....#...', '..#####....', '......#....', '.......#...', '........#..', '...........', '...........'],
  // ── What a page is about ──
  repository: ['...........', '.###...###.', '.#.#...#.#.', '.###...###.', '..#.....#..', '..#######..', '..#........', '..#........', '.###.......', '.#Y#.......', '.###.......'],
  database: ['...........', '.#########.', '.#.#.#.#.#.', '.#########.', '.#.#.#.#.#.', '.#########.', '.#Y#.#.#.#.', '.#########.', '...........', '...........', '...........'],
  domain: ['...........', '...........', '.....Y.....', '.....#.....', '..#######..', '..#..#..#..', '..#..#..#..', '..#..#..#..', '...........', '...........', '...........'],
  endpoint: ['...........', '...........', '...........', '.......###.', '.......#.#.', '########Y#.', '.......#.#.', '.......###.', '...........', '...........', '...........'],
  // Outline, not fill. Two denser drafts read as a smudge at 18px — the marks
  // that survive small in this set do it on their counters, not their weight.
  bug: ['...........', '..#.....#..', '...#...#...', '...#####...', '..#.....#..', '.##..Y..##.', '..#.....#..', '...#####...', '...#...#...', '..#.....#..', '...........'],
  email: ['...........', '...........', '.#########.', '.##.....##.', '.#.#...#.#.', '.#..#.#..#.', '.#...Y...#.', '.#.......#.', '.#########.', '...........', '...........'],
  schedule: ['...........', '...#...#...', '.#########.', '.#########.', '.#.......#.', '.#.#.#.#.#.', '.#.......#.', '.#.#.Y.#.#.', '.#.......#.', '.#########.', '...........'],
  remediation: ['...........', '...........', '.#########.', '.#########.', '.####Y####.', '.#########.', '.#########.', '...........', '...........', '...........', '...........'],
  support: ['...........', '...........', '...#####...', '..##...##..', '..##...##..', '.......##..', '.....###...', '.....##....', '.....##....', '...........', '.....Y.....'],
  // ── The account ──
  orgs: ['...........', '....###....', '..#######..', '..#.....#..', '..#.#.#.#..', '..#.....#..', '..#.#Y#.#..', '..#.....#..', '..#.###.#..', '..#.#.#.#..', '..#######..'],
  members: ['...........', '....###..Y.', '....###....', '...........', '..#######..', '.#.......#.', '.#.......#.', '.#.......#.', '...........', '...........', '...........'],
  partners: ['...........', '..##...##..', '..##...##..', '...........', '.####.####.', '.#..#.#..#.', '.#..#Y#..#.', '.#..#.#..#.', '.####.####.', '...........', '...........'],
  billing: ['...........', '...........', '.#########.', '.#.......#.', '.#########.', '.#.......#.', '.#.Y.....#.', '.#.......#.', '.#########.', '...........', '...........'],
  credits: ['...........', '...#######.', '...#.....#.', '...#.....#.', '.#######.#.', '.#.....#.#.', '.#..Y..#...', '.#.....#...', '.#######...', '...........', '...........'],
  credentials: ['...........', '...........', '...........', '...........', '.###.......', '.#Y#######.', '.###..#.#..', '...........', '...........', '...........', '...........'],
  settings: ['...........', '...........', '...#.......', '.#########.', '...#.......', '...........', '.......#...', '.######Y##.', '.......#...', '...........', '...........'],
  integrations: ['...........', '...........', '...........', '###.....###', '#.#.....#.#', '#.###Y###.#', '#.#.....#.#', '###.....###', '...........', '...........', '...........'],
  notifications: ['...........', '.....#.....', '....###....', '...#...#...', '...#...#...', '..#.....#..', '..#.....#..', '.#########.', '...........', '.....Y.....', '...........'],
  chat: ['...........', '.....#.....', '.....#.....', '..#######..', '.#.......#.', '.#.##.##.#.', '.#.......#.', '.#...Y...#.', '..#######..', '...........', '...........'],
  // ── Mode ──
  // The two mode marks. Every call site in every service draws these at 18px —
  // one cell is then 1.6px — so neither may contain an isolated cell: the old
  // sun spent its rays on eight single cells and read as scattered dust rather
  // than as a sun, and the old moon hung its signal cell in empty space as a
  // star, where it was a speck. Nothing here is thinner than three cells, and
  // both signal cells now sit inside a stroke, which is also where the set's
  // rule wants them — where the attention lives.
  sun: ['...........', '....###....', '....###....', '...........', '.##.###.##.', '.##.#Y#.##.', '.##.###.##.', '...........', '....###....', '....###....', '...........'],
  moon: ['...........', '...####....', '..###......', '.###.......', '.###.......', '.#Y#.......', '.###.......', '.###.......', '..###......', '...####....', '...........'],
};

const GRID = 11;
const GAP = 0.14; // fraction of a cell left as gutter, so cells read as blocks
const CELL = 1 - GAP;
const OFFSET = GAP / 2;

type Cell = { x: number; y: number; signal: boolean };

// Precompute the drawable cells once per icon so a render is a plain map.
const CELLS: Record<CellIconName, Cell[]> = Object.fromEntries(
  (Object.keys(ICONS) as CellIconName[]).map((name) => {
    const rows = ICONS[name];
    const cells: Cell[] = [];
    for (let y = 0; y < GRID; y += 1) {
      for (let x = 0; x < GRID; x += 1) {
        const ch = rows[y][x];
        if (ch === '#' || ch === 'Y') cells.push({ x, y, signal: ch === 'Y' });
      }
    }
    return [name, cells];
  }),
) as Record<CellIconName, Cell[]>;

export const CELL_ICON_NAMES = Object.keys(ICONS) as CellIconName[];

export interface CellIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: CellIconName;
  /** Pixel width/height of the square icon. Default 20. */
  size?: number;
  /** Accessible label. When omitted the icon is decorative (aria-hidden). */
  title?: string;
  /** Override the signal-cell colour. Defaults to the brand accent token. */
  signalColor?: string;
}

export const CellIcon = React.forwardRef<SVGSVGElement, CellIconProps>(
  ({ name, size = 20, title, signalColor = 'var(--ns-yellow)', className, ...props }, ref) => {
    const cells = CELLS[name];
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={`0 0 ${GRID} ${GRID}`}
        shapeRendering="crispEdges"
        className={cn('inline-block flex-none', className)}
        role={title ? 'img' : undefined}
        aria-hidden={title ? undefined : true}
        {...props}
      >
        {title ? <title>{title}</title> : null}
        {cells.map((cell) => (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={cell.x + OFFSET}
            y={cell.y + OFFSET}
            width={CELL}
            height={CELL}
            fill={cell.signal ? signalColor : 'currentColor'}
          />
        ))}
      </svg>
    );
  },
);

CellIcon.displayName = 'CellIcon';
