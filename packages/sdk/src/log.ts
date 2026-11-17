/**
 * The SDK's logger. Fields are for ids, statuses and codes only: never a key, a secret, a
 * response_url or message text, because Workers logs are readable by everyone on the account.
 */
export type LogFields = Record<string, string | number | boolean | undefined | null>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(`[sabha] ${message}`, fields ?? ""),
  warn: (message, fields) => console.warn(`[sabha] ${message}`, fields ?? ""),
  error: (message, fields) => console.error(`[sabha] ${message}`, fields ?? ""),
};

/** An error's name and message, with any of the given secrets scrubbed out, for a log field. */
export function describeError(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  return text;
}
