import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MarkdownScanReport from './MarkdownScanReport';

vi.mock('@shared/ui/MermaidDiagram', () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
  default: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

describe('MarkdownScanReport', () => {
  it('renders markdown content and mermaid diagrams', () => {
    const markdown = `# Title\n\n\`\`\`mermaid\ngraph TD;\nA-->B;\n\`\`\``;

    render(<MarkdownScanReport markdown={markdown} title="Custom Report" />);

    expect(screen.getByText('Custom Report')).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByTestId('mermaid')).toHaveTextContent('graph TD;');
  });

  it('renders attachments and triggers downloads', () => {
    const onDownload = vi.fn();
    render(
      <MarkdownScanReport
        markdown="Report"
        attachments={[
          { id: 'a1', label: 'artifact.txt', path: '/tmp/artifact.txt', type: 'text' },
        ]}
        onDownloadArtifact={onDownload}
      />,
    );

    fireEvent.click(screen.getByText('artifact.txt'));
    expect(onDownload).toHaveBeenCalledWith('a1', 'artifact.txt');
  });
});
