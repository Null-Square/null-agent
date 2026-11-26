export class HttpError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly detail?: unknown;
  public readonly details?: unknown;
  public readonly extras?: Record<string, unknown>;

  constructor({
    code,
    message,
    status,
    detail,
    details,
    extras,
  }: {
    code: string;
    message: string;
    status: number;
    detail?: unknown;
    details?: unknown;
    extras?: Record<string, unknown>;
  }) {
    super(message);
    this.code = code;
    this.status = status;
    if (detail !== undefined) {
      this.detail = detail;
    }
    if (details !== undefined) {
      this.details = details;
    }
    if (extras && Object.keys(extras).length > 0) {
      this.extras = extras;
    }
  }
}

