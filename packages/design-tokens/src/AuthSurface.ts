/**
 * Brand-level composition for account and identity surfaces.
 *
 * Tokens describe the palette; this recipe describes how those tokens are
 * composed. Keeping it here prevents every product from inventing a different
 * auth card, input treatment, and accent density.
 */
export const authSurfaceClasses = (_isLight?: boolean) => ({
  page: 'ns-auth-page text-foreground',
  card: 'ns-auth-card',
  brand: 'text-foreground',
  title: 'text-foreground',
  muted: 'text-muted-foreground',
  subtle: 'text-muted-foreground',
  backLink: 'text-muted-foreground hover:text-foreground',
  label: 'mb-1.5 font-sans text-sm font-medium normal-case tracking-normal text-foreground/80',
  input:
    'h-11 border-border bg-background px-4 font-sans text-foreground placeholder:text-muted-foreground/55 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20',
  meterTrack: 'bg-muted',
  dividerLine: 'border-border/80',
  dividerLabel: 'bg-card text-muted-foreground',
  oauthButton: 'border-border/80 bg-background/70 text-foreground hover:bg-muted/60',
  footer: 'text-muted-foreground',
  footerLink: 'text-foreground hover:text-primary',
  modeToggle: 'text-foreground hover:text-primary',
});

export type AuthSurfaceClasses = ReturnType<typeof authSurfaceClasses>;
