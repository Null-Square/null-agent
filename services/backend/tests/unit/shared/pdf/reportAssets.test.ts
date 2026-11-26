import { describe, expect, it } from 'vitest';
import { mermaidScriptSource, reportFontFaces } from '@/shared/pdf/reportAssets';

describe('report assets', () => {
  it('embeds the report fonts from installed packages, with no network address', () => {
    const css = reportFontFaces();
    expect(css.match(/@font-face/g)).toHaveLength(8);
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain("font-family: 'JetBrains Mono'");
    expect(css).toContain('url(data:font/woff2;base64,');
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('inlines the installed mermaid build so a CDN never runs beside a report, and it cannot close its own script tag', () => {
    const source = mermaidScriptSource();
    expect(source.length).toBeGreaterThan(100_000);
    expect(source).not.toMatch(/<\/script/i);
  });
});
