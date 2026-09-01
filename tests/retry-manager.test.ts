import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/constants.ts";
import { RetryManager } from "../src/retry-manager.ts";

describe("RetryManager", () => {
  it("starts in an idle state", () => {
    const manager = new RetryManager();
    const state = manager.getState();
    assert.equal(state.isRetrying, false);
    assert.equal(state.startTime, null);
    assert.equal(state.attempt, 0);
  });

  it("calculates initial retry and advances attempts", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        baseDelayMs: 2000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    const res1 = manager.evaluateRetry(config, "Rate limited", null, startTime);

    assert.equal(res1.canRetry, true);
    assert.equal(res1.attempt, 1);
    assert.equal(res1.delayMs, 2000);
    assert.equal(res1.elapsedMs, 0);
    assert.equal(res1.deadlineExceeded, false);

    // Second attempt 5 seconds later
    const res2 = manager.evaluateRetry(config, "Rate limited again", null, startTime + 5000);
    assert.equal(res2.canRetry, true);
    assert.equal(res2.attempt, 2);
    assert.equal(res2.delayMs, 4000); // 2000 * 2^1 = 4000
    assert.equal(res2.elapsedMs, 5000);
  });

  it("respects explicit Retry-After delay when provided", () => {
    const manager = new RetryManager();
    const config = { ...DEFAULT_CONFIG };

    const res = manager.evaluateRetry(config, "Rate limited", 15000, 1000000);
    assert.equal(res.canRetry, true);
    assert.equal(res.delayMs, 15000);
  });

  it("caps single delay to maxDelayMs", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        baseDelayMs: 5000,
        maxDelayMs: 10000,
        jitter: false,
      },
    };

    // Attempt 1 -> 5000
    manager.evaluateRetry(config, "Rate limited", null, 1000000);
    // Attempt 2 -> 10000
    manager.evaluateRetry(config, "Rate limited", null, 1005000);
    // Attempt 3 -> 20000 capped at 10000
    const res3 = manager.evaluateRetry(config, "Rate limited", null, 1015000);
    assert.equal(res3.delayMs, 10000);

    // Explicit delay above max is also capped
    const resExplicit = manager.evaluateRetry(config, "Rate limited", 999999, 1025000);
    assert.equal(resExplicit.delayMs, 10000);
  });

  it("enforces maxRetryDurationMs deadline", () => {
    const manager = new RetryManager();
    const duration = 60000; // 1 minute max duration
    const config = {
      ...DEFAULT_CONFIG,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        maxRetryDurationMs: duration,
        baseDelayMs: 5000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Attempt 1 at t=0s
    const res1 = manager.evaluateRetry(config, "Rate limited", null, startTime);
    assert.equal(res1.canRetry, true);

    // Attempt 2 at t=30s (within 60s deadline)
    const res2 = manager.evaluateRetry(config, "Rate limited", null, startTime + 30000);
    assert.equal(res2.canRetry, true);

    // Attempt 3 at t=60s (deadline expired)
    const res3 = manager.evaluateRetry(config, "Rate limited", null, startTime + 60000);
    assert.equal(res3.canRetry, false);
    assert.equal(res3.deadlineExceeded, true);
    assert.ok(res3.reason?.includes("Maximum retry duration"));

    // Attempt 4 at t=75s (past deadline)
    const res4 = manager.evaluateRetry(config, "Rate limited", null, startTime + 75000);
    assert.equal(res4.canRetry, false);
    assert.equal(res4.deadlineExceeded, true);
  });

  it("clamps delay so it does not exceed remaining retry duration", () => {
    const manager = new RetryManager();
    const config = {
      ...DEFAULT_CONFIG,
      rateLimit: {
        ...DEFAULT_CONFIG.rateLimit,
        maxRetryDurationMs: 30000, // 30s max
        baseDelayMs: 10000,
        jitter: false,
      },
    };

    const startTime = 1000000;
    // Start at t=0
    manager.evaluateRetry(config, "Rate limit", null, startTime);

    // At t=25s, remaining time is 5s. Calculated delay would be 20s, but must clamp to 5s.
    const res = manager.evaluateRetry(config, "Rate limit", null, startTime + 25000);
    assert.equal(res.canRetry, true);
    assert.equal(res.remainingMs, 5000);
    assert.equal(res.delayMs, 5000);
  });

  it("resets state properly", () => {
    const manager = new RetryManager();
    manager.evaluateRetry(DEFAULT_CONFIG, "Error", null, 1000000);
    assert.equal(manager.getState().isRetrying, true);

    manager.reset();
    const state = manager.getState();
    assert.equal(state.isRetrying, false);
    assert.equal(state.startTime, null);
    assert.equal(state.attempt, 0);
  });

  it("returns human-readable status summary", () => {
    const manager = new RetryManager();
    assert.equal(manager.getStatusSummary(DEFAULT_CONFIG), "Idle (no active retry loop)");

    manager.evaluateRetry(DEFAULT_CONFIG, "HTTP 429 Quota Exceeded", null, 1000000);
    const summary = manager.getStatusSummary(DEFAULT_CONFIG, 1010000);
    assert.ok(summary.includes("Active Retry Loop:"));
    assert.ok(summary.includes("Attempt: 1"));
    assert.ok(summary.includes("HTTP 429 Quota Exceeded"));
  });
});
