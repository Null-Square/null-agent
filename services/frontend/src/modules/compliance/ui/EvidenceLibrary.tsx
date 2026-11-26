import {
  downloadComplianceEvidenceFile,
  useComplianceEvidenceQuery,
  useDeleteComplianceEvidenceMutation,
  useUpdateComplianceEvidenceMutation,
} from '@/modules/security-ops/api';
import type {
  ComplianceEvidenceItem,
  ComplianceEvidenceMapping,
  ComplianceEvidenceReviewStatus,
  ComplianceEvidenceSourceType,
  ComplianceEvidenceType,
  ComplianceFrameworkKey,
} from '@/modules/security-ops/types';
import { Download, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Button,
  FacetSelect,
  IconButton,
  Input,
  Label,
  ListEmptyState,
  ListMetrics,
  ListSkeleton,
  Modal,
  ModalContent,
  ModalFooter,
  NativeSelect,
  QueryBar,
  RecordTable,
  StatusPill,
  Textarea,
  type StatusTone,
} from '@null-ai/design-tokens/ui';
import { toastService } from '@shared/services/toastService';

type EvidenceControlOption = {
  id: string;
  title: string;
  frameworkKey: ComplianceFrameworkKey;
};

interface EvidenceLibraryProps {
  scopeId: string | null;
  frameworkKey: ComplianceFrameworkKey | null;
  availableControls?: EvidenceControlOption[];
  onUpload?: () => void;
}

const statusLabels: Record<ComplianceEvidenceReviewStatus, string> = {
  unreviewed: 'Awaiting agent review',
  expired: 'Expired',
};

const statusTones: Record<ComplianceEvidenceReviewStatus, StatusTone> = {
  unreviewed: 'warning',
  expired: 'neutral',
};

// Review state is lifecycle, so it is the shared pill — not a fourth badge shape.
const evidenceStatusView = (item: ComplianceEvidenceItem): { label: string; tone: StatusTone; title?: string } => {
  if (item.agentReview?.status === 'reviewed') {
    return { label: 'Agent reviewed', tone: 'success', title: item.agentReview.reason };
  }
  if (item.agentReview?.status === 'needs_more_evidence') {
    return { label: 'More evidence needed', tone: 'warning', title: item.agentReview.reason };
  }
  return {
    label: statusLabels[item.status],
    tone: statusTones[item.status],
    title: item.reviewNote ?? undefined,
  };
};

const evidenceTypeOptions: Array<{ value: ComplianceEvidenceType; label: string }> = [
  { value: 'policy', label: 'Policy' },
  { value: 'access_review', label: 'Access review' },
  { value: 'risk_register', label: 'Risk register' },
  { value: 'incident_record', label: 'Incident record' },
  { value: 'continuity_exercise', label: 'Continuity exercise' },
  { value: 'vendor_review', label: 'Vendor review' },
  { value: 'change_approval', label: 'Change approval' },
  { value: 'training_record', label: 'Training record' },
  { value: 'system_export', label: 'System export' },
  { value: 'other', label: 'Other' },
];

const toDateInput = (value: string | null | undefined): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

const dateInputToIso = (value: string): string | null =>
  value ? new Date(`${value}T23:59:59.000Z`).toISOString() : null;

export function EvidenceLibrary({ scopeId, frameworkKey, availableControls = [], onUpload }: EvidenceLibraryProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ComplianceEvidenceReviewStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<ComplianceEvidenceSourceType | 'all'>('all');
  const [editingItem, setEditingItem] = useState<ComplianceEvidenceItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ComplianceEvidenceItem | null>(null);
  const deleteEvidence = useDeleteComplianceEvidenceMutation();
  const updateEvidence = useUpdateComplianceEvidenceMutation();

  const { data: evidence = [], isLoading } = useComplianceEvidenceQuery(
    scopeId,
    frameworkKey,
    statusFilter === 'all' ? null : statusFilter,
    sourceFilter === 'all' ? null : sourceFilter,
  );

  const filteredItems = useMemo(() => {
    return evidence.filter((item) =>
      item.title.toLowerCase().includes(search.toLowerCase()) ||
      item.mappings.some((m) => m.controlId.toLowerCase().includes(search.toLowerCase())),
    );
  }, [evidence, search]);

  const confirmDelete = () => {
    if (!deleteTarget) return;

    deleteEvidence.mutate(deleteTarget.id, {
      onSuccess: () => {
        // TODO(compliance-toasts): tune evidence copy once the unified toast taxonomy is finalized.
        toastService.success('Evidence removed from the library.');
        setDeleteTarget(null);
      },
      onError: (error) => {
        toastService.error(error instanceof Error ? error.message : 'Failed to remove evidence.');
      },
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Evidence Library</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            Upload documents once. The agent describes, types, dates, and maps each file across your frameworks during a
            compliance run — uploads stay advisory and don't change readiness on their own.
          </p>
        </div>
        {onUpload ? <Button onClick={onUpload}>Upload evidence</Button> : null}
      </div>

      <ListMetrics
        label="Library posture"
        items={[
          { label: 'Items', value: evidence.length },
          {
            label: 'Awaiting review',
            value: evidence.filter((item) => item.agentReview?.status !== 'reviewed' && item.status === 'unreviewed').length,
            severity: 'high',
          },
          { label: 'Expired', value: evidence.filter((item) => item.status === 'expired').length, severity: 'critical' },
          { label: 'Unmapped', value: evidence.filter((item) => item.mappings.length === 0).length },
        ]}
      />

      <QueryBar
        aria-label="Filter evidence"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search library"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by review status"
              label="All statuses"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as ComplianceEvidenceReviewStatus | 'all')}
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'unreviewed', label: 'Awaiting agent review', swatchClass: 'bg-warning' },
                { value: 'expired', label: 'Expired', swatchClass: 'bg-muted-foreground' },
              ]}
            />
            <FacetSelect
              aria-label="Filter by source"
              label="All sources"
              value={sourceFilter}
              onChange={(value) => setSourceFilter(value as ComplianceEvidenceSourceType | 'all')}
              options={[
                { value: 'all', label: 'All sources' },
                { value: 'user_upload', label: 'User uploads' },
                { value: 'user_attestation', label: 'User attestations' },
                { value: 'agent_finding', label: 'Agent risks' },
                { value: 'integration', label: 'Integrations' },
              ]}
            />
          </>
        }
      />

      <div data-tour="compliance-evidence-queue">
        {isLoading ? (
          <ListSkeleton label="Reading your evidence" rows={4} />
        ) : filteredItems.length === 0 ? (
          <ListEmptyState
            variant="filtered"
            icon="evidence"
            title="No evidence matches this query"
            description="Widen the review status or source facet to bring items back."
          />
        ) : (
          <RecordTable
            rows={filteredItems}
            getRowKey={(item) => item.id}
            titleHeader="Title / source"
            title={(item) => item.title}
            subtitle={(item) => (
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
                {item.sourceType.replace('_', ' ')} · {item.evidenceType.replace('_', ' ')}
              </span>
            )}
            columns={[
              {
                key: 'mappings',
                header: 'Mappings',
                width: 'minmax(0,1fr)',
                render: (item) =>
                  item.mappings.length === 0 ? (
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Unmapped
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-foreground">
                      {item.mappings.slice(0, 4).map((mapping) => mapping.controlId).join(' · ')}
                      {item.mappings.length > 4 ? ` +${item.mappings.length - 4}` : ''}
                    </span>
                  ),
                showOnMobile: true,
              },
              {
                key: 'status',
                header: 'Status',
                width: '190px',
                render: (item) => {
                  const view = evidenceStatusView(item);
                  return (
                    <span className="block" title={view.title}>
                      <StatusPill tone={view.tone}>{view.label}</StatusPill>
                      {item.agentReview ? (
                        <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                          {item.agentReview.controlId} · {new Date(item.agentReview.reviewedAt).toLocaleDateString()}
                        </span>
                      ) : null}
                    </span>
                  );
                },
              },
              {
                key: 'submitted',
                header: 'Submitted',
                width: '110px',
                mono: true,
                align: 'end',
                render: (item) => new Date(item.createdAt).toLocaleDateString(),
              },
            ]}
            actions={(item) => (
              <>
                {item.artifact?.fileName ? (
                  <IconButton
                    aria-label={`Download evidence ${item.title}`}
                    onClick={() => {
                      void downloadComplianceEvidenceFile(item.id, item.artifact.fileName!);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </IconButton>
                ) : null}
                <IconButton
                  aria-label={`Edit evidence ${item.title}`}
                  onClick={() => {
                    setEditingItem(item);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  aria-label={`Delete evidence ${item.title}`}
                  onClick={() => {
                    setDeleteTarget(item);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </>
            )}
          />
        )}
      </div>

      {editingItem ? (
        <EvidenceEditModal
          item={editingItem}
          controls={availableControls}
          fallbackFrameworkKey={frameworkKey}
          isPending={updateEvidence.isPending}
          onClose={() => setEditingItem(null)}
          onSave={(payload) => {
            updateEvidence.mutate(
              { evidenceItemId: editingItem.id, ...payload },
              {
                onSuccess: () => {
                  // TODO(compliance-toasts): tune evidence copy once the unified toast taxonomy is finalized.
                  toastService.success('Evidence updated and queued for agent review.');
                  setEditingItem(null);
                },
                onError: (error) => {
                  toastService.error(error instanceof Error ? error.message : 'Failed to update evidence.');
                },
              },
            );
          }}
        />
      ) : null}

      {/* A destructive confirm is red, never signal — so this dialog has no yellow at all. */}
      <Modal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remove evidence"
        size="sm"
      >
        <ModalContent>
          <p className="text-sm leading-6 text-muted-foreground">
            This removes <span className="font-medium text-foreground">{deleteTarget?.title}</span> from the compliance
            library and unmaps it from controls. The next readiness view will no longer count it.
          </p>
        </ModalContent>
        <ModalFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirmDelete} loading={deleteEvidence.isPending}>
            Remove
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}

interface EvidenceEditModalProps {
  item: ComplianceEvidenceItem;
  controls: EvidenceControlOption[];
  fallbackFrameworkKey: ComplianceFrameworkKey | null;
  isPending: boolean;
  onClose: () => void;
  onSave: (payload: {
    title: string;
    description: string | null;
    evidenceType: ComplianceEvidenceType;
    owner: string | null;
    observationStartedAt: string | null;
    observationEndedAt: string | null;
    validUntil: string | null;
    mappings: Array<{
      frameworkKey: ComplianceFrameworkKey;
      controlId: string;
      mappingSource: ComplianceEvidenceMapping['mappingSource'];
      confidence: 'medium';
      rationale: string | null;
    }>;
  }) => void;
}

function EvidenceEditModal({
  item,
  controls,
  fallbackFrameworkKey,
  isPending,
  onClose,
  onSave,
}: EvidenceEditModalProps) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [evidenceType, setEvidenceType] = useState<ComplianceEvidenceType>(item.evidenceType);
  const [owner, setOwner] = useState(item.owner ?? '');
  const [validUntil, setValidUntil] = useState(toDateInput(item.validUntil));
  const [controlSearch, setControlSearch] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>(
    item.mappings.map((mapping) => `${mapping.frameworkKey}:${mapping.controlId}`),
  );

  const controlOptions = useMemo(() => {
    const byKey = new Map<string, EvidenceControlOption>();
    controls.forEach((control) => {
      byKey.set(`${control.frameworkKey}:${control.id}`, control);
    });
    item.mappings.forEach((mapping) => {
      const key = `${mapping.frameworkKey}:${mapping.controlId}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: mapping.controlId,
          title: mapping.rationale ?? 'Mapped control',
          frameworkKey: mapping.frameworkKey,
        });
      }
    });
    return Array.from(byKey.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [controls, item.mappings]);

  const filteredControls = useMemo(() => {
    const q = controlSearch.trim().toLowerCase();
    if (!q) return controlOptions;
    return controlOptions.filter((control) =>
      `${control.frameworkKey} ${control.id} ${control.title}`.toLowerCase().includes(q),
    );
  }, [controlOptions, controlSearch]);

  const toggleControl = (control: EvidenceControlOption) => {
    const key = `${control.frameworkKey}:${control.id}`;
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((value) => value !== key) : [...prev, key]));
  };

  const submit = () => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 3) {
      toastService.error('Evidence title must be at least 3 characters.');
      return;
    }
    const mappings = selectedKeys.map((key) => {
      const [framework, controlId] = key.split(':');
      const option = controlOptions.find((control) => `${control.frameworkKey}:${control.id}` === key);
      const existingMapping = item.mappings.find((mapping) => `${mapping.frameworkKey}:${mapping.controlId}` === key);
      return {
        frameworkKey: (framework as ComplianceFrameworkKey) ?? fallbackFrameworkKey ?? 'soc2',
        controlId,
        mappingSource: existingMapping?.mappingSource ?? 'user_declared' as const,
        confidence: 'medium' as const,
        rationale: description.trim() || option?.title || null,
      };
    });

    onSave({
      title: trimmedTitle,
      description: description.trim() || null,
      evidenceType,
      owner: owner.trim() || null,
      observationStartedAt: null,
      observationEndedAt: null,
      validUntil: dateInputToIso(validUntil),
      mappings,
    });
  };

  return (
    <Modal isOpen onClose={onClose} title="Edit evidence" size="lg">
      <ModalContent>
        <p className="-mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Changes reset review status
        </p>

        <div className="grid gap-4 md:grid-cols-[1fr_220px]">
          <div className="space-y-2">
            <Label htmlFor="evidence-title">Title</Label>
            <Input id="evidence-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evidence-type">Type</Label>
            <NativeSelect
              id="evidence-type"
              value={evidenceType}
              onChange={(event) => setEvidenceType(event.target.value as ComplianceEvidenceType)}
            >
              {evidenceTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </NativeSelect>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="evidence-owner">Owner</Label>
            <Input
              id="evidence-owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="Optional owner"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="evidence-valid-until">Valid until</Label>
            <Input
              id="evidence-valid-until"
              type="date"
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="evidence-description">Description</Label>
          <Textarea
            id="evidence-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="What this evidence proves, for the agent reviewer."
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label>
              Mapped controls
              {selectedKeys.length > 0 ? ` — ${selectedKeys.length} selected` : ''}
            </Label>
            <Input
              className="w-56"
              value={controlSearch}
              onChange={(event) => setControlSearch(event.target.value)}
              placeholder="Search controls"
            />
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto border border-border p-2">
            {filteredControls.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">No controls available to map.</p>
            ) : (
              filteredControls.map((control) => {
                const key = `${control.frameworkKey}:${control.id}`;
                const checked = selectedKeys.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleControl(control)}
                    className={`flex w-full items-center gap-2.5 px-2 py-1.5 text-left text-sm transition-colors ${
                      checked ? 'bg-elevated text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                    }`}
                  >
                    {/* Square mark, filled when selected — the system has no round controls. */}
                    <span
                      aria-hidden
                      className={`flex h-3.5 w-3.5 shrink-0 border ${
                        checked ? 'border-foreground bg-foreground' : 'border-border'
                      }`}
                    />
                    <span className="font-mono text-[11px] font-bold">{control.id}</span>
                    <span className="truncate text-xs">{control.title}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </ModalContent>

      <ModalFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={isPending}>
          Save changes
        </Button>
      </ModalFooter>
    </Modal>
  );
}
