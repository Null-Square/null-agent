/**
 * Notification Repository
 * 
 * Database access layer for notifications.
 */

import { getPool } from '@/db/client';
import type {
  Notification,
  CreateNotificationInput,
  NotificationListOptions,
  NotificationListResult,
} from './types';
import { randomUUID } from 'crypto';

const TABLE = 'notifications';

/**
 * Whether the user already has a notification recorded under this dedupe key.
 */
export async function existsWithDedupeKey(userId: string, dedupeKey: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT 1 FROM ${TABLE} WHERE user_id = $1 AND data->>'dedupeKey' = $2 LIMIT 1`,
    [userId, dedupeKey],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Create a new notification
 */
export async function create(input: CreateNotificationInput): Promise<Notification> {
  const pool = getPool();
  const id = randomUUID();
  const now = new Date();

  await pool.query(
    `INSERT INTO ${TABLE} (id, user_id, type, title, message, link, data, read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.userId,
      input.type,
      input.title,
      input.message,
      input.link ?? null,
      input.data ? JSON.stringify(input.data) : null,
      false,
      now,
    ]
  );

  return {
    id,
    userId: input.userId,
    type: input.type,
    title: input.title,
    message: input.message,
    link: input.link ?? null,
    data: input.data,
    read: false,
    createdAt: now,
  };
}

/**
 * List notifications for a user with default unread filter
 */
export async function listByUser(
  userId: string,
  options: NotificationListOptions = {}
): Promise<NotificationListResult> {
  const pool = getPool();
  const { unreadOnly = false, limit = 20, offset = 0 } = options;

  // Build query with optional unread filter
  const whereClause = unreadOnly
    ? 'WHERE user_id = $1 AND read = false AND deleted_at IS NULL'
    : 'WHERE user_id = $1 AND deleted_at IS NULL';

  // Get notifications
  const result = await pool.query(
    `SELECT id, user_id, type, title, message, link, data, read, created_at
     FROM ${TABLE}
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) as count FROM ${TABLE} ${whereClause}`,
    [userId]
  );

  // Get unread count
  const unreadResult = await pool.query(
    `SELECT COUNT(*) as count FROM ${TABLE}
     WHERE user_id = $1 AND read = false AND deleted_at IS NULL`,
    [userId]
  );

  return {
    notifications: result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      userId: row.user_id as string,
      type: row.type as Notification['type'],
      title: row.title as string,
      message: row.message as string,
      link: row.link as string | null,
      data: row.data as Record<string, unknown> | undefined,
      read: row.read as boolean,
      createdAt: row.created_at as Date,
    })),
    total: parseInt(countResult.rows[0]?.count ?? '0', 10),
    unreadCount: parseInt(unreadResult.rows[0]?.count ?? '0', 10),
  };
}

/**
 * Get unread count for badge
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM ${TABLE}
     WHERE user_id = $1 AND read = false AND deleted_at IS NULL`,
    [userId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Mark a single notification as read
 */
export async function markRead(id: string, userId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE ${TABLE} SET read = true WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllRead(userId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE ${TABLE} SET read = true WHERE user_id = $1 AND read = false`,
    [userId]
  );
  return result.rowCount ?? 0;
}

/**
 * Soft delete a notification
 */
export async function deleteNotification(id: string, userId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE ${TABLE} SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get a single notification by ID
 */
export async function getById(id: string, userId: string): Promise<Notification | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, user_id, type, title, message, link, data, read, created_at
     FROM ${TABLE}
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    type: row.type as Notification['type'],
    title: row.title as string,
    message: row.message as string,
    link: row.link as string | null,
    data: row.data as Record<string, unknown> | undefined,
    read: row.read as boolean,
    createdAt: row.created_at as Date,
  };
}
