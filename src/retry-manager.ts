import { formatDelay, formatDuration } from "./formatter.ts";
import type { AutoContinueConfig, RetryState } from "./types.ts";

export interface RetryCheckResult {
  canRetry: boolean;
  attempt: number;
  delayMs: number;
  elapsedMs: number;
  remainingMs: number;
  deadlineExceeded: boolean;
  reason?: string;
}

/**
 * Manages retry state and deadlines for rate-limited sessions.
 */
export class RetryManager {
  private state: RetryState = {
    isRetrying: false,
    startTime: null,
    attempt: 0,
    lastDelayMs: 0,
    lastErrorMessage: undefined,
  };

  /**
   * Evaluates whether a retry should be scheduled and calculates the next delay.
   *
   * @param config The active auto-continue configuration
   * @param errorMessage The observed error message
   * @param explicitDelayMs Optional explicit delay from Retry-After headers/hints
   * @param now Current timestamp in ms (defaults to Date.now())
   */
  public evaluateRetry(
    config: AutoContinueConfig,
    errorMessage: string,
    explicitDelayMs?: number | null,
    now = Date.now()
  ): RetryCheckResult {
    const rateLimitConfig = config.rateLimit;

    if (!config.enabled || !rateLimitConfig.enabled) {
      return {
        canRetry: false,
        attempt: this.state.attempt,
        delayMs: 0,
        elapsedMs: 0,
        remainingMs: 0,
        deadlineExceeded: false,
        reason: "Rate limit retries are disabled by configuration",
      };
    }

    // Initialize start time if this is the start of a retry cycle
    if (!this.state.isRetrying || this.state.startTime === null) {
      this.state.isRetrying = true;
      this.state.startTime = now;
      this.state.attempt = 0;
    }

    const elapsedMs = now - this.state.startTime;
    const remainingMs = Math.max(0, rateLimitConfig.maxRetryDurationMs - elapsedMs);

    // Check if maxRetryDurationMs deadline has already passed
    if (elapsedMs >= rateLimitConfig.maxRetryDurationMs) {
      return {
        canRetry: false,
        attempt: this.state.attempt,
        delayMs: 0,
        elapsedMs,
        remainingMs: 0,
        deadlineExceeded: true,
        reason: `Maximum retry duration of ${formatDuration(rateLimitConfig.maxRetryDurationMs)} exceeded`,
      };
    }

    const nextAttempt = this.state.attempt + 1;
    let delayMs: number;

    if (explicitDelayMs !== undefined && explicitDelayMs !== null && explicitDelayMs > 0) {
      // Respect explicit provider Retry-After header/body hint, capped at maxDelayMs
      delayMs = Math.min(explicitDelayMs, rateLimitConfig.maxDelayMs);
    } else {
      // Exponential backoff
      const rawDelay =
        rateLimitConfig.baseDelayMs *
        Math.pow(rateLimitConfig.backoffMultiplier, Math.max(0, nextAttempt - 1));

      let calculated = Math.min(rawDelay, rateLimitConfig.maxDelayMs);

      // Apply random jitter (±15%) to avoid synchronized retry stampedes
      if (rateLimitConfig.jitter) {
        const jitterFactor = 0.85 + Math.random() * 0.3; // 0.85 to 1.15
        calculated = Math.round(calculated * jitterFactor);
      }

      delayMs = Math.max(rateLimitConfig.baseDelayMs, calculated);
    }

    // Ensure we don't sleep beyond the remaining retry duration
    if (delayMs > remainingMs) {
      delayMs = remainingMs;
    }

    // Update state
    this.state.attempt = nextAttempt;
    this.state.lastDelayMs = delayMs;
    this.state.lastErrorMessage = errorMessage;
    this.state.nextRetryTime = now + delayMs;

    return {
      canRetry: true,
      attempt: nextAttempt,
      delayMs,
      elapsedMs,
      remainingMs,
      deadlineExceeded: false,
    };
  }

  /**
   * Resets retry state on successful completion or new session.
   */
  public reset(): void {
    this.state = {
      isRetrying: false,
      startTime: null,
      attempt: 0,
      lastDelayMs: 0,
      lastErrorMessage: undefined,
      nextRetryTime: undefined,
    };
  }

  /**
   * Returns a snapshot of the current retry state.
   */
  public getState(): Readonly<RetryState> {
    return { ...this.state };
  }

  /**
   * Formats a human-readable status summary of current retry progress.
   */
  public getStatusSummary(config: AutoContinueConfig, now = Date.now()): string {
    if (!this.state.isRetrying || this.state.startTime === null) {
      return "Idle (no active retry loop)";
    }

    const elapsed = now - this.state.startTime;
    const remaining = Math.max(0, config.rateLimit.maxRetryDurationMs - elapsed);

    return (
      `Active Retry Loop:\n` +
      `  Attempt: ${this.state.attempt}\n` +
      `  Elapsed: ${formatDuration(elapsed)} / Max: ${formatDuration(config.rateLimit.maxRetryDurationMs)}\n` +
      `  Remaining: ${formatDuration(remaining)}\n` +
      `  Last delay: ${formatDelay(this.state.lastDelayMs)}\n` +
      `  Last error: ${this.state.lastErrorMessage || "None"}`
    );
  }
}
