import type {
  AIChatMessage,
  ChatSessionSnapshot,
  PlanItem,
  TimelineEntry,
  ToolStreamState,
} from '@/types/chat';

const toMillis = (value: number | string | undefined): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
};

const countToolStreams = (streams?: Record<string, ToolStreamState>): number =>
  Object.keys(streams ?? {}).length;

const snapshotRichness = (snapshot: ChatSessionSnapshot) => [
  snapshot.messages?.length ?? 0,
  snapshot.plan?.length ?? 0,
  countToolStreams(snapshot.liveToolStreams),
  snapshot.artifacts?.length ?? 0,
  snapshot.timeline?.length ?? 0,
  snapshot.usageHistory?.length ?? 0,
  snapshot.task ? 1 : 0,
  snapshot.usage ? 1 : 0,
  snapshot.summary ? 1 : 0,
  snapshot.report ? 1 : 0,
  toMillis(snapshot.lastActive),
  toMillis(snapshot.updatedAt),
];

export const getSessionSnapshotVersion = (snapshot?: ChatSessionSnapshot | null): number =>
  typeof snapshot?.version === 'number' ? snapshot.version : 0;

export const shouldPreferSessionSnapshot = (
  current: ChatSessionSnapshot | undefined,
  next: ChatSessionSnapshot | undefined,
): boolean => {
  if (!next) {
    return false;
  }

  if (!current) {
    return true;
  }

  const currentVersion = getSessionSnapshotVersion(current);
  const nextVersion = getSessionSnapshotVersion(next);
  if (nextVersion !== currentVersion) {
    return nextVersion > currentVersion;
  }

  const currentRichness = snapshotRichness(current);
  const nextRichness = snapshotRichness(next);
  for (let i = 0; i < nextRichness.length; i += 1) {
    if (nextRichness[i] === currentRichness[i]) {
      continue;
    }
    return nextRichness[i] > currentRichness[i];
  }

  return false;
};

export const buildMessageFingerprint = (messages: AIChatMessage[]): string =>
  messages
    .map((message) => {
      const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : Number(message.timestamp ?? 0);
      return [
        message.id,
        message.role,
        message.status ?? 'sent',
        timestamp,
        message.content,
      ].join(':');
    })
    .join('\u0001');

export const buildPlanFingerprint = (plan: PlanItem[]): string =>
  plan
    .map((item) =>
      [
        item.id,
        item.title,
        item.status,
        item.notes ?? '',
        item.blockedReason ?? '',
        item.startedAt ?? '',
        item.completedAt ?? '',
        item.lastTool ?? '',
        item.outputSnippet ?? '',
        item.checkpointId ?? '',
      ].join(':'),
    )
    .join('\u0001');

export const buildToolStreamFingerprint = (streams: Record<string, ToolStreamState>): string =>
  Object.values(streams)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((stream) =>
      [
        stream.name,
        stream.status,
        stream.command ?? '',
        stream.lastUpdated,
        stream.chunks.length,
        stream.chunks[stream.chunks.length - 1] ?? '',
      ].join(':'),
    )
    .join('\u0001');

export const buildTimelineFingerprint = (entries: TimelineEntry[]): string =>
  entries
    .map((entry) =>
      [
        entry.id,
        entry.replaceKey ?? '',
        entry.kind,
        entry.status,
        entry.title,
        entry.detail ?? '',
        entry.ts,
      ].join(':'),
    )
    .join('\u0001');
