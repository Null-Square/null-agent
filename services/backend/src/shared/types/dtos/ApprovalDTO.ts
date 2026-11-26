export interface ApprovalPreviewDTO {
  cmd?: string;
  path?: string;
  diff?: string;
  risk?: string[];
}

export interface ApprovalRequestDTO {
  actionId: string;
  tool: string;
  toolCallId?: string;
  modelRequestId?: string;
  args?: Record<string, unknown>;
  preview?: ApprovalPreviewDTO;
  expiresAt?: string;
  requestedAt?: number;
  reason?: string;
}

export interface ApprovalDecisionDTO {
  actionId: string;
  reason?: string;
}
