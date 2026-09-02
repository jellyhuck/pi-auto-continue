import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_MAX_RETRY_DURATION_MS } from "./constants.ts";
import type { AutoContinueConfig } from "./types.ts";

/**
 * Parses duration strings like "5h", "30m", "45s", "500ms" or numeric values in milliseconds.
 */
export function parseDuration(val: unknown, fallback: number): number {
  if (typeof val === "number" && !isNaN(val) && val >= 0) {
    return Math.round(val);
  }
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min|minutes?|h|hours?|d|days?)$/);
    if (match && match[1] && match[2]) {
      const num = parseFloat(match[1]);
      const unit = match[2];
      if (!isNaN(num) && num >= 0) {
        if (unit === "ms") return Math.round(num);
        if (unit.startsWith("s")) return Math.round(num * 1000);
        if (unit.startsWith("m")) return Math.round(num * 60 * 1000);
        if (unit.startsWith("h")) return Math.round(num * 3600 * 1000);
        if (unit.startsWith("d")) return Math.round(num * 86400 * 1000);
      }
    }
    const parsedNum = parseFloat(trimmed);
    if (!isNaN(parsedNum) && parsedNum >= 0) {
      return Math.round(parsedNum);
    }
  }
  return fallback;
}

/**
 * Parses time strings like "14:30", "9:15", "14:30:00", "2:30pm" to target epoch timestamp (ms).
 * If the target time has already passed today, it targets the next occurrence tomorrow.
 * Returns null if format is invalid.
 */
export function parseTargetTime(
  val: unknown,
  now: Date | number = new Date()
): { targetTimeMs: number; hours: number; minutes: number; seconds: number } | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim().toLowerCase();
  const match = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  const ampm = match[4];

  if (ampm) {
    if (ampm === "pm" && hours < 12) {
      hours += 12;
    } else if (ampm === "am" && hours === 12) {
      hours = 0;
    }
  }

  const nowDate = typeof now === "number" ? new Date(now) : now;
  const target = new Date(nowDate.getTime());
  target.setHours(hours, minutes, seconds, 0);

  if (target.getTime() <= nowDate.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return {
    targetTimeMs: target.getTime(),
    hours,
    minutes,
    seconds,
  };
}

/**
 * Loads and merges configuration from Pi's settings.json.
 */
export function loadConfig(customSettingsPath?: string): AutoContinueConfig {
  const settingsPath =
    customSettingsPath ||
    path.join(
      process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
      "settings.json"
    );

  let rawConfig: any = {};

  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      // Support "autoContinue" as primary and "autoResume" as legacy fallback
      rawConfig = settings.autoContinue || settings.autoResume || {};
    }
  } catch {
    // If settings cannot be read/parsed, fallback cleanly to defaults
    return { ...DEFAULT_CONFIG };
  }

  const rateLimitRaw = rawConfig.rateLimit || {};
  const tokenLimitRaw = rawConfig.tokenLimit || {};
  const incompleteToolCallRaw = rawConfig.incompleteToolCall || {};

  // Parse maxRetryDurationMs, handling legacy maxRetries if present
  let maxRetryDurationMs = DEFAULT_MAX_RETRY_DURATION_MS;
  if (rateLimitRaw.maxRetryDurationMs !== undefined) {
    maxRetryDurationMs = parseDuration(
      rateLimitRaw.maxRetryDurationMs,
      DEFAULT_MAX_RETRY_DURATION_MS
    );
  } else if (rateLimitRaw.maxRetries !== undefined && typeof rateLimitRaw.maxRetries === "number") {
    // Legacy fallback: convert maxRetries * maxDelayMs or default
    const maxDelay = parseDuration(rateLimitRaw.maxDelayMs, DEFAULT_CONFIG.rateLimit.maxDelayMs);
    maxRetryDurationMs = Math.max(DEFAULT_MAX_RETRY_DURATION_MS, rateLimitRaw.maxRetries * maxDelay);
  }

  const baseDelayMs = parseDuration(
    rateLimitRaw.baseDelayMs,
    DEFAULT_CONFIG.rateLimit.baseDelayMs
  );
  const maxDelayMs = parseDuration(
    rateLimitRaw.maxDelayMs,
    DEFAULT_CONFIG.rateLimit.maxDelayMs
  );

  const tokenMaxRetryDurationMs = parseDuration(
    tokenLimitRaw.maxRetryDurationMs,
    DEFAULT_CONFIG.tokenLimit.maxRetryDurationMs
  );

  const tokenBaseDelayMs = parseDuration(
    tokenLimitRaw.baseDelayMs,
    DEFAULT_CONFIG.tokenLimit.baseDelayMs
  );

  const tokenMaxDelayMs = parseDuration(
    tokenLimitRaw.maxDelayMs,
    DEFAULT_CONFIG.tokenLimit.maxDelayMs
  );

  const tokenBackoffMultiplier =
    typeof tokenLimitRaw.backoffMultiplier === "number" && tokenLimitRaw.backoffMultiplier >= 1
      ? tokenLimitRaw.backoffMultiplier
      : DEFAULT_CONFIG.tokenLimit.backoffMultiplier;

  return {
    enabled: rawConfig.enabled !== false,
    rateLimit: {
      enabled: rateLimitRaw.enabled !== false,
      maxRetryDurationMs,
      baseDelayMs,
      maxDelayMs,
      backoffMultiplier:
        typeof rateLimitRaw.backoffMultiplier === "number" && rateLimitRaw.backoffMultiplier > 1
          ? rateLimitRaw.backoffMultiplier
          : DEFAULT_CONFIG.rateLimit.backoffMultiplier,
      jitter: rateLimitRaw.jitter !== false,
    },
    tokenLimit: {
      enabled: tokenLimitRaw.enabled !== false,
      maxRetryDurationMs: tokenMaxRetryDurationMs,
      baseDelayMs: tokenBaseDelayMs,
      maxDelayMs: tokenMaxDelayMs,
      backoffMultiplier: tokenBackoffMultiplier,
      continuePrompt:
        tokenLimitRaw.continuePrompt ||
        rawConfig.continuePrompt ||
        DEFAULT_CONFIG.tokenLimit.continuePrompt,
    },
    incompleteToolCall: {
      enabled: incompleteToolCallRaw.enabled !== false,
      continuePrompt:
        incompleteToolCallRaw.continuePrompt ||
        DEFAULT_CONFIG.incompleteToolCall.continuePrompt,
    },
  };
}
