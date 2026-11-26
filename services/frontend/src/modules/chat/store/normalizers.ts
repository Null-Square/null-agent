import type {
  PlanItem,
  PlanItemStatus,
  ToolStreamState,
  TaskSummary,
  SandboxPolicy,
} from '@/types/chat';

export const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

export const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    return normalized.length ? Array.from(new Set(normalized)) : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  return undefined;
};

export const normalizePlanStatus = (value: unknown): PlanItemStatus => {
  if (typeof value !== 'string') {
    return 'pending';
  }
  const cleaned = value.toLowerCase();
  switch (cleaned) {
    case 'running':
    case 'in_progress':
    case 'in-progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
};

export const normalizeToolStreamStatus = (
  value: unknown
): ToolStreamState['status'] => {
  if (typeof value !== 'string') {
    return 'idle';
  }
  switch (value.toLowerCase()) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
};

export const normalizePlanItem = (
  raw: Record<string, unknown>,
  index: number
): PlanItem | null => {
  const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = rawId || `${index}-${rawTitle.slice(0, 12) || 'plan'}`;
  if (!id) {
    return null;
  }
  const title = rawTitle || id;

  const item: PlanItem = {
    id,
    title,
    status: normalizePlanStatus(raw.status),
  };

  const notes = typeof raw.notes === 'string' ? raw.notes.trim() : undefined;
  if (notes) {
    item.notes = notes;
  }

  const blockedReason =
    typeof raw.blockedReason === 'string' ? raw.blockedReason.trim() : undefined;
  if (blockedReason) {
    item.blockedReason = blockedReason;
  }

  const startedAt = toNumber(raw.startedAt);
  if (startedAt !== undefined) {
    item.startedAt = startedAt;
  }
  const completedAt = toNumber(raw.completedAt);
  if (completedAt !== undefined) {
    item.completedAt = completedAt;
  }

  const lastTool = typeof raw.lastTool === 'string' ? raw.lastTool.trim() : undefined;
  if (lastTool) {
    item.lastTool = lastTool;
  }

  const snippet =
    typeof raw.outputSnippet === 'string' ? raw.outputSnippet.trim() : undefined;
  if (snippet) {
    item.outputSnippet = snippet;
  }

  const artifactLinks = normalizeStringArray(raw.artifactLinks);
  if (artifactLinks) {
    item.artifactLinks = artifactLinks;
  }

  const checkpointId =
    typeof raw.checkpointId === 'string' ? raw.checkpointId.trim() : undefined;
  if (checkpointId) {
    item.checkpointId = checkpointId;
  }

  return item;
};

export const normalizePlanItems = (input: unknown): PlanItem[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      return normalizePlanItem(item as Record<string, unknown>, index);
    })
    .filter((value): value is PlanItem => value !== null);
};

export const normalizePlanStepUpdatePayload = (
  payload: unknown
): ({ id: string } & Partial<PlanItem>) | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const raw = payload as Record<string, unknown>;
  const id =
    (typeof raw.stepId === 'string' && raw.stepId.trim()) ||
    (typeof raw.id === 'string' && raw.id.trim()) ||
    '';

  if (!id) {
    return null;
  }

  const update: Partial<PlanItem> = {};

  if (raw.status !== undefined) {
    update.status = normalizePlanStatus(raw.status);
  }

  if (typeof raw.notes === 'string') {
    const notes = raw.notes.trim();
    update.notes = notes || undefined;
  }

  if (typeof raw.blockedReason === 'string') {
    const reason = raw.blockedReason.trim();
    update.blockedReason = reason || undefined;
  }

  const startedAt = toNumber(raw.startedAt);
  if (startedAt !== undefined) {
    update.startedAt = startedAt;
  }

  const completedAt = toNumber(raw.completedAt);
  if (completedAt !== undefined) {
    update.completedAt = completedAt;
  }

  if (typeof raw.lastTool === 'string') {
    const tool = raw.lastTool.trim();
    update.lastTool = tool || undefined;
  }

  if (typeof raw.outputSnippet === 'string') {
    const snippet = raw.outputSnippet.trim();
    update.outputSnippet = snippet || undefined;
  }

  const artifactLinks = normalizeStringArray(raw.artifactLinks);
  if (artifactLinks) {
    update.artifactLinks = artifactLinks;
  }

  if (typeof raw.checkpointId === 'string') {
    const checkpointId = raw.checkpointId.trim();
    update.checkpointId = checkpointId || undefined;
  }

  return { id, ...update };
};

export const normalizeTaskSummary = (
  raw: Record<string, unknown> | undefined
): TaskSummary | undefined => {
  if (!raw) {
    return undefined;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!id || !title) {
    return undefined;
  }

  const task: TaskSummary = {
    id,
    title,
  };

  if (typeof raw.category === 'string') {
    const category = raw.category.trim();
    if (category) {
      task.category = category;
    }
  }

  if (typeof raw.summary === 'string') {
    const summary = raw.summary.trim();
    if (summary) {
      task.summary = summary;
    }
  }

  if (typeof raw.versionHash === 'string') {
    const version = raw.versionHash.trim();
    if (version) {
      task.versionHash = version;
    }
  }

  if (typeof raw.creditsEstimate === 'number' && Number.isFinite(raw.creditsEstimate)) {
    task.creditsEstimate = raw.creditsEstimate;
  }

  return task;
};

export const normalizeToolStreams = (
  value: unknown
): Record<string, ToolStreamState> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return entries.reduce<Record<string, ToolStreamState>>((acc, [toolName, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return acc;
    }

    const record = raw as Record<string, unknown>;
    const chunks = Array.isArray(record.chunks)
      ? record.chunks.filter((chunk): chunk is string => typeof chunk === 'string')
      : [];
    const command = typeof record.command === 'string' ? record.command : undefined;
    const lastUpdated = toNumber(record.lastUpdated) ?? Date.now();

    acc[toolName] = {
      name: typeof record.name === 'string' ? record.name : toolName,
      chunks,
      status: normalizeToolStreamStatus(record.status),
      command,
      result: typeof record.result === 'undefined' ? undefined : (record.result as ToolStreamState['result']),
      lastUpdated,
    };
    return acc;
  }, {});
};

const normalizeSandboxNetwork = (value: unknown): SandboxPolicy['network'] => {
  if (typeof value !== 'string') {
    return 'bridge';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'bridge';
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === 'none' || lowered === 'bridge' || lowered === 'host') {
    return lowered as SandboxPolicy['network'];
  }
  if (lowered.startsWith('container:')) {
    const suffix = trimmed.slice('container:'.length);
    if (suffix) {
      return `container:${suffix}`;
    }
  }
  return 'bridge';
};

export const normalizeSandboxPolicy = (
  raw: Record<string, unknown> | undefined
): SandboxPolicy | undefined => {
  if (!raw) {
    return undefined;
  }
  const profile = typeof raw.profile === 'string' ? raw.profile.trim() : '';
  if (!profile) {
    return undefined;
  }

  const capDrop = normalizeStringArray(raw.capDrop);
  const capAdd = normalizeStringArray(raw.capAdd);

  const seccomp =
    typeof raw.seccomp === 'string'
      ? raw.seccomp.trim() || null
      : raw.seccomp === null
      ? null
      : undefined;

  return {
    profile,
    privileged: Boolean(raw.privileged),
    capDrop: capDrop ?? [],
    capAdd: capAdd ?? [],
    readonlyRootfs: Boolean(raw.readonlyRootfs),
    network: normalizeSandboxNetwork(raw.network),
    seccomp: seccomp ?? null,
  };
};
