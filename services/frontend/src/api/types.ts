/**
 * Re-exported types from OpenAPI generated schema
 * 
 * Use these types instead of defining local interfaces.
 * Types are automatically updated when running `npm run generate:api`
 */

import type { paths } from './schema';

// ============================================================================
// Session Types
// ============================================================================

/** Session summary from list */
export type SessionSummary = paths['/api/ai-agent/sessions']['get']['responses']['200']['content']['application/json']['sessions'][number];

/** Full session details */
export type SessionDetails = paths['/api/ai-agent/sessions/{sessionId}']['get']['responses']['200']['content']['application/json']['session'];

/** Session message */
export type SessionMessage = SessionDetails['messages'][number];

/** Plan item */
export type PlanItem = SessionDetails['plan'][number];

// ============================================================================
// API Response Helpers
// ============================================================================

/** Extract response type from a path */
export type ResponseOf<
    P extends keyof paths,
    M extends keyof paths[P] = 'get'
> = paths[P][M] extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
