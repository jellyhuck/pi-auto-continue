import { parseMaxRetries } from "./config.ts";
import { formatDateTime, formatDelay, formatDuration } from "./formatter.ts";
import type { AutoContinueConfig, InterruptionType, RetryLimit, RetryState } from "./types.ts";

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
 * Manages retry state and deadlines across all errors using global parameters.
 */
export class RetryManager {
  private state: RetryState = {
    isRetrying: false,
    startTime: null,
    attempt: 0,
    rateLimitAttempts: 0,
    lastDelayMs: 0,
    lastErrorMessage: undefined,
    lastInterruptionType: undefined,
    retryAfterHeaderReceived: false,
    expectedTokenResetTime: undefined,
  };

  /**
   * Resolves the active retry limit for the given interruption type.
   * Rate limits use rateLimit.maxRetries if specified, otherwise global maxRetries.
   * All other types use global maxRetries.
   */
  public getActiveLimit(
    config: AutoContinueConfig,
    type: InterruptionType = "RATE_LIMIT"
  ): RetryLimit {
    if (type === "RATE_LIMIT" && config.rateLimit.maxRetries !== undefined) {
      return parseMaxRetries(config.rateLimit.maxRetries);
    }
    return parseMaxRetries(config.maxRetries);
  }

  /**
   * Evaluates whether a retry should be scheduled and calculates the next delay.
   *
   * @param config The active auto-continue configuration
   * @param errorMessage The observed error message
   * @param explicitDelayMs Optional explicit delay from Retry-After headers/hints
   * @param now Current timestamp in ms (defaults to Date.now())
   * @param expectedResetTime Optional timestamp (ms) when quota/tokens reset
   * @param retryAfterHeaderReceived Whether an explicit HTTP Retry-After header was received
   * @param capToMaxDelay Whether to cap the explicit delay to maxDelayMs (default: true)
   */
  public evaluateRetry(
    config: AutoContinueConfig,
    errorMessage: string,
    explicitDelayMs?: number | null,
    now = Date.now(),
    expectedResetTime?: number | null,
    retryAfterHeaderReceived?: boolean,
    capToMaxDelay = true
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

    const limit = this.getActiveLimit(config, "RATE_LIMIT");
    const elapsedMs = now - this.state.startTime;

    if (limit.type === "duration") {
      const remainingMs = Math.max(0, limit.durationMs - elapsedMs);
      if (elapsedMs >= limit.durationMs) {
        return {
          canRetry: false,
          attempt: this.state.attempt,
          delayMs: 0,
          elapsedMs,
          remainingMs: 0,
          deadlineExceeded: true,
          reason: `Maximum retry duration of ${formatDuration(limit.durationMs)} exceeded`,
        };
      }
    } else {
      if (this.state.attempt >= limit.count) {
        return {
          canRetry: false,
          attempt: this.state.attempt,
          delayMs: 0,
          elapsedMs,
          remainingMs: 0,
          deadlineExceeded: true,
          reason: `Maximum retries limit of ${limit.count} attempt(s) exceeded`,
        };
      }
    }

    const nextAttempt = this.state.attempt + 1;
    const rateLimitAttempt = (this.state.rateLimitAttempts ?? 0) + 1;
    let delayMs: number;

    const resetDelayMs =
      explicitDelayMs !== undefined && explicitDelayMs !== null && explicitDelayMs >= 0
        ? explicitDelayMs
        : expectedResetTime !== undefined && expectedResetTime !== null
        ? Math.max(0, expectedResetTime - now)
        : 0;

    if (!capToMaxDelay) {
      // Explicitly scheduled delay (e.g. /auto-continue at <time>): do not cap or modify
      delayMs = resetDelayMs;
    } else if (rateLimitAttempt === 1 && resetDelayMs > 0) {
      // First rate limit retry respects expected quota reset time: baseDelay + expected reset time
      delayMs = config.baseDelayMs + resetDelayMs;
    } else {
      // Exponential backoff: baseDelay * backoff^(rateLimitAttempt - 1)
      const power = Math.max(0, rateLimitAttempt - 1);
      const rawDelay =
        config.baseDelayMs * Math.pow(config.backoffMultiplier, power);

      let calculated = Math.min(rawDelay, config.maxDelayMs);

      // Apply random jitter (±15%) to avoid synchronized retry stampedes
      if (rateLimitConfig.jitter) {
        const jitterFactor = 0.85 + Math.random() * 0.3; // 0.85 to 1.15
        calculated = Math.round(calculated * jitterFactor);
      }

      delayMs = Math.max(config.baseDelayMs, calculated);
    }

    const remainingMs =
      limit.type === "duration" ? Math.max(0, limit.durationMs - elapsedMs) : 0;

    if (limit.type === "duration") {
      if (!capToMaxDelay && delayMs > remainingMs) {
        return {
          canRetry: false,
          attempt: this.state.attempt,
          delayMs,
          elapsedMs,
          remainingMs,
          deadlineExceeded: true,
          reason: `Scheduled retry time exceeds maximum retry duration of ${formatDuration(limit.durationMs)}`,
        };
      }

      // Ensure we don't sleep beyond the remaining retry duration for standard backoff
      if (delayMs > remainingMs) {
        delayMs = remainingMs;
      }
    }

    // Update state
    this.state.attempt = nextAttempt;
    this.state.rateLimitAttempts = rateLimitAttempt;
    this.state.lastDelayMs = delayMs;
    this.state.lastErrorMessage = errorMessage;
    this.state.lastInterruptionType = "RATE_LIMIT";
    this.state.nextRetryTime = now + delayMs;
    this.state.retryAfterHeaderReceived = Boolean(retryAfterHeaderReceived);
    this.state.expectedTokenResetTime =
      expectedResetTime ??
      (retryAfterHeaderReceived ? now + delayMs : undefined);

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
   * Schedules a retry at a specific target timestamp.
   *
   * @param config The active auto-continue configuration
   * @param targetTimeMs Epoch timestamp (ms) when retry should execute
   * @param now Current timestamp in ms (defaults to Date.now())
   */
  public scheduleRetry(
    config: AutoContinueConfig,
    targetTimeMs: number,
    now = Date.now()
  ): RetryCheckResult {
    const delayMs = Math.max(0, targetTimeMs - now);
    return this.evaluateRetry(
      config,
      `User scheduled retry at ${formatDateTime(targetTimeMs)}`,
      delayMs,
      now,
      targetTimeMs,
      true,
      false // do not cap to maxDelayMs
    );
  }

  /**
   * Evaluates whether an auto-continuation should be scheduled for token truncation or incomplete tool calls.
   * Advances the attempt counter on the single consolidated RetryState and enforces global retry limits.
   *
   * @param config The active auto-continue configuration
   * @param type Interruption type ("TOKEN_LIMIT" | "INCOMPLETE_TOOL_CALL")
   * @param reason Optional human-readable reason
   * @param now Current timestamp in ms (defaults to Date.now())
   */
  public evaluateContinuation(
    config: AutoContinueConfig,
    type: "TOKEN_LIMIT" | "INCOMPLETE_TOOL_CALL" = "TOKEN_LIMIT",
    reason?: string,
    now = Date.now()
  ): RetryCheckResult {
    const isTokenLimit = type === "TOKEN_LIMIT";
    const isEnabled = isTokenLimit
      ? config.tokenLimit.enabled
      : config.incompleteToolCall.enabled;

    if (!config.enabled || !isEnabled) {
      return {
        canRetry: false,
        attempt: this.state.attempt,
        delayMs: 0,
        elapsedMs: 0,
        remainingMs: 0,
        deadlineExceeded: false,
        reason: `${isTokenLimit ? "Token limit" : "Incomplete tool call"} continuations are disabled by configuration`,
      };
    }

    // Initialize start time if this is the start of a retry/continuation cycle
    if (!this.state.isRetrying || this.state.startTime === null) {
      this.state.isRetrying = true;
      this.state.startTime = now;
      this.state.attempt = 0;
    }

    const limit = this.getActiveLimit(config, type);
    const elapsedMs = now - this.state.startTime;

    if (limit.type === "duration") {
      const remainingMs = Math.max(0, limit.durationMs - elapsedMs);
      if (elapsedMs >= limit.durationMs) {
        return {
          canRetry: false,
          attempt: this.state.attempt,
          delayMs: 0,
          elapsedMs,
          remainingMs: 0,
          deadlineExceeded: true,
          reason: `Maximum retry duration of ${formatDuration(limit.durationMs)} exceeded`,
        };
      }
    } else {
      if (this.state.attempt >= limit.count) {
        return {
          canRetry: false,
          attempt: this.state.attempt,
          delayMs: 0,
          elapsedMs,
          remainingMs: 0,
          deadlineExceeded: true,
          reason: `Maximum retries limit of ${limit.count} attempt(s) exceeded`,
        };
      }
    }

    const nextAttempt = this.state.attempt + 1;
    const rawDelay =
      config.baseDelayMs *
      Math.pow(config.backoffMultiplier, Math.max(0, nextAttempt - 1));

    let delayMs = Math.min(rawDelay, config.maxDelayMs);

    const remainingMs =
      limit.type === "duration" ? Math.max(0, limit.durationMs - elapsedMs) : 0;

    // Ensure we don't sleep beyond the remaining retry duration
    if (limit.type === "duration" && delayMs > remainingMs) {
      delayMs = remainingMs;
    }

    const message =
      reason ||
      (isTokenLimit
        ? "Response truncated (max tokens reached)"
        : "Output cut off mid-tool-call");

    // Update consolidated state
    this.state.attempt = nextAttempt;
    this.state.lastDelayMs = delayMs;
    this.state.lastErrorMessage = message;
    this.state.lastInterruptionType = type;
    this.state.nextRetryTime = now + delayMs;
    this.state.retryAfterHeaderReceived = false;
    this.state.expectedTokenResetTime = undefined;

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
   * Decrements attempt count if a retry or continuation prompt failed to send.
   */
  public decrementAttempt(): void {
    if (this.state.attempt > 0) {
      this.state.attempt--;
    }
    if (this.state.rateLimitAttempts && this.state.rateLimitAttempts > 0) {
      this.state.rateLimitAttempts--;
    }
    if (this.state.attempt === 0) {
      this.state.isRetrying = false;
      this.state.startTime = null;
      this.state.rateLimitAttempts = 0;
    }
  }

  /**
   * Resets retry state on successful completion or new session.
   */
  public reset(): void {
    this.state = {
      isRetrying: false,
      startTime: null,
      attempt: 0,
      rateLimitAttempts: 0,
      lastDelayMs: 0,
      lastErrorMessage: undefined,
      lastInterruptionType: undefined,
      nextRetryTime: undefined,
      retryAfterHeaderReceived: false,
      expectedTokenResetTime: undefined,
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
    const limit = this.getActiveLimit(
      config,
      this.state.lastInterruptionType || "RATE_LIMIT"
    );

    let limitLines = "";
    if (limit.type === "duration") {
      const remaining = Math.max(0, limit.durationMs - elapsed);
      limitLines =
        `  Attempt: ${this.state.attempt}\n` +
        `  Elapsed: ${formatDuration(elapsed)} / Max: ${formatDuration(limit.durationMs)}\n` +
        `  Remaining: ${formatDuration(remaining)}`;
    } else {
      const remaining = Math.max(0, limit.count - this.state.attempt);
      limitLines =
        `  Attempt: ${this.state.attempt} / Max: ${limit.count}\n` +
        `  Elapsed: ${formatDuration(elapsed)}\n` +
        `  Remaining attempts: ${remaining}`;
    }

    let summary =
      `Active Retry Loop:\n` +
      limitLines + `\n` +
      `  Last delay: ${formatDelay(this.state.lastDelayMs)}\n` +
      `  Last error: ${this.state.lastErrorMessage || "None"}`;

    if (this.state.expectedTokenResetTime) {
      summary += `\n  Expected token reset time: ${formatDateTime(this.state.expectedTokenResetTime)}`;
    }

    return summary;
  }
}
