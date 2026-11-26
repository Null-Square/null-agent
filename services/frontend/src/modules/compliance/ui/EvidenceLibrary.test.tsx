/* @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { useComplianceEvidenceQuery } from '@/modules/security-ops/api';
import { EvidenceLibrary } from './EvidenceLibrary';

vi.mock('@/modules/security-ops/api', () => ({
  downloadComplianceEvidenceFile: vi.fn(),
  useComplianceEvidenceQuery: vi.fn(),
  useDeleteComplianceEvidenceMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateComplianceEvidenceMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

const mockUseComplianceEvidenceQuery = vi.mocked(useComplianceEvidenceQuery);

describe('EvidenceLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseComplianceEvidenceQuery.mockReturnValue({
      data: [],
      isLoading: false,
    } as never);
  });

  it('shows all evidence sources by default so synced integrations are visible', () => {
    render(
      <EvidenceLibrary
        scopeId="00000000-0000-0000-0000-0000000000a1"
        frameworkKey="soc2"
      />,
    );

    expect(screen.getByText('All sources')).toBeInTheDocument();
    expect(mockUseComplianceEvidenceQuery).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-0000000000a1',
      'soc2',
      null,
      null,
    );
  });

  it('queries GDPR evidence when the GDPR framework is selected', () => {
    render(
      <EvidenceLibrary
        scopeId="00000000-0000-0000-0000-0000000000a1"
        frameworkKey="gdpr"
      />,
    );

    expect(mockUseComplianceEvidenceQuery).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-0000000000a1',
      'gdpr',
      null,
      null,
    );
  });
});
