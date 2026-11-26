import { useEffect, useState, useMemo } from 'react';
import mermaid from 'mermaid';
import { toApiError } from '@/shared/lib/apiError';

/**
 * Diagrams are drawn from the brand tokens, not from literals.
 *
 * The theme this replaces used #888888, #1a1a1a, #2d2d2d and #444444 — four
 * greys, in a system whose first rule is black and bone with no greys — and
 * gave every node a yellow border, spending the one signal colour on
 * decoration. A diagram in prose is prose: bone strokes on black, and the
 * yellow stays available for the thing that actually needs you.
 *
 * Values are read from the live CSS variables, so a diagram follows the light
 * theme too. Keyed by theme so a switch re-initialises and re-renders.
 */
const readBrandTheme = () => {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;

  const ground = token('--ns-bg', '#000000');
  const bone = token('--ns-fg', '#F5F5F7');
  const line = token('--ns-line', 'rgba(245, 245, 247, 0.11)');
  const muted = token('--ns-fg-muted', 'rgba(245, 245, 247, 0.62)');
  const surface = token('--ns-card', '#08080A');

  return {
    background: ground,
    primaryColor: surface,
    primaryTextColor: bone,
    primaryBorderColor: muted,
    secondaryColor: surface,
    tertiaryColor: ground,
    mainBkg: surface,
    nodeBorder: muted,
    lineColor: muted,
    clusterBkg: ground,
    clusterBorder: line,
    titleColor: bone,
    textColor: bone,
    edgeLabelBackground: ground,
    nodeTextColor: bone,
  };
};

let mermaidTheme: string | null = null;
let mermaidRenderSequence = 0;

// Cache rendered diagrams to prevent flickering on parent re-renders
const renderCache = new Map<string, string>();

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

const createMermaidRenderContainer = (svgId: string): HTMLDivElement => {
  const container = document.createElement('div');
  container.setAttribute('data-mermaid-render-container', svgId);
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '-10000px';
  container.style.width = '1000px';
  container.style.height = '1000px';
  container.style.overflow = 'hidden';
  container.style.pointerEvents = 'none';
  container.style.visibility = 'hidden';
  document.body.appendChild(container);
  return container;
};

const cleanupMermaidRenderArtifacts = (svgId: string, renderContainer?: HTMLElement | null): void => {
  if (typeof document === 'undefined') return;
  renderContainer?.remove();
  for (const id of [svgId, `d${svgId}`, `i${svgId}`]) {
    document.getElementById(id)?.remove();
  }
  document
    .querySelectorAll(`[data-mermaid-render-container="${svgId}"]`)
    .forEach((node) => node.remove());
};

/**
 * MermaidDiagram - Renders a Mermaid diagram from markdown code
 * Uses caching to prevent flickering on parent re-renders
 */
export function MermaidDiagram({ chart, className = '' }: MermaidDiagramProps) {
  // Stable hash for the chart content
  const chartHash = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < chart.length; i++) {
      const chr = chart.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }, [chart]);
  
  const [svg, setSvg] = useState<string>(() => renderCache.get(chartHash) || '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = renderCache.get(chartHash);
    if (cached) {
      setError(null);
      setSvg(cached);
      return;
    }
    
    // Re-initialise when the theme changes: mermaid bakes colours into the SVG
    // at render time, so cached output from the other theme is stale.
    const activeTheme = document.body.classList.contains('light-mode') ? 'light' : 'dark';
    if (mermaidTheme !== activeTheme) {
      if (mermaidTheme !== null) renderCache.clear();
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'loose',
        suppressErrorRendering: true,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--ns-sans').trim()
          || 'Inter, system-ui, sans-serif',
        themeVariables: readBrandTheme(),
      });
      mermaidTheme = activeTheme;
      mermaid.setParseErrorHandler?.(() => undefined);
    }


    let cancelled = false;
    const svgId = `mermaid-${chartHash}-${Date.now()}-${++mermaidRenderSequence}`;
    
    const renderDiagram = async () => {
      if (!chart.trim()) return;
      let renderContainer: HTMLDivElement | null = null;

      try {
        setError(null);
        setSvg('');

        const parseResult = await mermaid.parse(chart, { suppressErrors: true });
        if (!parseResult) {
          throw new Error('Invalid Mermaid diagram syntax.');
        }

        renderContainer = createMermaidRenderContainer(svgId);
        const { svg: renderedSvg } = await mermaid.render(svgId, chart, renderContainer);
        cleanupMermaidRenderArtifacts(svgId, renderContainer);
        renderContainer = null;
        
        if (!cancelled) {
          renderCache.set(chartHash, renderedSvg);
          setSvg(renderedSvg);
        }
      } catch (error: unknown) {
        cleanupMermaidRenderArtifacts(svgId, renderContainer);
        const apiError = toApiError(error);
        if (!cancelled) {
          console.warn('[MermaidDiagram] Render failed:', apiError);
          setError(apiError.message);
          setSvg('');
        }
      }
    };

    renderDiagram();
    
    return () => {
      cancelled = true;
      cleanupMermaidRenderArtifacts(svgId);
    };
  }, [chart, chartHash]);

  if (error) {
    return (
      <div
        className={`mermaid-fallback my-6 border border-border p-4 ${className}`}
        data-testid="mermaid-fallback"
      >
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground font-mono">
          {chart}
        </pre>
      </div>
    );
  }

  if (svg) {
    return (
      <div 
        className={`mermaid-diagram scrollbar-slim my-6 flex justify-center overflow-x-auto border border-border p-4 ${className}`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  return (
    <div className={`mermaid-diagram my-6 flex justify-center border border-border p-4 ${className}`}>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="ns-live-mark" aria-hidden />
        Loading diagram
      </div>
    </div>
  );
}

export default MermaidDiagram;
