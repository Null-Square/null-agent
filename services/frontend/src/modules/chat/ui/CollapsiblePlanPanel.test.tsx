import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { CollapsiblePlanPanel } from './CollapsiblePlanPanel';

vi.mock('@modules/chat/model/AIChatContext', () => ({
  useAIChat: vi.fn(),
}));

const mockUseAIChat = vi.mocked(useAIChat);
type AIChatValue = ReturnType<typeof useAIChat>;

describe('CollapsiblePlanPanel', () => {
  it('returns null when no plan steps exist', () => {
    mockUseAIChat.mockReturnValue({ plan: [] } as unknown as AIChatValue);

    render(<CollapsiblePlanPanel />);

    expect(screen.queryByText('EXECUTION PLAN')).toBeNull();
  });

  it('renders plan summary and steps', () => {
    mockUseAIChat.mockReturnValue({
      plan: [
        { id: 'step-1', title: 'Recon', status: 'completed', startedAt: 0, completedAt: 1000 },
        { id: 'step-2', title: 'Scan', status: 'running', startedAt: Date.now() },
      ],
    } as unknown as AIChatValue);

    render(<CollapsiblePlanPanel />);

    expect(screen.getByText(/Execution Plan/i)).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2 Steps/i)).toBeInTheDocument();
    expect(screen.getByText('Recon')).toBeInTheDocument();
    expect(screen.getByText('Scan')).toBeInTheDocument();
  });
});
