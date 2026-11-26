import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const setupMermaid = async (
  renderImpl: ReturnType<typeof vi.fn>,
  parseImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ diagramType: 'flowchart-v2' }),
) => {
  vi.resetModules();
  const initialize = vi.fn();
  const setParseErrorHandler = vi.fn();
  vi.doMock('mermaid', () => ({
    default: {
      initialize,
      parse: parseImpl,
      render: renderImpl,
      setParseErrorHandler,
    },
  }));

  const module = await import('./MermaidDiagram');
  return { MermaidDiagram: module.MermaidDiagram, initialize, parse: parseImpl, setParseErrorHandler };
};

describe('MermaidDiagram', () => {
  it('renders SVG output from mermaid', async () => {
    const renderMock = vi.fn().mockImplementation(async (_svgId: string, _chart: string, container: HTMLElement) => {
      expect(document.body.contains(container)).toBe(true);
      return { svg: '<svg data-testid="diagram"></svg>' };
    });
    const { MermaidDiagram } = await setupMermaid(renderMock);

    const { container } = render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Mermaid source when rendering fails', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderMock = vi.fn().mockRejectedValue(new Error('boom'));
    const { MermaidDiagram } = await setupMermaid(renderMock);

    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    expect(await screen.findByTestId('mermaid-fallback')).toHaveTextContent('graph TD; A-->B;');
    expect(screen.queryByText('Diagram Error')).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it('suppresses Mermaid error SVG rendering and installs a no-op parse handler', async () => {
    const renderMock = vi.fn().mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' });
    const { MermaidDiagram, initialize, setParseErrorHandler } = await setupMermaid(renderMock);

    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await screen.findByTestId('diagram');

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        suppressErrorRendering: true,
      }),
    );
    expect(setParseErrorHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it('does not call render when Mermaid syntax validation fails', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderMock = vi.fn();
    const parseMock = vi.fn().mockResolvedValue(false);
    const { MermaidDiagram } = await setupMermaid(renderMock, parseMock);

    render(<MermaidDiagram chart="graph TD\nA--->>BROKEN[" />);

    expect(await screen.findByTestId('mermaid-fallback')).toHaveTextContent('A--->>BROKEN[');
    expect(screen.queryByText('Diagram Error')).not.toBeInTheDocument();
    expect(screen.queryByText('Invalid Mermaid diagram syntax.')).not.toBeInTheDocument();
    expect(renderMock).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('removes temporary Mermaid nodes when rendering rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderMock = vi.fn().mockImplementation(async (svgId: string) => {
      const leaked = document.createElement('div');
      leaked.id = `d${svgId}`;
      document.body.appendChild(leaked);
      throw new Error('render failed');
    });
    const { MermaidDiagram } = await setupMermaid(renderMock);

    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    expect(await screen.findByTestId('mermaid-fallback')).toBeInTheDocument();
    expect(document.querySelector('[id^="dmermaid-"]')).toBeNull();
    expect(document.querySelector('[data-mermaid-render-container]')).toBeNull();

    consoleSpy.mockRestore();
  });

  it('contains real Mermaid syntax failures without leaking generated error diagrams', async () => {
    vi.resetModules();
    vi.doUnmock('mermaid');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { MermaidDiagram } = await import('./MermaidDiagram');

    render(<MermaidDiagram chart="not a mermaid diagram" />);

    expect(await screen.findByTestId('mermaid-fallback')).toHaveTextContent('not a mermaid diagram');
    expect(screen.queryByText('Diagram Error')).not.toBeInTheDocument();
    expect(screen.queryByText('Invalid Mermaid diagram syntax.')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Syntax error in text');
    expect(document.querySelector('[id^="dmermaid-"], [id^="imermaid-"]')).toBeNull();
    expect(document.querySelector('[data-mermaid-render-container]')).toBeNull();

    consoleSpy.mockRestore();
  }, 30_000);
});
