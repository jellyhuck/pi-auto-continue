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
  /** Maximum consecutive continuations for token limit cutoffs in a single user turn (default: 5) */
  maxContinuations: number;
  /** Delay in ms before sending continuation prompt (default: 1,000 ms) */
  delayMs: number;
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
  rawStopReason?: string;
}

export interface RetryState {
  isRetrying: boolean;
  startTime: number | null;
  attempt: number;
  lastDelayMs: number;
  lastErrorMessage?: string;
  nextRetryTime?: number;
}

export interface ContinuationState {
  count: number;
  lastMessageTimestamp?: number;
}
