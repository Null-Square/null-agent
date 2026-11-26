import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AssetDetailPage from './AssetDetailPage';
import type { Asset, AssetScanCoverage, Finding, InventoryService, Run } from '@/modules/security-ops/types';
import {
  useAssetDetailQuery,
  useAssetEndpointsQuery,
  useAssetFindingsQuery,
  useAssetScanCoverageQuery,
  useAssetServicesQuery,
  useAssetSubdomainsQuery,
  useAssetTechQuery,
  useRunsQuery,
} from '@/modules/security-ops/api';

vi.mock('@/modules/security-ops/api', () => ({
  useAssetDetailQuery: vi.fn(),
  useAssetServicesQuery: vi.fn(),
  useAssetEndpointsQuery: vi.fn(),
  useAssetFindingsQuery: vi.fn(),
  useAssetScanCoverageQuery: vi.fn(),
  useAssetSubdomainsQuery: vi.fn(),
  useAssetTechQuery: vi.fn(),
  useRunsQuery: vi.fn(),
}));

vi.mock('@shared/contexts/ScopeContext', () => ({
  useScope: () => ({
    scopes: [],
    activeScopeId: null,
    setActiveScopeId: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock('@shared/ui/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

// The design system is NOT mocked — the page is composition over the shared
// detail + list kits, so these tests render the real DetailPageShell,
// StatusTabs and RecordTable, and would catch a page that grew its own again.

vi.mock('./components/AssetKindBadge', () => ({
  AssetKindBadge: ({ kind }: { kind: string }) => <span>{kind}</span>,
}));



const mockUseAssetDetailQuery = vi.mocked(useAssetDetailQuery);
const mockUseAssetServicesQuery = vi.mocked(useAssetServicesQuery);
const mockUseAssetEndpointsQuery = vi.mocked(useAssetEndpointsQuery);
const mockUseAssetFindingsQuery = vi.mocked(useAssetFindingsQuery);
const mockUseAssetScanCoverageQuery = vi.mocked(useAssetScanCoverageQuery);
const mockUseAssetSubdomainsQuery = vi.mocked(useAssetSubdomainsQuery);
const mockUseAssetTechQuery = vi.mocked(useAssetTechQuery);
const mockUseRunsQuery = vi.mocked(useRunsQuery);

const asset: Asset = {
  id: 'asset-jobs',
  kind: 'domain',
  value: 'jobs.demo.acme.io',
  tags: ['exports', 'worker'],
  scopeId: 'scope-demo-acme',
  firstSeenAt: '2026-04-06T09:17:06.000Z',
  lastSeenAt: '2026-04-06T09:24:10.000Z',
  findingCount: 1,
  serviceCount: 1,
  endpointCount: 7,
  observationCount: 12,
  subdomainCount: 0,
  focus: {
    score: 92,
    label: 'critical',
    reasons: ['Customer-facing surface', 'Business-critical customer asset'],
  },
};

const service: InventoryService = {
  id: 'service-jobs-443',
  assetId: 'asset-jobs',
  protocol: 'https',
  port: 443,
  serviceName: 'export-worker-api',
  product: 'Fastify',
  version: '5.0',
  evidence: [],
  firstSeenAt: '2026-04-06T09:17:06.000Z',
  lastSeenAt: '2026-04-06T09:24:10.000Z',
  createdAt: '2026-04-06T09:17:06.000Z',
  updatedAt: '2026-04-06T09:24:10.000Z',
};

const finding: Finding = {
  id: 'finding-demo-idor-export',
  title: 'Cross-tenant export download authorization bypass',
  severity: 'critical',
  state: "confirmed",
  assignedTo: null,
  assetId: 'asset-jobs',
  assetValue: 'jobs.demo.acme.io',
  assetKind: 'domain',
  scopeId: 'scope-demo-acme',
  scopeName: 'Acme Production Edge',
  summary: 'A valid low-privilege token could retrieve signed download URLs for export jobs owned by a different workspace.',
  businessImpact: 'Cross-tenant export data disclosure.',
  remediation: 'Bind export ownership to the caller organization.',
  cweId: 'CWE-639',
  cveId: null,
  owaspCategory: 'A01 Broken Access Control',
  firstSeenAt: '2026-04-06T09:22:11.000Z',
  lastSeenAt: '2026-04-06T09:22:11.000Z',
  createdAt: '2026-04-06T09:22:11.000Z',
  confidence: 0.98,
  evidenceCount: 2,
  cvssScore: 9.1,
  cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:L',
};

const run: Run = {
  id: 'demo-run-auth-boundary',
  displayId: '4012',
  organizationId: 'org-demo-acme',
  scopeId: 'scope-demo-acme',
  scopeName: 'Acme Production Edge',
  status: 'completed',
  goal: 'Validate export isolation.',
  trigger: 'manual',
  title: 'JWT tenant isolation and admin surface validation',
  startedAt: '2026-04-06T09:00:00.000Z',
  completedAt: '2026-04-06T09:44:30.000Z',
};

const scanCoverage: AssetScanCoverage = {
  status: 'completed',
  assessedAt: '2026-04-06T09:24:10.000Z',
  endpointsDiscovered: 7,
  findingsCreated: 1,
  technologiesDetected: 2,
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/assets/asset-jobs']}>
      <Routes>
        <Route path="/assets/:id" element={<AssetDetailPage />} />
        <Route path="/assets" element={<div>Inventory</div>} />
        <Route path="/risks/:id" element={<div>Risk Detail</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('AssetDetailPage routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAssetDetailQuery.mockReturnValue({ data: asset, isLoading: false } as never);
    mockUseAssetServicesQuery.mockReturnValue({ data: [service] } as never);
    mockUseAssetEndpointsQuery.mockReturnValue({ data: [] } as never);
    mockUseAssetFindingsQuery.mockReturnValue({ data: [finding] } as never);
    mockUseAssetScanCoverageQuery.mockReturnValue({ data: scanCoverage } as never);
    mockUseAssetSubdomainsQuery.mockReturnValue({ data: [] } as never);
    mockUseAssetTechQuery.mockReturnValue({ data: [] } as never);
    mockUseRunsQuery.mockReturnValue({ data: [run] } as never);
  });

  it('opens a tested risk at its risk detail route', () => {
    renderPage();

    // Depth tabs are the shared StatusTabs, so they carry the tab role.
    fireEvent.click(screen.getByRole('tab', { name: /tested risks/i }));

    // Risks render through the shared RecordTable, so the row is a button
    // that navigates rather than an anchor. What this guards is the
    // destination.
    fireEvent.click(
      screen.getByRole('button', { name: /open risk: cross-tenant export download authorization bypass/i }),
    );
    expect(screen.getByText('Risk Detail')).toBeInTheDocument();
  });

  it('counts a section by what it renders, not by the asset record', () => {
    // The asset claims 7 endpoints; the query returns two. The section header
    // must say 2 — the earlier version read asset.endpointCount and printed
    // "Endpoints 18" directly above "No endpoint observations recorded".
    mockUseAssetEndpointsQuery.mockReturnValue({
      data: [
        {
          id: 'ep-1',
          assetId: 'asset-jobs',
          serviceId: 'service-jobs-443',
          url: 'https://jobs.demo.acme.io/api/v1/exports',
          method: 'GET',
          statusCode: 200,
          title: 'Export index',
          evidence: [],
          firstSeenAt: '2026-04-06T09:24:10.000Z',
          lastSeenAt: '2026-04-06T09:24:10.000Z',
          createdAt: '2026-04-06T09:24:10.000Z',
          updatedAt: '2026-04-06T09:24:10.000Z',
        },
        {
          id: 'ep-2',
          assetId: 'asset-jobs',
          serviceId: 'service-jobs-443',
          url: 'https://jobs.demo.acme.io/api/v1/exports/{exportId}/download',
          method: 'GET',
          statusCode: 200,
          title: 'Signed download',
          evidence: [],
          firstSeenAt: '2026-04-06T09:22:11.000Z',
          lastSeenAt: '2026-04-06T09:22:11.000Z',
          createdAt: '2026-04-06T09:22:11.000Z',
          updatedAt: '2026-04-06T09:22:11.000Z',
        },
      ],
    } as never);

    renderPage();

    expect(asset.endpointCount).toBe(7);
    const endpointsHeading = screen.getByRole('heading', { name: /endpoints/i });
    expect(endpointsHeading).toHaveTextContent(/^Endpoints\s*2$/);
    expect(screen.getByText('https://jobs.demo.acme.io/api/v1/exports')).toBeInTheDocument();
  });

  it('renders only the curated scan coverage contract', () => {
    renderPage();

    const coverageHeading = screen.getByRole('heading', { name: /scan coverage/i });
    const coverageSection = coverageHeading.closest('section') ?? coverageHeading.parentElement;
    expect(coverageSection).not.toBeNull();
    const coverage = within(coverageSection as HTMLElement);

    expect(coverage.getByText('Status')).toBeInTheDocument();
    expect(coverage.getByText('completed')).toBeInTheDocument();
    expect(coverage.getByText('Last assessed')).toBeInTheDocument();
    expect(coverage.getByText('Endpoints found')).toBeInTheDocument();
    expect(coverage.getByText('Tested risks created')).toBeInTheDocument();
    expect(coverage.getByText('Technologies detected')).toBeInTheDocument();
    expect(screen.queryByText('v2026.04')).not.toBeInTheDocument();
    expect(screen.queryByText('request_tool')).not.toBeInTheDocument();
  });

  it('returns to the inventory from the back link', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /back to assets/i }));

    expect(screen.getByText('Inventory')).toBeInTheDocument();
  });
});
