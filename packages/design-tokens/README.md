# @null-ai/design-tokens

**The single source of truth for NullSquare brand tokens.** There is no second
copy, no mirror, and no sync step — that arrangement is what let the spec and
the shipped values drift apart, so it was removed along with
`packages/Design System`.

```text
colors_and_type.css   the tokens themselves (--ns-*). Plain CSS, no build step.
base.css              Tailwind v4 @theme bridge: --color-* aliased onto --ns-*.
```

## Usage

The app (`services/frontend`, Tailwind) imports the bridge and the shared
composition styles:

```css
@import "tailwindcss";
@import "@null-ai/design-tokens/base.css";
@import "@null-ai/design-tokens/ui-styles.css";
```

The theme comes from `ThemeProvider` and `useTheme` in
`@null-ai/design-tokens/ui`. A page without Tailwind imports the tokens
directly, since `base.css` contains `@theme` blocks that only mean something to
Tailwind:

```css
@import "@null-ai/design-tokens/colors_and_type.css";
```

## Rules

**Never redeclare `--color-*` with a hex value in an app.** Alias it to a
`--ns-*` token instead. Tailwind v4 inlines `var()` references inside `@theme`
when generating colour utilities, so a hex redeclaration freezes the value and
breaks the dark↔light flip. This is the most common way an app drifts.

**No parallel neutral ladder.** The five-step `--ns-*` ramp is the only one.
Do not reach for `zinc`, `slate`, `neutral`, `stone`, or `gray` — Tailwind's
named greys are out of scope for NullSquare apps.

**There are no legacy aliases left.** `ns-black`, `ns-ink`, `ns-graphite`,
`ns-slate`, `ns-gray`, `ns-white` and `ns-paper` are gone; every call site was
migrated. Do not reintroduce a second name for a colour that already has one —
that is how the ladder drifts.

**`--color-ns-inverse` is the one surface that ignores the theme.** It stays
dark in both modes (`#000` dark, `#18181B` on paper), for blocks that are
deliberately dark regardless of the page around them — marketing hero sections,
the Ticker's inverse band, the theme toggle's dark branch. Everything else uses
`--color-ns-bg`, which follows the theme. Text placed on `ns-inverse` must come
from the dark ramp; semantic tokens like `text-foreground` will invert under it
and disappear.

**Edit `colors_and_type.css`, not `base.css`.** The tokens live in the former;
the latter only aliases them for Tailwind. Update the dark block *and* the
`[data-theme="light"], .light-mode` block together, then check contrast in all
consuming apps.

**Light mode goes on the root element**, not `<body>` — the selector is
`:root.light-mode` / `[data-theme="light"]`:

```ts
document.documentElement.classList.add('light-mode');
// or: document.documentElement.dataset.theme = 'light';
```

Light mode is monochrome: `--ns-yellow` rebinds to `#000000` and text on it to
white. Anything derived from the accent must rebind with it — that is why
`--ns-glow-yellow` carries a light-mode value. Severity colours are data, not
chrome, so they survive both modes, but `--ns-success` and `--ns-warning`
darken for readability on paper.

## Shape, casing, and motion

The written standard. Where this disagrees with what the app actually renders,
the app is the authority.

**Radii.** Buttons, inputs, chips 6px · default cards and panels 8px · feature
cards 12px · editorial blocks 16px max · severity chips and badges 4px (not
pill — pills read as social media) · avatars and status dots pill, the only
place pill is used. *The shipping apps run larger: 6 controls / 8 inner /
12 cards / 16–18 outer panels.*

**Casing.** Sentence case for headlines, section titles, card titles, body,
navigation, and most button labels. UPPERCASE only for 12px eyebrows, status
chips, and ≤2-word CTA pills, at `+0.04em`. Technical identifiers
(`CVE-2024-3400`, `api-gateway.prod`, `run_a413`) keep natural case in Space
Mono.

**Type.** Inter for UI and prose. Space Mono for technical identifiers only —
never for chrome, labels, or headings.

**Borders.** 1px `--ns-border`. Hair `rgba(255,255,255,0.04)` for dividers
inside a panel. Selected/active is 1px `--ns-yellow` — no double weight, no
glow. *The apps soften containers to `/40`–`/60`.*

**Backgrounds.** Flat. `--ns-bg` 95% of the time; optionally a 64px grid at
0.025 opacity, or one soft radial ambient at ~6%, at most once per page.
Removed and not to return: scanlines, dot grids at 10%, yellow radials at 25%.

**Shadows.** `--ns-shadow-sm` hover lift, `-md` floating panels, `-lg` modals.
`--ns-glow-yellow` exists but is reserved for the one primary CTA that needs to
breathe — never a default. Removed: halo glows on severity chips, glow on
active cards, glow on every yellow thing.

**Motion.** 120ms fast / 220ms standard / 400ms slow, easing
`cubic-bezier(0.32, 0.72, 0, 1)`. Fade plus 4px translate-up on entry, opacity
on hover, a slow 2s dot pulse for "live". No bounces, no springs, no scale-down
press states, no hover scaling — hover changes background tint.

**Cards.** `--ns-card` background, 1px `--ns-border`, 8px radius, 20–24px
padding. No accent stripe, no corner square, no badge by default. Hover steps
the border to `--ns-border-soft` (or `--ns-yellow` if selectable) and the
background to `--ns-elevated`.

**Icons.** Lucide only. 1.5px stroke, square cap, no fill, `currentColor`.

## Lineage

The original codebase documented itself as "Cyber-Industrial — DOC_V6.0":
`//` eyebrows, UPPERCASE-everything, scanlines, and radius-0 throughout. The
current system keeps the DNA — black and yellow, Inter and Space Mono, severity
semantics — and drops the noisy chrome. Anything still carrying `NS-LEGACY-V6`
belongs to the retired language and is scheduled for deletion.
