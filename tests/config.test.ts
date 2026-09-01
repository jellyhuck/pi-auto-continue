import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, parseDuration } from "../src/config.ts";
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
            maxContinuations: 8,
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
        assert.equal(config.tokenLimit.maxContinuations, 8);
        assert.equal(config.tokenLimit.maxRetryDurationMs, 3600000);
        assert.equal(config.tokenLimit.baseDelayMs, 2000);
        assert.equal(config.tokenLimit.maxDelayMs, 30000);
        assert.equal(config.tokenLimit.backoffMultiplier, 3);
        assert.equal(config.tokenLimit.continuePrompt, "Keep going please.");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("supports legacy autoResume section and maxResumes fallback", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-legacy-"));
      const tmpFile = path.join(tmpDir, "settings.json");

      const settings = {
        autoResume: {
          enabled: true,
          maxResumes: 4,
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
        assert.equal(config.tokenLimit.maxContinuations, 4);
        assert.equal(config.tokenLimit.baseDelayMs, DEFAULT_CONFIG.tokenLimit.baseDelayMs);
        assert.equal(config.rateLimit.enabled, true);
        assert.ok(config.rateLimit.maxRetryDurationMs >= DEFAULT_MAX_RETRY_DURATION_MS);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
