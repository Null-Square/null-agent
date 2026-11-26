import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RunReportPdfDocument from './RunReportPdfDocument';
import type { SessionArtifact } from '@/types/chat';

const { downloadArtifactBlobMock } = vi.hoisted(() => ({
  downloadArtifactBlobMock: vi.fn(),
}));

vi.mock('@modules/sessions', () => ({
  downloadArtifactBlob: (...args: unknown[]) => downloadArtifactBlobMock(...args),
}));

vi.mock('@shared/ui/MermaidDiagram', () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

describe('RunReportPdfDocument', () => {
  const createObjectUrl = vi.fn(() => 'blob:report-screenshot');
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    downloadArtifactBlobMock.mockReset();
    downloadArtifactBlobMock.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
  });

  it('renders artifact-backed screenshot markdown as an inline image', async () => {
    const screenshotArtifact: SessionArtifact = {
      id: 'artifact-screenshot',
      filePath: 'sessions/session-1/.artifacts/browser/screenshots/login.png',
      originalName: '.artifacts/browser/screenshots/login.png',
      fileType: 'png',
      mimeType: 'image/png',
      sizeBytes: 256,
      createdAt: Date.now(),
    };

    render(
      <RunReportPdfDocument
        title="Demo Report"
        markdown="![Browser screenshot](.artifacts/browser/screenshots/login.png)"
        sessionId="session-1"
        artifacts={[screenshotArtifact]}
      />,
    );

    expect(screen.getByText('Loading image evidence')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByAltText('Browser screenshot')).toHaveAttribute('src', 'blob:report-screenshot');
    });

    const caption = screen.getByText('Browser screenshot');
    expect(caption.tagName).toBe('FIGCAPTION');
    expect(downloadArtifactBlobMock).toHaveBeenCalledWith('session-1', 'artifact-screenshot');
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });
});
