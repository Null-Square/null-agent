import { readFileSync } from 'node:fs';

/**
 * Everything a report page needs, read from installed packages, so rendering a report calls no one.
 * The page holds the whole report, so a script fetched from a CDN would run beside the findings.
 */

const fontFace = (family: string, file: string, weight: number): string => {
  const data = readFileSync(require.resolve(file)).toString('base64');
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: block; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
};

let fontFaces: string | null = null;

/** Inter and JetBrains Mono, at the weights the report uses, embedded in the page. */
export const reportFontFaces = (): string => {
  fontFaces ??= [
    ...[400, 500, 600, 700, 900].map((weight) =>
      fontFace('Inter', `@fontsource/inter/files/inter-latin-${weight}-normal.woff2`, weight),
    ),
    ...[400, 500, 700].map((weight) =>
      fontFace('JetBrains Mono', `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`, weight),
    ),
  ].join('\n');
  return fontFaces;
};

let mermaidSource: string | null = null;

/** The installed mermaid build, ready to inline in a script tag. */
export const mermaidScriptSource = (): string => {
  mermaidSource ??= readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  return mermaidSource;
};
