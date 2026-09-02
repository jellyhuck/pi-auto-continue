/**
 * Configuration and state type definitions for pi-auto-continue extension.
 */

export interface RateLimitConfig {
  /** Whether to automatically retry on rate/quota limit errors (default: true) */
  enabled: boolean;
  /**
   * Maximum total duration in milliseconds to keep retrying after the first rate limit failure.
   * Retries stop once this duration has elapsed (default: 18,000,000 ms = 5 hours).
   */
  maxRetryDurationMs: number;
  /** Base delay in ms for exponential backoff (default: 5,000 ms = 5 seconds) */
  baseDelayMs: number;
  /** Maximum single delay in ms (default: 60,000 ms = 1 minute) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number;
  /** Whether to add random jitter to retry delays to avoid thundering herd (default: true) */
  jitter: boolean;
}

export interface TokenLimitConfig {
  /** Whether to automatically continue truncated responses (default: true) */
  enabled: boolean;
  /**
   * Maximum total duration in milliseconds to keep continuing after the first token limit truncation.
   * Continuations stop once this duration has elapsed (default: 18,000,000 ms = 5 hours).
   */
  maxRetryDurationMs: number;
  /** Base delay in ms for exponential backoff on continuation (default: 5,000 ms = 5 seconds) */
  baseDelayMs: number;
  /** Maximum single delay in ms (default: 60,000 ms = 1 minute) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier: number;
  /** Prompt sent when response is truncated due to max output tokens */
  continuePrompt: string;
}

export interface IncompleteToolCallConfig {
  /** Whether to auto-continue when an output cuts off mid-tool-call (default: true) */
  enabled: boolean;
  /** Prompt sent when response is cut off mid tool call */
  continuePrompt: string;
}

export interface AutoContinueConfig {
  /** Master switch to enable/disable auto-continue (default: true) */
  enabled: boolean;
  /** Rate limit and quota exhaustion retry settings */
  rateLimit: RateLimitConfig;
  /** Token limit truncation handling settings */
  tokenLimit: TokenLimitConfig;
  /** Incomplete tool call handling settings */
  incompleteToolCall: IncompleteToolCallConfig;
}

/**
 * Categorization of an assistant message interruption or failure.
 */
export type InterruptionType =
  | "RATE_LIMIT" // 429, quota exhaustion, overloaded, rate limits (retryable)
  | "TOKEN_LIMIT" // stopReason === "length" (continuation prompt)
  | "INCOMPLETE_TOOL_CALL" // cut off mid-tool-call arguments (continuation prompt)
  | "CONTEXT_OVERFLOW" // context window full (defer to Pi auto-compaction)
  | "BILLING_HARD_LIMIT" // permanent payment required / account exhaustion
  | "NONE"; // normal completion or non-interrupted

export interface ClassificationResult {
  type: InterruptionType;
  reason: string;
  errorMessage?: string;
  /** Explicit delay in ms extracted from Retry-After headers or error text */
  retryAfterMs?: number;
  /** Whether an explicit HTTP retry-after / reset header was received */
  retryAfterHeaderReceived?: boolean;
  /** Expected epoch timestamp (ms) when quota or tokens reset */
  expectedResetTime?: number;
  rawStopReason?: string;
}

export interface RetryState {
  isRetrying: boolean;
  startTime: number | null;
  attempt: number;
  lastDelayMs: number;
  lastErrorMessage?: string;
  lastInterruptionType?: InterruptionType;
  nextRetryTime?: number;
  /** Whether the active or last retry was triggered by a Retry-After header */
  retryAfterHeaderReceived?: boolean;
  /** Expected epoch timestamp (ms) when tokens/quota reset from Retry-After header */
  expectedTokenResetTime?: number;
  /** Optional alias for attempt retained for backward compatibility */
  count?: number;
  /** Optional timestamp of last processed message */
  lastMessageTimestamp?: number;
}

/**
 * Consolidated into RetryState.
 * Retained as an alias for backward compatibility.
 */
export type ContinuationState = RetryState;
