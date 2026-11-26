export interface ContextBlocks {
  /**
   * Legacy hard context block; kept for interface compatibility and normally empty.
   */
  hard: string;
  /**
   * Optional soft context blocks (task instructions, operator notes, etc).
   */
  soft?: string;
}

export interface ContextRequest {
  /**
    * Session identifier so providers can fetch per-session state if needed.
    */
  sessionId: string;
  /**
   * Current turn number (1-based) when requesting context.
   */
  turn?: number;
  /**
    * Optional structured payload delivered by the app layer that the
    * brain should surface inside the prompt.
    */
  extraContext?: string;
  /**
   * Soft context blocks (task instructions, etc.) supplied by the app layer.
   */
  taskBlocks?: string[];
}
