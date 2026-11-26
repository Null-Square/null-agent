import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

/**
 * Threat Watch operational settings.
 *
 * These live in the database rather than the environment because they are
 * operational decisions, not deployment facts: whether the watcher runs, how
 * often it polls, and whether customers are told. An operator should be able to
 * pause a noisy feed or stop notifications without a redeploy, and the change
 * should be audited like any other configuration change.
 *
 * The NVD API key deliberately stays in the environment. It is a secret, and
 * secrets do not belong in a table an admin UI reads back.
 */
export interface ThreatWatchSettings {
  /** Master switch for the sync + match tick. */
  syncEnabled?: boolean;
  /**
   * Poll interval. Floored at 120 minutes because NVD asks automated consumers
   * not to poll more often, and the delta window makes a faster cadence no
   * fresher anyway.
   */
  syncIntervalMinutes?: number;
  /** Pages of advisories fetched per tick. */
  maxPagesPerRun?: number;
  /**
   * Whether customers are notified at all.
   *
   * Separate from `syncEnabled` on purpose: shadow mode — matching without
   * telling anyone — is how precision gets measured before the trust budget is
   * spent. Collapsing these into one flag would remove the only safe way to
   * evaluate the feature against real data.
   */
  notificationsEnabled?: boolean;
  /**
   * UTC instant from which newly-created matches may notify. Null keeps the
   * notifier fail-closed even when the notification switch is enabled.
   */
  notificationActivationAt?: string | null;
  /** Maximum age of the inventory evidence used for an interrupt. */
  notificationEvidenceMaxAgeDays?: number;
  /**
   * Minimum priority score for an immediate notification.
   *
   * Everything below this accumulates into the digest instead. The default is
   * high on purpose: an interrupt has to be rare to stay meaningful.
   */
  immediateNotifyMinPriority?: number;
  /** Send an immediate notification for anything CISA lists as exploited. */
  immediateNotifyOnKev?: boolean;
  /** Cap on immediate notifications per organization per day. */
  maxImmediateNotificationsPerDay?: number;
}

const threatWatchRowSchema = z
  .object({
    syncEnabled: z.unknown().optional(),
    syncIntervalMinutes: z.unknown().optional(),
    maxPagesPerRun: z.unknown().optional(),
    notificationsEnabled: z.unknown().optional(),
    notificationActivationAt: z.unknown().optional(),
    notificationEvidenceMaxAgeDays: z.unknown().optional(),
    immediateNotifyMinPriority: z.unknown().optional(),
    immediateNotifyOnKev: z.unknown().optional(),
    maxImmediateNotificationsPerDay: z.unknown().optional(),
  })
  .passthrough();

const numberSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) ? asNumber : value;
  }
  return value;
}, z.number());

const booleanSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  return value;
}, z.boolean());

const nullableDateTimeSchema = z.preprocess((value) => {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}, z.string().datetime({ offset: true }).nullable());

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[ThreatWatchSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveThreatWatchSettings = (value: unknown): ThreatWatchSettings => {
  const parsed = threatWatchRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[ThreatWatchSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    syncEnabled: requireParsed(booleanSchema.safeParse(data.syncEnabled), 'syncEnabled'),
    syncIntervalMinutes: requireParsed(
      numberSchema.safeParse(data.syncIntervalMinutes),
      'syncIntervalMinutes',
    ),
    maxPagesPerRun: requireParsed(numberSchema.safeParse(data.maxPagesPerRun), 'maxPagesPerRun'),
    notificationsEnabled: requireParsed(
      booleanSchema.safeParse(data.notificationsEnabled),
      'notificationsEnabled',
    ),
    notificationActivationAt: requireParsed(
      nullableDateTimeSchema.safeParse(data.notificationActivationAt),
      'notificationActivationAt',
    ),
    notificationEvidenceMaxAgeDays: requireParsed(
      numberSchema
        .pipe(z.number().int().min(1).max(90))
        .safeParse(data.notificationEvidenceMaxAgeDays),
      'notificationEvidenceMaxAgeDays',
    ),
    immediateNotifyMinPriority: requireParsed(
      numberSchema.safeParse(data.immediateNotifyMinPriority),
      'immediateNotifyMinPriority',
    ),
    immediateNotifyOnKev: requireParsed(
      booleanSchema.safeParse(data.immediateNotifyOnKev),
      'immediateNotifyOnKev',
    ),
    maxImmediateNotificationsPerDay: requireParsed(
      numberSchema.safeParse(data.maxImmediateNotificationsPerDay),
      'maxImmediateNotificationsPerDay',
    ),
  };
};

const threatWatchAccessors = createSettingsAccessors<ThreatWatchSettings>({
  key: 'threat_watch',
  scope: 'ThreatWatchSettings',
  // This row carries live incident controls. A write through one backend
  // replica must be visible to the cycle owner on another replica without a
  // restart or process-local cache invalidation.
  freshReads: true,
  resolve: resolveThreatWatchSettings,
  missingMessage:
    '[ThreatWatchSettings] Missing threat watch settings. Seed settings in database.',
  serialize: (value) => ({
    syncEnabled: value.syncEnabled,
    syncIntervalMinutes: value.syncIntervalMinutes,
    maxPagesPerRun: value.maxPagesPerRun,
    notificationsEnabled: value.notificationsEnabled,
    notificationActivationAt: value.notificationActivationAt,
    notificationEvidenceMaxAgeDays: value.notificationEvidenceMaxAgeDays,
    immediateNotifyMinPriority: value.immediateNotifyMinPriority,
    immediateNotifyOnKev: value.immediateNotifyOnKev,
    maxImmediateNotificationsPerDay: value.maxImmediateNotificationsPerDay,
  }),
});

export const getThreatWatchSettings = threatWatchAccessors.getSettings;
export const setThreatWatchSettings = threatWatchAccessors.setSettings;

export const clearThreatWatchSettingsCache = (): void => {
  threatWatchAccessors.clearSettings();
};
