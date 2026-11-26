/**
 * The theme lives in the kit (`@null-ai/design-tokens/ui`), beside the
 * `themeWipe` it drives; this module stays so the app's many
 * `@shared/contexts/ThemeContext` imports keep working.
 */
export { ThemeProvider, useTheme } from '@null-ai/design-tokens/ui';
export type { Theme, ThemeContextValue } from '@null-ai/design-tokens/ui';
