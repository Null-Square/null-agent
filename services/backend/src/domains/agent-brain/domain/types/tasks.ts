import type { PlanItem, SessionTaskMeta, ToolAccessPolicy } from './session';

export interface TaskPreparation {
  /**
   * Plan blueprint translated into concrete steps for the session.
   */
  plan: PlanItem[];
  /**
   * Tool policy (allow/deny lists, network allowlists) that should
   * govern tool execution for the session.
   */
  toolPolicy?: ToolAccessPolicy;
  /**
   * Optional soft context blocks (e.g., task instructions) to attach to
   * the prompt.
   */
  softContextBlocks?: string[];
  /**
   * Starter prompt that the brain should enqueue as the first assistant/user
   * message.
   */
  starterPrompt?: string;
  /**
   * Metadata describing the task selection to persist on the session.
   */
  sessionTask?: SessionTaskMeta;
  /**
   * Redacted representation of task inputs safe for audit logs.
   */
  redactedVars?: Record<string, unknown>;
  /**
   * Optional sandbox profile identifier the brain should honor when
   * provisioning execution environments.
   */
  sandboxProfile?: string;
  /**
   * Optional sandbox image tag to use when provisioning the container.
   */
  sandboxImage?: string;
}
