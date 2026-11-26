import { describe, it, expect, beforeEach, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  promises: {
    mkdtemp: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
  },
}));

const puppeteerMocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

const pdfLibMocks = vi.hoisted(() => ({
  load: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  logger: {
    child: () => loggerMocks,
  },
}));

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => fsMocks.existsSync(...args),
  readFileSync: (...args: any[]) => fsMocks.readFileSync(...args),
  promises: {
    mkdtemp: (...args: any[]) => fsMocks.promises.mkdtemp(...args),
    mkdir: (...args: any[]) => fsMocks.promises.mkdir(...args),
    rm: (...args: any[]) => fsMocks.promises.rm(...args),
  },
}));

vi.mock('@/shared/pdf/reportAssets', () => ({
  reportFontFaces: () => '/* local fonts */',
  mermaidScriptSource: () => '/* local mermaid */',
}));
vi.mock('puppeteer', () => ({
  default: {
    launch: (...args: any[]) => puppeteerMocks.launch(...args),
  },
}));

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: (...args: any[]) => pdfLibMocks.load(...args),
    create: (...args: any[]) => pdfLibMocks.create(...args),
  },
}));

describe('PdfReportService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.promises.mkdtemp.mockResolvedValue('C:\\temp\\nullai-pdf-test');
    fsMocks.promises.mkdir.mockResolvedValue(undefined);
    fsMocks.promises.rm.mockResolvedValue(undefined);
  });

  it('builds HTML with classification, org, and task name', async () => {
    const { PdfReportService } = await import('@/shared/pdf/PdfReportService');
    const service = new PdfReportService();

    const html = (service as any).buildHtmlDocument({
      htmlContent: '<h1>Report</h1>',
      sessionId: '12345678-1234-1234-1234-123456789abc',
      title: 'Security Report',
      taskName: 'Scan',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      orgName: 'ACME',
      classification: 'INTERNAL',
      logoBase64: 'data:image/png;base64,abc',
    });

    expect(html).toContain('ACME SECURITY ASSESSMENT');
    expect(html).toContain('/* local fonts */');
    expect(html).not.toMatch(/fonts\.googleapis|cdn\.jsdelivr|https?:\/\/[^"' ]+\.(?:js|css)/);
    expect(html).toContain('INTERNAL');
    expect(html).toContain('Scan');
    expect(html).toContain('data:image/png;base64,abc');
  });

  it('inlines report-safe screenshot image references in rendered markdown', async () => {
    const { PdfReportService } = await import('@/shared/pdf/PdfReportService');
    const service = new PdfReportService();

    const html = await (service as any).renderMarkdown(
      '![Browser screenshot](.artifacts/browser/screenshots/login.png)',
      [
        {
          sourcePaths: ['.artifacts/browser/screenshots/login.png'],
          dataUrl: 'data:image/png;base64,abc123',
        },
      ],
    );

    expect(html).toContain('src="data:image/png;base64,abc123"');
    expect(html).toContain('alt="Browser screenshot"');
    expect(html).toContain('class="report-evidence-image"');
    expect(html).toContain('<figure class="report-evidence-figure">');
    expect(html).toContain('<figcaption>Browser screenshot</figcaption>');
  });

  it('generates a PDF using puppeteer with an embedded logo', async () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(Buffer.from('logo'));

    const page = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      setContent: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      pdf: vi.fn().mockResolvedValue(Buffer.from('pdf')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    puppeteerMocks.launch.mockResolvedValue(browser);

    const sourceDoc = {
      getPageIndices: vi.fn().mockReturnValue([0]),
    };
    const mergedDoc = {
      copyPages: vi.fn().mockResolvedValue([{ id: 'page' }]),
      addPage: vi.fn(),
      save: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    };
    pdfLibMocks.load.mockResolvedValue(sourceDoc);
    pdfLibMocks.create.mockResolvedValue(mergedDoc);

    const { PdfReportService } = await import('@/shared/pdf/PdfReportService');
    const service = new PdfReportService();

    const result = await service.generateReport({
      markdown: '# Title',
      sessionId: '12345678-1234-1234-1234-123456789abc',
      title: 'Report',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      orgName: 'ACME',
      classification: 'PUBLIC',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(page.setContent).toHaveBeenCalledTimes(2);
    // The report page loads nothing: only embedded data passes, every address is refused.
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    const onRequest = page.on.mock.calls.find(([event]) => event === 'request')?.[1];
    const request = (url: string) => ({ url: () => url, continue: vi.fn(), abort: vi.fn() });
    const embedded = request('data:image/png;base64,abc');
    const internal = request('http://host.docker.internal:25432/');
    const cdn = request('https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js');
    for (const r of [embedded, internal, cdn]) onRequest(r);
    expect(embedded.continue).toHaveBeenCalled();
    expect(internal.abort).toHaveBeenCalled();
    expect(cdn.abort).toHaveBeenCalled();
    const coverHtml = page.setContent.mock.calls[0][0] as string;
    expect(coverHtml).toContain('data:image/png;base64');
    expect(coverHtml).toContain('cover-page');
    const bodyHtml = page.setContent.mock.calls[1][0] as string;
    expect(bodyHtml).toContain('report-content');
    expect(page.pdf).toHaveBeenCalledTimes(2);
    expect(mergedDoc.addPage).toHaveBeenCalled();
    expect(puppeteerMocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: expect.stringContaining('nullai-pdf-test'),
          XDG_CONFIG_HOME: expect.stringContaining('nullai-pdf-test'),
          XDG_CACHE_HOME: expect.stringContaining('nullai-pdf-test'),
        }),
        userDataDir: expect.stringContaining('nullai-pdf-test'),
      }),
    );
  });

  it('keeps a singleton instance', async () => {
    const { PdfReportService, getPdfReportService } = await import('@/shared/pdf/PdfReportService');
    const instance1 = getPdfReportService();
    const instance2 = getPdfReportService();

    expect(instance1).toBe(instance2);
    expect(instance1).toBeInstanceOf(PdfReportService);
  });
});
