/**
 * Thrown by a handler to ask Sabha to deliver the event again. Only events Sabha retries
 * honour it (message_updated, message_deleted, reaction_deleted, block_actions, user_*): there
 * the webhook answers 503. Sabha never retries message_created, reaction_created or command,
 * and the socket has no retry, so there it is logged and the event is answered 200.
 */
export class RetryLater extends Error {
  constructor(message = "handler asked for a retry") {
    super(message);
    this.name = "RetryLater";
  }
}

/** The app's settings are missing or wrong, such as an unset signing secret. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Sabha refused an API call. Carries the status and Sabha's error code, never the request's
 * headers or body, so it is safe to log.
 */
export class SabhaApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly needed: string | undefined;

  constructor(params: { status: number; code?: string; error?: string; needed?: string; method: string; path: string }) {
    const detail = [params.code, params.error].filter(Boolean).join(": ");
    super(`${params.method} ${params.path} answered ${params.status}${detail ? ` (${detail})` : ""}`);
    this.name = "SabhaApiError";
    this.status = params.status;
    this.code = params.code;
    this.needed = params.needed;
  }
}
