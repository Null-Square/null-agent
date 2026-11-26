import { marked, type Tokens } from 'marked';
import { mermaidScriptSource, reportFontFaces } from './reportAssets';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@/shared/logger';
import { PDF_PAGE_LOAD_MS, PDF_ASSET_DELAY_MS } from '@/config/timeouts';
import { CHROMIUM_LAUNCH_ARGS, createChromiumRuntime, type ChromiumRuntime } from '@/shared/browser/chromiumRuntime';
import type { Browser, Page } from 'puppeteer';

// Puppeteer types - runtime import remains dynamic

export interface PdfReportOptions {
  markdown: string;
  sessionId: string;
  title: string;
  taskName?: string;
  createdAt: Date;
  userId?: string;
  /** Platform/issuer name shown in the bottom band and signature (e.g. NULLSQUARE). */
  orgName?: string;
  /** Client organization name shown as "Prepared for" on the cover. */
  clientOrgName?: string;
  classification?: 'CONFIDENTIAL' | 'INTERNAL' | 'PUBLIC';
  imageAssets?: PdfReportImageAsset[];
}

export interface PdfReportImageAsset {
  sourcePaths: string[];
  dataUrl: string;
}

/**
 * A report page loads nothing from anywhere: what it shows is embedded (data: URIs, inline fonts and
 * mermaid), and HTML the agent wrote into a finding must not make this backend fetch an address.
 */
async function sealReportPage(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url === 'about:blank') {
      void request.continue();
    } else {
      void request.abort('blockedbyclient');
    }
  });
}

// Load a logo asset as a base64 data URL. `variant` selects between the white
// logo (used on the dark cover) and the dark logo (used on white pages).
function loadLogoBase64(variant: 'light' | 'dark' = 'light'): string | null {
  const filename = variant === 'light' ? 'fulllogolight.png' : 'fulllogodark.png';
  const fullLogoPath = path.join(__dirname, '..', 'assets', filename);

  if (fs.existsSync(fullLogoPath)) {
    try {
      const buffer = fs.readFileSync(fullLogoPath);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (err) {
      logger.warn({ path: fullLogoPath, err }, '[PdfReportService] Failed to read logo file');
    }
  }

  return null;
}

// Brand fonts
const BRAND_FONTS = {
  heading: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
  body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', Consolas, 'Courier New', monospace",
};

const normalizeReportImagePath = (value: string): string => {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original value when it is not valid URI-encoded text.
  }

  return decoded
    .replace(/\\/g, '/')
    .replace(/^file:\/\/\/?/i, '')
    .replace(/^\/workspace\//i, '')
    .replace(/^workspace\//i, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeHtmlText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

type BrowserLaunchResult = {
  browser: Browser;
  runtime: ChromiumRuntime;
};

export class PdfReportService {
  private pdfLogger = logger.child({ scope: 'PdfReportService' });

  private async launchBrowser(): Promise<BrowserLaunchResult> {
    const puppeteer = await import('puppeteer');

    const runtime = await createChromiumRuntime('nullai-pdf', {
      userDataDir: process.env.PUPPETEER_USER_DATA_DIR,
    });

    this.pdfLogger.debug(
      { executablePath: runtime.executablePath, userDataDir: runtime.userDataDir, runtimeRootDir: runtime.rootDir },
      'Launching Puppeteer browser',
    );

    try {
      const browser = await puppeteer.default.launch({
        headless: true,
        executablePath: runtime.executablePath,
        env: runtime.env,
        userDataDir: runtime.userDataDir,
        args: CHROMIUM_LAUNCH_ARGS,
      });
      return { browser, runtime };
    } catch (error) {
      await runtime.cleanup().catch(() => {});
      throw error;
    }
  }

  async generateReport(options: PdfReportOptions): Promise<Buffer> {
    const {
      markdown,
      sessionId,
      title,
      taskName,
      createdAt,
      orgName = 'NULLSQUARE',
      clientOrgName,
      classification = 'CONFIDENTIAL',
      imageAssets = [],
    } = options;

    const startTime = Date.now();
    this.pdfLogger.info({ sessionId, classification }, 'Starting PDF generation');

    let browser: Browser | null = null;
    let runtime: ChromiumRuntime | null = null;

    try {
      const launchResult = await this.launchBrowser();
      browser = launchResult.browser;
      runtime = launchResult.runtime;
      const page = await browser.newPage();
      await sealReportPage(page);

      try {
        // Convert markdown to HTML.
        let htmlContent = await this.renderMarkdown(markdown, imageAssets);

        // Transform mermaid code blocks into proper mermaid divs
        htmlContent = htmlContent.replace(
          /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
          '<pre class="mermaid">$1</pre>'
        );

        // Only inline mermaid when the body actually has mermaid diagrams.
        // Avoids a network-idle stall on environments with slow CDN access.
        const needsMermaid = /<pre class="mermaid">/.test(htmlContent);

        // Load logos: light for the dark cover, dark for white running headers
        const logoBase64 = loadLogoBase64('light');
        const logoDarkBase64 = loadLogoBase64('dark') ?? logoBase64;

        // 1) Render cover-only PDF: no header/footer, no margins → full bleed.
        const coverHtml = this.buildCoverHtml({
          sessionId,
          title,
          taskName,
          createdAt,
          orgName,
          clientOrgName,
          classification,
          logoBase64,
        });
        await page.setContent(coverHtml, { waitUntil: 'load', timeout: PDF_PAGE_LOAD_MS });
        const coverPdfBytes = await page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: false,
          margin: { top: '0', bottom: '0', left: '0', right: '0' },
        });

        // 2) Render body-only PDF: with running header/footer + margins.
        const bodyHtml = this.buildBodyHtml({
          htmlContent,
          sessionId,
          title,
          orgName,
          classification,
          includeMermaid: needsMermaid,
        });
        await page.setContent(bodyHtml, { waitUntil: 'load', timeout: PDF_PAGE_LOAD_MS });

        // Wait for mermaid to render if present
        if (needsMermaid) {
          await page.evaluate((delayMs: number) => {
            return new Promise<void>((resolve) => {
              // @ts-expect-error window.mermaid is injected at runtime
              if (typeof window.mermaid !== 'undefined') {
                setTimeout(resolve, delayMs);
              } else {
                resolve();
              }
            });
          }, PDF_ASSET_DELAY_MS);
        }

        const bodyPdfBytes = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '70px', bottom: '50px', left: '40px', right: '40px' },
          displayHeaderFooter: true,
          headerTemplate: this.getHeaderTemplate({
            orgName,
            sessionId,
            title,
            classification,
            logoDarkBase64,
          }),
          footerTemplate: this.getFooterTemplate(orgName),
        });

        // 3) Merge cover + body into a single PDF with pdf-lib.
        const { PDFDocument } = await import('pdf-lib');
        const merged = await PDFDocument.create();
        const coverDoc = await PDFDocument.load(coverPdfBytes);
        const bodyDoc = await PDFDocument.load(bodyPdfBytes);
        const coverPages = await merged.copyPages(coverDoc, coverDoc.getPageIndices());
        coverPages.forEach((p) => merged.addPage(p));
        const bodyPages = await merged.copyPages(bodyDoc, bodyDoc.getPageIndices());
        bodyPages.forEach((p) => merged.addPage(p));
        const mergedBytes = await merged.save();
        const finalBuffer = Buffer.from(mergedBytes);

        const duration = Date.now() - startTime;
        this.pdfLogger.info({ sessionId, durationMs: duration, bytes: finalBuffer.length }, 'PDF generation completed');

        return finalBuffer;
      } finally {
        await page.close().catch(() => {});
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.pdfLogger.error({ sessionId, err: error, durationMs: duration }, 'PDF generation failed');
      throw error;
    } finally {
      if (browser) {
        await browser.close().catch((err: Error) => {
          this.pdfLogger.warn({ err }, 'Failed to close browser');
        });
      }
      if (runtime) {
        const runtimeRootDir = runtime.rootDir;
        await runtime.cleanup().catch((err: Error) => {
          this.pdfLogger.warn({ err, runtimeRootDir }, 'Failed to clean up Chromium runtime dir');
        });
      }
    }
  }

  private resolveReportImageDataUrl(href: string, imageAssets: PdfReportImageAsset[]): string | undefined {
    const normalizedHref = normalizeReportImagePath(href);
    if (!normalizedHref) {
      return undefined;
    }

    for (const imageAsset of imageAssets) {
      for (const sourcePath of imageAsset.sourcePaths) {
        const normalizedSource = normalizeReportImagePath(sourcePath);
        if (
          normalizedHref === normalizedSource ||
          normalizedSource.endsWith(`/${normalizedHref}`) ||
          normalizedHref.endsWith(`/${normalizedSource}`)
        ) {
          return imageAsset.dataUrl;
        }
      }
    }

    return undefined;
  }

  private async renderMarkdown(markdown: string, imageAssets: PdfReportImageAsset[] = []): Promise<string> {
    const renderer = new marked.Renderer();

    renderer.image = (token: Tokens.Image): string => {
      const href = token.href ?? '';
      const resolvedDataUrl = this.resolveReportImageDataUrl(href, imageAssets);
      const src = resolvedDataUrl ?? href;
      const alt = token.text ?? '';
      const caption = alt.trim();
      const title = token.title ? ` title="${escapeHtmlAttribute(token.title)}"` : '';
      const className = resolvedDataUrl ? 'report-evidence-image' : 'report-image';
      const figureClassName = resolvedDataUrl ? 'report-evidence-figure' : 'report-image-figure';
      const imageHtml = `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}"${title} class="${className}">`;

      if (!caption) {
        return imageHtml;
      }

      return `<figure class="${figureClassName}">${imageHtml}<figcaption>${escapeHtmlText(caption)}</figcaption></figure>`;
    };

    renderer.paragraph = (token: Tokens.Paragraph): string => {
      const body = renderer.parser.parseInline(token.tokens);
      const trimmed = body.trim();
      if (/^<figure\b[\s\S]*<\/figure>$/.test(trimmed)) {
        return `${trimmed}\n`;
      }

      return `<p>${body}</p>\n`;
    };

    return marked.parse(markdown, { renderer });
  }

  /** Cover-only HTML document. Rendered as PDF page 1, no header/footer. */
  private buildCoverHtml(options: {
    sessionId: string;
    title: string;
    taskName?: string;
    createdAt: Date;
    orgName: string;
    clientOrgName?: string;
    classification: string;
    logoBase64: string | null;
  }): string {
    const { sessionId, title, taskName, createdAt, orgName, clientOrgName, classification, logoBase64 } = options;
    const formattedDate = createdAt.toISOString().split('T')[0];
    const formattedTime = createdAt.toISOString().split('T')[1].split('.')[0];
    const engagementId = sessionId.substring(0, 8).toUpperCase();

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    ${this.getStyles()}
  </style>
</head>
<body>
  <div class="cover-page">
    <div class="cover-page__top-bar"></div>
    <div class="cover-page__grid-overlay"></div>

    <div class="cover-page__nav">
      ${logoBase64 ? `<img src="${logoBase64}" alt="NullSquare" class="cover-page__logo" />` : '<div></div>'}
      <div class="cover-page__classification-band">${classification}</div>
    </div>

    <div class="cover-page__content">
      <div class="cover-page__eyebrow">// Security Assessment Report</div>
      <h1 class="cover-page__title">${title}</h1>
      ${taskName ? `<div class="cover-page__subtitle">${taskName}</div>` : ''}
      ${clientOrgName ? `
      <div class="cover-page__client">
        <div class="cover-page__client-label">Prepared for</div>
        <div class="cover-page__client-name">${clientOrgName}</div>
      </div>` : ''}
      <div class="cover-page__rule"></div>
      <div class="cover-page__meta">
        <div class="cover-page__meta-item">
          <div class="cover-page__meta-label">Reference ID</div>
          <div class="cover-page__meta-value mono">${engagementId}</div>
        </div>
        <div class="cover-page__meta-item">
          <div class="cover-page__meta-label">Generated</div>
          <div class="cover-page__meta-value mono">${formattedDate}</div>
        </div>
        <div class="cover-page__meta-item">
          <div class="cover-page__meta-label">Time (UTC)</div>
          <div class="cover-page__meta-value mono">${formattedTime}</div>
        </div>
        <div class="cover-page__meta-item">
          <div class="cover-page__meta-label">Classification</div>
          <div class="cover-page__meta-value">${classification}</div>
        </div>
      </div>
    </div>

    <div class="cover-page__bottom-band">
      <div class="cover-page__bottom-text">Prepared by ${orgName} Security · null2.ai</div>
      <div class="cover-page__bottom-divider"></div>
      <div class="cover-page__bottom-text cover-page__bottom-text--muted">This document contains confidential security findings. Unauthorized distribution is prohibited.</div>
    </div>
  </div>
</body>
</html>`;
  }

  /** Body-only HTML document. Rendered as the remaining PDF pages with running header/footer. */
  private buildBodyHtml(options: {
    htmlContent: string;
    sessionId: string;
    title: string;
    orgName: string;
    classification: string;
    includeMermaid?: boolean;
  }): string {
    const { htmlContent, sessionId, title, orgName, includeMermaid = false } = options;

    const mermaidScript = includeMermaid
      ? `<script>${mermaidScriptSource()}</script>
  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      themeVariables: {
        background: '#FFFFFF',
        primaryColor: '#F2F2F0',
        primaryTextColor: '#0A0A0A',
        primaryBorderColor: '#0A0A0A',
        lineColor: '#0A0A0A',
        secondaryColor: '#F2F2F2',
        tertiaryColor: '#FAFAF9',
      },
      securityLevel: 'loose'
    });
  </script>`
      : '';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  ${mermaidScript}
  <style>
    ${this.getStyles()}
  </style>
</head>
<body>
  <div class="report-content">
    ${htmlContent}
  </div>

  <div class="report-signature">
    <div class="signature-line"></div>
    <p class="signature-text">${orgName} SECURITY ASSESSMENT</p>
    <p class="signature-id">Digital Signature: ${sessionId.substring(0, 12).toUpperCase()}</p>
  </div>
</body>
</html>`;
  }

  /** Legacy wrapper kept for the existing unit-test contract. Concatenates cover + body. */
  private buildHtmlDocument(options: {
    htmlContent: string;
    sessionId: string;
    title: string;
    taskName?: string;
    createdAt: Date;
    orgName: string;
    clientOrgName?: string;
    classification: string;
    logoBase64: string | null;
  }): string {
    const cover = this.buildCoverHtml({
      sessionId: options.sessionId,
      title: options.title,
      taskName: options.taskName,
      createdAt: options.createdAt,
      orgName: options.orgName,
      clientOrgName: options.clientOrgName,
      classification: options.classification,
      logoBase64: options.logoBase64,
    });
    const body = this.buildBodyHtml({
      htmlContent: options.htmlContent,
      sessionId: options.sessionId,
      title: options.title,
      orgName: options.orgName,
      classification: options.classification,
      includeMermaid: /<pre class="mermaid">/.test(options.htmlContent),
    });
    return cover + '\n' + body;
  }

  private getStyles(): string {
    return `
    ${reportFontFaces()}

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: ${BRAND_FONTS.body};
      font-size: 11px;
      line-height: 1.6;
      color: #0A0A0A;
      background: #ffffff;
    }


    /* ════════════════════════════════════════════════════
       COVER PAGE — full-bleed dark editorial cover
       ════════════════════════════════════════════════════ */
    .cover-page {
      position: relative;
      page-break-after: always;
      height: 100vh;
      width: 100%;
      background: #000000;
      color: #FFFFFF;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 48px 56px;
    }

    .cover-page__top-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: #FFFFFF;
    }

    .cover-page__grid-overlay {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px);
      background-size: 48px 48px;
      pointer-events: none;
      opacity: 0.7;
    }

    .cover-page__nav {
      position: relative;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 2;
    }

    .cover-page__logo {
      width: 180px;
      height: auto;
      display: block;
    }

    .cover-page__classification-band {
      font-family: ${BRAND_FONTS.mono};
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      color: #E5484D;
      border: 1px solid rgba(255, 77, 79, 0.6);
      padding: 6px 14px;
    }

    .cover-page__content {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      max-width: 640px;
      z-index: 2;
    }

    .cover-page__eyebrow {
      font-family: ${BRAND_FONTS.mono};
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.24em;
      color: #FFFFFF;
      opacity: 0.7;
      margin-bottom: 28px;
    }

    .cover-page__title {
      font-family: ${BRAND_FONTS.heading};
      font-size: 44px;
      font-weight: 900;
      line-height: 1.1;
      text-transform: uppercase;
      letter-spacing: 0.01em;
      color: #FFFFFF;
      margin-bottom: 16px;
      word-break: break-word;
    }

    .cover-page__subtitle {
      font-family: ${BRAND_FONTS.body};
      font-size: 14px;
      font-weight: 500;
      color: #FFFFFF;
      opacity: 0.7;
      margin-bottom: 24px;
    }

    .cover-page__rule {
      width: 80px;
      height: 3px;
      background: #FFFFFF;
      margin: 12px 0 36px 0;
    }

    .cover-page__client {
      margin-top: 28px;
      margin-bottom: 4px;
    }

    .cover-page__client-label {
      font-family: ${BRAND_FONTS.mono};
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      color: #FFFFFF;
      opacity: 0.5;
      margin-bottom: 6px;
    }

    .cover-page__client-name {
      font-family: ${BRAND_FONTS.heading};
      font-size: 22px;
      font-weight: 700;
      color: #FFFFFF;
      letter-spacing: 0.01em;
    }

    .cover-page__meta {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 28px;
      max-width: 560px;
    }

    .cover-page__meta-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .cover-page__meta-label {
      font-family: ${BRAND_FONTS.mono};
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: #FFFFFF;
      opacity: 0.5;
    }

    .cover-page__meta-value {
      font-family: ${BRAND_FONTS.body};
      font-size: 12px;
      font-weight: 600;
      color: #FFFFFF;
    }

    .cover-page__meta-value.mono {
      font-family: ${BRAND_FONTS.mono};
      font-size: 11px;
      font-weight: 500;
    }

    .cover-page__bottom-band {
      position: relative;
      display: flex;
      align-items: center;
      gap: 18px;
      padding-top: 18px;
      border-top: 1px solid rgba(255,255,255,0.15);
      z-index: 2;
    }

    .cover-page__bottom-text {
      font-family: ${BRAND_FONTS.mono};
      font-size: 9px;
      font-weight: 500;
      color: #FFFFFF;
      letter-spacing: 0.04em;
    }

    .cover-page__bottom-text--muted {
      opacity: 0.5;
      max-width: 320px;
      margin-left: auto;
      text-align: right;
    }

    .cover-page__bottom-divider {
      width: 1px;
      height: 14px;
      background: rgba(255,255,255,0.3);
    }

    /* ════════════════════════════════════════════════════
       REPORT BODY — clean monochrome typography
       ════════════════════════════════════════════════════ */
    .report-content {
      padding: 24px 0;
      background: #ffffff;
    }

    .report-content h1 {
      font-family: ${BRAND_FONTS.heading};
      font-size: 24px;
      font-weight: 900;
      color: #0A0A0A;
      border-bottom: 3px solid #0A0A0A;
      padding-bottom: 12px;
      margin: 40px 0 20px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .report-content h2 {
      font-family: ${BRAND_FONTS.heading};
      font-size: 18px;
      font-weight: 700;
      color: #0A0A0A;
      margin: 32px 0 16px 0;
      padding-left: 14px;
      border-left: 4px solid #0A0A0A;
    }

    .report-content h3 {
      font-family: ${BRAND_FONTS.heading};
      font-size: 14px;
      font-weight: 600;
      margin: 24px 0 12px 0;
      text-transform: uppercase;
      color: #676767;
      letter-spacing: 0.5px;
    }

    .report-content p {
      margin-bottom: 12px;
      line-height: 1.7;
    }

    .report-content ul, .report-content ol {
      margin: 12px 0 12px 24px;
    }

    .report-content li {
      margin-bottom: 6px;
    }

    .report-content strong {
      font-weight: 700;
      color: #0A0A0A;
    }

    /* Code blocks */
    .report-content pre {
      background: #F2F2F2;
      border: 1px solid #E4E4E4;
      border-left: 4px solid #0A0A0A;
      padding: 16px;
      margin: 16px 0;
      overflow-x: auto;
      font-family: ${BRAND_FONTS.mono};
      font-size: 10px;
      line-height: 1.5;
    }

    .report-content code {
      font-family: ${BRAND_FONTS.mono};
      font-size: 10px;
      background: #F2F2F2;
      padding: 2px 6px;
      /* BRAND-BOUNDARY-ALLOW — square is the brand rule, and the CI
         square-corners rule is the stale half of that pair. */
      border-radius: 0;
    }

    .report-content pre code {
      background: none;
      padding: 0;
    }

    /* Tables */
    .report-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 10px;
    }

    .report-content th {
      background: #0A0A0A;
      color: #ffffff;
      font-family: ${BRAND_FONTS.heading};
      font-weight: 700;
      text-transform: uppercase;
      padding: 12px 8px;
      text-align: left;
      font-size: 9px;
      letter-spacing: 0.5px;
    }

    .report-content td {
      padding: 10px 8px;
      border-bottom: 1px solid #E4E4E4;
    }

    .report-content tr:nth-child(even) {
      background: #F2F2F2;
    }

    /* Blockquotes */
    .report-content blockquote {
      background: #F2F2F2;
      border-left: 4px solid #0A0A0A;
      padding: 16px;
      margin: 16px 0;
      color: #676767;
    }

    .report-content img {
      max-width: 100%;
      height: auto;
    }

    .report-content figure.report-image-figure,
    .report-content figure.report-evidence-figure {
      margin: 18px auto;
      text-align: center;
      page-break-inside: avoid;
    }

    .report-content figure.report-image-figure img,
    .report-content figure.report-evidence-figure img {
      margin: 0 auto;
    }

    .report-content figure figcaption {
      margin-top: 8px;
      font-family: ${BRAND_FONTS.mono};
      font-size: 9px;
      line-height: 1.5;
      color: #676767;
    }

    .report-content img.report-evidence-image {
      display: block;
      max-height: 520px;
      object-fit: contain;
      margin: 18px auto;
      border: 1px solid #BFBFBF;
      background: #F2F2F2;
      page-break-inside: avoid;
    }

    /* Horizontal rules */
    .report-content hr {
      border: none;
      border-top: 1px solid #E4E4E4;
      margin: 32px 0;
    }

    /* Mermaid diagrams */
    .mermaid {
      margin: 20px 0;
      text-align: center;
    }

    .mermaid svg {
      max-width: 100%;
      height: auto;
    }

    /* Report Signature */
    .report-signature {
      margin-top: 60px;
      padding-top: 40px;
      border-top: 2px solid #0A0A0A;
      text-align: center;
      page-break-inside: avoid;
    }

    .signature-line {
      width: 200px;
      height: 1px;
      background: #0A0A0A;
      margin: 0 auto 16px auto;
    }

    .signature-text {
      font-family: ${BRAND_FONTS.heading};
      font-size: 12px;
      font-weight: 700;
      color: #0A0A0A;
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    .signature-id {
      font-family: ${BRAND_FONTS.mono};
      font-size: 10px;
      color: #676767;
      margin-top: 8px;
    }

    /* Print styles */
    @media print {
      .cover-page {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .report-signature {
        page-break-inside: avoid;
      }
    }
    `;
  }

  private getHeaderTemplate(opts: {
    orgName: string;
    sessionId: string;
    title: string;
    classification: string;
    logoDarkBase64: string | null;
  }): string {
    const { sessionId, title, classification, logoDarkBase64 } = opts;
    const engagementId = sessionId.substring(0, 8).toUpperCase();
    const escapedTitle = title.replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c] as string));
    const truncatedTitle = escapedTitle.length > 60 ? escapedTitle.substring(0, 57) + '...' : escapedTitle;

    return `
      <div style="width: 100%; padding: 12px 40px 0 40px; font-family: 'Inter', sans-serif; font-size: 8px; color: #0A0A0A; -webkit-print-color-adjust: exact; print-color-adjust: exact; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #E4E4E4;">
        <div style="display: flex; align-items: center; gap: 14px; flex: 0 0 auto;">
          ${logoDarkBase64 ? `<img src="${logoDarkBase64}" style="height: 14px; width: auto; display: block;" />` : ''}
          <span style="font-family: 'JetBrains Mono', monospace; font-size: 8px; font-weight: 600; letter-spacing: 0.08em; color: #676767;">${engagementId}</span>
        </div>
        <div style="flex: 1; text-align: center; font-family: 'Inter', sans-serif; font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #676767; padding: 0 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          ${truncatedTitle}
        </div>
        <div style="flex: 0 0 auto; font-family: 'JetBrains Mono', monospace; font-size: 8px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #E5484D; border: 1px solid rgba(229, 72, 77, 0.5); padding: 3px 8px;">
          ${classification}
        </div>
      </div>
    `;
  }

  private getFooterTemplate(orgName: string): string {
    return `
      <div style="width: 100%; padding: 0 40px 10px 40px; font-family: 'JetBrains Mono', monospace; font-size: 8px; color: #676767; -webkit-print-color-adjust: exact; print-color-adjust: exact; display: flex; align-items: center; justify-content: space-between;">
        <span style="letter-spacing: 0.06em;">${orgName} · null2.ai</span>
        <span style="letter-spacing: 0.06em;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `;
  }
}

// Singleton instance
let pdfServiceInstance: PdfReportService | null = null;

export function getPdfReportService(): PdfReportService {
  if (!pdfServiceInstance) {
    pdfServiceInstance = new PdfReportService();
  }
  return pdfServiceInstance;
}
