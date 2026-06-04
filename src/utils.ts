/**
 * Small logging + helper utilities shared across the plugin. Kept dependency-free
 * so it can be imported from both the main process and the fallback child.
 */

/** Log severity levels in ascending order of importance. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Minimal prefixed console logger. Honours the `EUFY_LOG_LEVEL` env var
 * (default `info`) so debug output can be enabled without code changes.
 */
export class Logger {
  private readonly threshold: number;

  constructor(private readonly prefix: string) {
    const envLevel = (process.env.EUFY_LOG_LEVEL as LogLevel) ?? "info";
    this.threshold = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;
  }

  /** Create a child logger with an extended prefix. */
  child(suffix: string): Logger {
    return new Logger(`${this.prefix}:${suffix}`);
  }

  debug(...args: unknown[]): void {
    this.write("debug", args);
  }

  info(...args: unknown[]): void {
    this.write("info", args);
  }

  warn(...args: unknown[]): void {
    this.write("warn", args);
  }

  error(...args: unknown[]): void {
    this.write("error", args);
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < this.threshold) {
      return;
    }
    const line = `[${this.prefix}]`;
    if (level === "error") {
      console.error(line, ...args);
    } else if (level === "warn") {
      console.warn(line, ...args);
    } else {
      console.log(line, ...args);
    }
  }
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout. Rejects with `onTimeout()` (or a generic
 * error) if `promise` does not settle within `ms` milliseconds.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Compute an exponential backoff delay, capped at `max` ms.
 * attempt 0 → base, attempt 1 → base*2, … bounded by `max`.
 */
export function backoffDelay(attempt: number, base = 2000, max = 60000): number {
  return Math.min(base * 2 ** attempt, max);
}

/** Generate a short unique id for correlating IPC requests. */
export function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Type guard: error with a string `code` field (Node system errors). */
export function hasErrorCode(err: unknown): err is { code: string; message?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

/**
 * Heuristic: does this error indicate the runtime rejected the legacy
 * `RSA_PKCS1_PADDING` crypto required by Eufy's P2P protocol?
 */
export function isCryptoPaddingError(err: unknown): boolean {
  const code = hasErrorCode(err) ? err.code : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "ERR_OSSL_EVP_UNSUPPORTED" ||
    code === "ERR_OSSL_RSA_PADDING_CHECK_FAILED" ||
    /pkcs1|padding|legacy|unsupported|decoding error/i.test(message)
  );
}
