import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, parseDuration, parseTargetTime } from "../src/config.ts";
import { DEFAULT_CONFIG, DEFAULT_MAX_RETRY_DURATION_MS } from "../src/constants.ts";

describe("config", () => {
  describe("parseDuration", () => {
    it("parses numbers directly", () => {
      assert.equal(parseDuration(5000, 1000), 5000);
      assert.equal(parseDuration(0, 1000), 0);
    });

    it("parses duration strings", () => {
      assert.equal(parseDuration("500ms", 1000), 500);
      assert.equal(parseDuration("45s", 1000), 45000);
      assert.equal(parseDuration("30m", 1000), 1800000);
      assert.equal(parseDuration("5h", 1000), 18000000);
      assert.equal(parseDuration("1d", 1000), 86400000);
    });

    it("falls back for invalid strings or negative values", () => {
      assert.equal(parseDuration("invalid", 5000), 5000);
      assert.equal(parseDuration(-100, 5000), 5000);
      assert.equal(parseDuration(null, 5000), 5000);
      assert.equal(parseDuration(undefined, 5000), 5000);
    });
  });

  describe("parseTargetTime", () => {
    it("parses 24-hour HH:MM format", () => {
      // Mock reference time: 2026-09-02 12:00:00 local time
      const baseDate = new Date(2026, 8, 2, 12, 0, 0);
      const res = parseTargetTime("14:30", baseDate);

      assert.ok(res);
      assert.equal(res.hours, 14);
      assert.equal(res.minutes, 30);
      assert.equal(res.seconds, 0);

      const expectedDate = new Date(2026, 8, 2, 14, 30, 0);
      assert.equal(res.targetTimeMs, expectedDate.getTime());
    });

    it("parses HH:MM:SS format with seconds", () => {
      const baseDate = new Date(2026, 8, 2, 12, 0, 0);
      const res = parseTargetTime("14:30:45", baseDate);

      assert.ok(res);
      assert.equal(res.hours, 14);
      assert.equal(res.minutes, 30);
      assert.equal(res.seconds, 45);

      const expectedDate = new Date(2026, 8, 2, 14, 30, 45);
      assert.equal(res.targetTimeMs, expectedDate.getTime());
    });

    it("parses 12-hour format with AM/PM", () => {
      const baseDate = new Date(2026, 8, 2, 10, 0, 0);

      const pmRes = parseTargetTime("2:30pm", baseDate);
      assert.ok(pmRes);
      assert.equal(pmRes.hours, 14);
      assert.equal(pmRes.minutes, 30);

      const amRes = parseTargetTime("11:15 am", baseDate);
      assert.ok(amRes);
      assert.equal(amRes.hours, 11);
      assert.equal(amRes.minutes, 15);

      const midnightRes = parseTargetTime("12:00am", baseDate);
      assert.ok(midnightRes);
      assert.equal(midnightRes.hours, 0);

      const noonRes = parseTargetTime("12:30pm", baseDate);
      assert.ok(noonRes);
      assert.equal(noonRes.hours, 12);
    });

    it("rolls over to tomorrow if target time has already passed today", () => {
      // Mock reference time: 2026-09-02 15:00:00 local time
      const baseDate = new Date(2026, 8, 2, 15, 0, 0);
      // Scheduled for 14:00 (which passed 1 hour ago today)
      const res = parseTargetTime("14:00", baseDate);

      assert.ok(res);
      assert.equal(res.hours, 14);
      assert.equal(res.minutes, 0);

      const expectedTomorrow = new Date(2026, 8, 3, 14, 0, 0);
      assert.equal(res.targetTimeMs, expectedTomorrow.getTime());
    });

    it("returns null for invalid strings or out-of-range values", () => {
      assert.equal(parseTargetTime("invalid"), null);
      assert.equal(parseTargetTime("25:00"), null);
      assert.equal(parseTargetTime("14:60"), null);
      assert.equal(parseTargetTime("14:30:99"), null);
      assert.equal(parseTargetTime(""), null);
      assert.equal(parseTargetTime(null), null);
      assert.equal(parseTargetTime(undefined), null);
    });
  });

  describe("loadConfig", () => {
    it("returns DEFAULT_CONFIG when file does not exist", () => {
      const config = loadConfig("/path/to/nonexistent/settings.json");
      assert.deepEqual(config, DEFAULT_CONFIG);
      assert.equal(config.rateLimit.maxRetryDurationMs, DEFAULT_MAX_RETRY_DURATION_MS);
    });

    it("loads configuration from autoContinue section", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-test-"));
      const tmpFile = path.join(tmpDir, "settings.json");

      const settings = {
        autoContinue: {
          enabled: true,
          rateLimit: {
            enabled: true,
            maxRetryDurationMs: "2h",
            baseDelayMs: "10s",
            maxDelayMs: "5m",
            jitter: false,
          },
          tokenLimit: {
            maxRetryDurationMs: "1h",
            baseDelayMs: "2s",
            maxDelayMs: "30s",
            backoffMultiplier: 3,
            continuePrompt: "Keep going please.",
          },
        },
      };

      fs.writeFileSync(tmpFile, JSON.stringify(settings));

      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.enabled, true);
        assert.equal(config.rateLimit.maxRetryDurationMs, 2 * 3600 * 1000);
        assert.equal(config.rateLimit.baseDelayMs, 10000);
        assert.equal(config.rateLimit.maxDelayMs, 300000);
        assert.equal(config.rateLimit.jitter, false);
        assert.equal(config.tokenLimit.maxRetryDurationMs, 3600000);
        assert.equal(config.tokenLimit.baseDelayMs, 2000);
        assert.equal(config.tokenLimit.maxDelayMs, 30000);
        assert.equal(config.tokenLimit.backoffMultiplier, 3);
        assert.equal(config.tokenLimit.continuePrompt, "Keep going please.");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("supports legacy autoResume section and fallback", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-legacy-"));
      const tmpFile = path.join(tmpDir, "settings.json");

      const settings = {
        autoResume: {
          enabled: true,
          delayMs: 1500,
          continuePrompt: "Continue where left off.",
          rateLimit: {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 60000,
            maxDelayMs: 3600000,
          },
        },
      };

      fs.writeFileSync(tmpFile, JSON.stringify(settings));

      try {
        const config = loadConfig(tmpFile);
        assert.equal(config.enabled, true);
        assert.equal(config.tokenLimit.continuePrompt, "Continue where left off.");
        assert.equal(config.tokenLimit.baseDelayMs, DEFAULT_CONFIG.tokenLimit.baseDelayMs);
        assert.equal(config.rateLimit.enabled, true);
        assert.ok(config.rateLimit.maxRetryDurationMs >= DEFAULT_MAX_RETRY_DURATION_MS);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
