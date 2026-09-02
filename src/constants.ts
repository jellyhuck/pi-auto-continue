import type { AutoContinueConfig } from "./types.ts";

/**
 * 5 hours in milliseconds.
 * Matches common AI provider quota refresh cycles (e.g. Claude Pro 5h reset windows).
 */
export const DEFAULT_MAX_RETRY_DURATION_MS = 5 * 60 * 60 * 1000; // 18,000,000 ms

export const DEFAULT_CONFIG: AutoContinueConfig = {
  enabled: true,
  rateLimit: {
    enabled: true,
    maxRetryDurationMs: DEFAULT_MAX_RETRY_DURATION_MS,
    baseDelayMs: 5000, // 5 seconds
    maxDelayMs: 300000, // 5 minutes
    backoffMultiplier: 2,
    jitter: true,
  },
  tokenLimit: {
    enabled: true,
    maxRetryDurationMs: DEFAULT_MAX_RETRY_DURATION_MS,
    baseDelayMs: 5000, // 5 seconds
    maxDelayMs: 600000, // 10 minutes
    backoffMultiplier: 6,
    continuePrompt:
      "Continue from where you left off. Do not repeat what you've already written. Pick up exactly where the previous response was cut off.",
  },
  incompleteToolCall: {
    enabled: true,
    continuePrompt:
      "Your previous response was cut off mid-tool-call. Please complete the tool call you were making, or if you were finished with tool calls, provide your final response.",
  },
};

/**
 * Patterns that indicate provider rate limits, quota limits, or server capacity issues.
 * These are transient errors that can be retried automatically until quota resets.
 */
export const RATE_LIMIT_PATTERNS: RegExp[] = [
  // Generic & HTTP 429
  /rate.?limit/i,
  /too.?many.?requests/i,
  /please.?slow.?down/i,
  /retry.?after/i,
  /throttl/i,
  /requests?.?per.?(?:minute|second|day|hour)/i,
  /tokens?.?per.?(?:minute|second|day|hour)/i,
  /\b(?:RPM|TPM|RPD|TPD)\b/i,

  // Server capacity & overload (503 / 529 / 500 transient)
  /overloaded/i,
  /capacity/i,
  /service.?unavailable.*load/i,
  /temporarily.?unavailable/i,
  /server.?busy/i,
  /peak.?capacity/i,
  /high.?traffic/i,

  // Google Gemini / Vertex
  /resource.?exhausted/i,
  /quota.?exceeded/i,
  /quota.?metric/i,
  /rate.?limit.?exceeded/i,

  // Anthropic
  /overloaded_error/i,
  /rate_limit_error/i,

  // OpenAI / OpenCode / Azure
  /(?:you.?)?(?:have.?)?exceeded.?(?:the.?)?rate/i,
  /(?:you.?)?(?:have.?)?exceeded.?(?:your.?)?(?:current.?)?quota/i,
  /insufficient.?quota/i,
  /quota.?(?:exceeded|reached|exhausted|limit)/i,
  /usage.?limit/i,
  /plan.?limit/i,
  /request.?limit/i,
  /api.?limit/i,

  // GitHub Copilot & other providers
  /copilot.?quota/i,
  /copilot.?limit/i,
];

/**
 * Patterns indicating non-retryable billing / account / auth errors.
 * Retrying these will not succeed without user manual action.
 */
export const BILLING_HARD_LIMIT_PATTERNS: RegExp[] = [
  /insufficient.?funds/i,
  /payment.?required/i,
  /account.?deactivated/i,
  /account.?suspended/i,
  /credit.?card/i,
  /upgrade.?plan/i,
  /upgrade.?your.?plan/i,
  /out.?of.?credits/i,
  /billing.?hard.?limit/i,
  /no.?remaining.?credits/i,
  /invalid.?api.?key/i,
  /authentication.?failed/i,
  /unauthorized/i,
  /forbidden.*billing/i,
];

/**
 * Patterns for context window overflow.
 * Pi has built-in auto-compaction for this, so we should not retry blindly.
 */
export const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context.?length/i,
  /context.?window/i,
  /maximum.?context/i,
  /prompt.?(?:is.?)?too.?long/i,
  /request.?too.?large/i,
  /input.?too.?long/i,
  /exceeds?.?(?:the.?)?max(?:imum)?.?(?:context|tokens?)/i,
  /model.?context.?size/i,
];
