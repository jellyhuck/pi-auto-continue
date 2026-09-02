import {
  BILLING_HARD_LIMIT_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  RATE_LIMIT_PATTERNS,
} from "./constants.ts";
import type { ClassificationResult } from "./types.ts";

export interface RetryAfterInfo {
  delayMs: number | null;
  expectedResetTime: number | null;
  hasHeader: boolean;
}

/**
 * Extracts retry delay and expected reset time from HTTP response headers or error message text.
 */
export function extractRetryAfterInfo(
  headers?: Record<string, string>,
  errorMessage?: string,
  now = Date.now()
): RetryAfterInfo {
  // 1. Check HTTP response headers
  if (headers) {
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    // Standard Retry-After header (seconds or HTTP date)
    const retryAfter = normalizedHeaders["retry-after"];
    if (retryAfter) {
      const parsedSeconds = parseFloat(retryAfter);
      if (!isNaN(parsedSeconds) && parsedSeconds >= 0) {
        const delayMs = Math.round(parsedSeconds * 1000);
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: true,
        };
      }
      const parsedDate = Date.parse(retryAfter);
      if (!isNaN(parsedDate)) {
        const diffMs = parsedDate - now;
        return {
          delayMs: diffMs > 0 ? diffMs : 0,
          expectedResetTime: parsedDate,
          hasHeader: true,
        };
      }
    }

    // Direct ms header used by some gateways
    const retryAfterMs = normalizedHeaders["retry-after-ms"];
    if (retryAfterMs) {
      const parsedMs = parseFloat(retryAfterMs);
      if (!isNaN(parsedMs) && parsedMs >= 0) {
        const delayMs = Math.round(parsedMs);
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: true,
        };
      }
    }

    // UNIX timestamp reset header (e.g. OpenAI / Cloudflare)
    const resetTime =
      normalizedHeaders["x-ratelimit-reset"] ||
      normalizedHeaders["x-ratelimit-reset-requests"] ||
      normalizedHeaders["x-ratelimit-reset-tokens"];
    if (resetTime) {
      const parsed = parseFloat(resetTime);
      if (!isNaN(parsed) && parsed > 0) {
        // Could be epoch seconds (> 1e9) or delta seconds
        if (parsed > 1e9) {
          const expectedResetTime = Math.round(parsed * 1000);
          const diffMs = expectedResetTime - now;
          return {
            delayMs: diffMs > 0 ? diffMs : 0,
            expectedResetTime,
            hasHeader: true,
          };
        } else {
          const delayMs = Math.round(parsed * 1000);
          return {
            delayMs,
            expectedResetTime: now + delayMs,
            hasHeader: true,
          };
        }
      }
    }
  }

  // 2. Check error message text for inline retry hints
  if (errorMessage) {
    // "retry after 30s", "try again in 12.5 seconds", "wait 45 seconds"
    const secMatch = errorMessage.match(
      /(?:retry.?after|try.?again.?in|wait|slow.?down.?for|resets?.?in)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds|m|min|minutes|h|hours|ms)?\b/i
    );
    if (secMatch && secMatch[1]) {
      const num = parseFloat(secMatch[1]);
      const unit = (secMatch[0].match(/(s|sec|seconds|m|min|minutes|h|hours|ms)$/i)?.[1] || "s").toLowerCase();
      if (!isNaN(num) && num > 0) {
        let delayMs: number;
        if (unit.startsWith("m") && !unit.startsWith("ms")) {
          delayMs = Math.round(num * 60 * 1000);
        } else if (unit.startsWith("h")) {
          delayMs = Math.round(num * 3600 * 1000);
        } else if (unit === "ms") {
          delayMs = Math.round(num);
        } else {
          delayMs = Math.round(num * 1000);
        }
        return {
          delayMs,
          expectedResetTime: now + delayMs,
          hasHeader: false,
        };
      }
    }

    // ISO timestamp in error: "resets at 2026-09-01T14:30:00Z"
    const dateMatch = errorMessage.match(
      /(?:resets?.?at|retry.?at)\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/i
    );
    if (dateMatch && dateMatch[1]) {
      const parsed = Date.parse(dateMatch[1]);
      if (!isNaN(parsed)) {
        const diffMs = parsed - now;
        return {
          delayMs: diffMs > 0 ? diffMs : 0,
          expectedResetTime: parsed,
          hasHeader: false,
        };
      }
    }
  }

  return {
    delayMs: null,
    expectedResetTime: null,
    hasHeader: false,
  };
}

/**
 * Extracts a retry delay in milliseconds from HTTP response headers or error message text.
 * Returns null if no explicit retry delay is specified.
 */
export function extractRetryAfterDelay(
  headers?: Record<string, string>,
  errorMessage?: string,
  now = Date.now()
): number | null {
  return extractRetryAfterInfo(headers, errorMessage, now).delayMs;
}

export interface ClassifyInput {
  stopReason?: string;
  errorMessage?: string;
  content?: any[];
  httpStatus?: number;
  httpHeaders?: Record<string, string>;
}

/**
 * Classifies an agent message, turn, or provider response to identify interruption type.
 */
export function classifyInterruption(input: ClassifyInput): ClassificationResult {
  const { stopReason, errorMessage, content, httpStatus, httpHeaders } = input;
  const retryInfo = extractRetryAfterInfo(httpHeaders, errorMessage);

  // 1. Direct HTTP 429 / 503 / 529 Rate Limit or Overload
  if (httpStatus === 429) {
    return {
      type: "RATE_LIMIT",
      reason: "HTTP 429 Too Many Requests (Rate Limited)",
      errorMessage: errorMessage || "HTTP 429 Too Many Requests",
      retryAfterMs: retryInfo.delayMs ?? undefined,
      retryAfterHeaderReceived: retryInfo.hasHeader,
      expectedResetTime: retryInfo.expectedResetTime ?? undefined,
      rawStopReason: stopReason,
    };
  }

  if (httpStatus === 503 || httpStatus === 529) {
    return {
      type: "RATE_LIMIT",
      reason: `HTTP ${httpStatus} Provider Overloaded`,
      errorMessage: errorMessage || `HTTP ${httpStatus} Service Unavailable / Overloaded`,
      retryAfterMs: retryInfo.delayMs ?? undefined,
      retryAfterHeaderReceived: retryInfo.hasHeader,
      expectedResetTime: retryInfo.expectedResetTime ?? undefined,
      rawStopReason: stopReason,
    };
  }

  // 2. Provider Error Messages
  if (stopReason === "error" || (errorMessage && errorMessage.trim().length > 0)) {
    const errorText = errorMessage || "";

    // Check Context Overflow first (should defer to auto-compaction, not retry in a loop)
    if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(errorText))) {
      return {
        type: "CONTEXT_OVERFLOW",
        reason: "Context window overflow",
        errorMessage: errorText,
        rawStopReason: stopReason,
      };
    }

    // Check non-retryable fatal billing / account limits
    if (BILLING_HARD_LIMIT_PATTERNS.some((p) => p.test(errorText))) {
      return {
        type: "BILLING_HARD_LIMIT",
        reason: "Billing hard limit or authentication failure (non-retryable)",
        errorMessage: errorText,
        rawStopReason: stopReason,
      };
    }

    // Check transient rate limits and quota resets
    if (RATE_LIMIT_PATTERNS.some((p) => p.test(errorText))) {
      return {
        type: "RATE_LIMIT",
        reason: "Provider rate limit or quota exceeded",
        errorMessage: errorText,
        retryAfterMs: retryInfo.delayMs ?? undefined,
        retryAfterHeaderReceived: retryInfo.hasHeader,
        expectedResetTime: retryInfo.expectedResetTime ?? undefined,
        rawStopReason: stopReason,
      };
    }
  }

  // 3. Incomplete Tool Call Check
  // Check if output ended mid-tool-call (e.g. truncated arguments or empty JSON object)
  if (Array.isArray(content) && content.length > 0) {
    const lastContent = content[content.length - 1];
    if (lastContent?.type === "toolCall") {
      const args = lastContent.arguments;
      const isEmptyArgs =
        args === undefined ||
        args === null ||
        (typeof args === "object" && Object.keys(args).length === 0);
      if (isEmptyArgs && stopReason !== "stop") {
        return {
          type: "INCOMPLETE_TOOL_CALL",
          reason: "Tool call cut off with missing or incomplete arguments",
          errorMessage,
          rawStopReason: stopReason,
        };
      }
    }
  }

  // 4. Token Limit Truncation (stopReason === "length")
  if (stopReason === "length") {
    return {
      type: "TOKEN_LIMIT",
      reason: "Response reached maximum output tokens (max_tokens)",
      errorMessage,
      rawStopReason: stopReason,
    };
  }

  return {
    type: "NONE",
    reason: "Normal message completion",
    errorMessage,
    rawStopReason: stopReason,
  };
}
