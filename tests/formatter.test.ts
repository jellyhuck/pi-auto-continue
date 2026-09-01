import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDelay, formatDuration, truncateErrorMessage } from "../src/formatter.ts";

describe("formatter", () => {
  describe("formatDuration", () => {
    it("formats seconds correctly", () => {
      assert.equal(formatDuration(0), "0s");
      assert.equal(formatDuration(5000), "5s");
      assert.equal(formatDuration(45000), "45s");
    });

    it("formats minutes correctly", () => {
      assert.equal(formatDuration(60000), "1m");
      assert.equal(formatDuration(90000), "1m 30s");
      assert.equal(formatDuration(185000), "3m 5s");
    });

    it("formats hours correctly", () => {
      assert.equal(formatDuration(3600000), "1h");
      assert.equal(formatDuration(5400000), "1h 30m");
      assert.equal(formatDuration(5 * 60 * 60 * 1000), "5h");
      assert.equal(formatDuration(5 * 60 * 60 * 1000 + 15 * 60 * 1000), "5h 15m");
    });

    it("handles negative durations safely", () => {
      assert.equal(formatDuration(-1000), "0s");
    });
  });

  describe("formatDelay", () => {
    it("formats milliseconds", () => {
      assert.equal(formatDelay(500), "500ms");
    });

    it("formats seconds", () => {
      assert.equal(formatDelay(5000), "5s");
      assert.equal(formatDelay(12500), "12.5s");
    });

    it("formats minutes", () => {
      assert.equal(formatDelay(60000), "1m");
      assert.equal(formatDelay(90000), "1.5m");
    });

    it("formats hours", () => {
      assert.equal(formatDelay(3600000), "1h");
      assert.equal(formatDelay(7200000), "2h");
    });
  });

  describe("truncateErrorMessage", () => {
    it("handles empty or missing strings", () => {
      assert.equal(truncateErrorMessage(undefined), "Unknown error");
      assert.equal(truncateErrorMessage(""), "Unknown error");
    });

    it("normalizes newlines and spaces", () => {
      const multiline = "Error on line 1\n   Error on line 2\r\n\tDetails";
      assert.equal(truncateErrorMessage(multiline), "Error on line 1 Error on line 2 Details");
    });

    it("truncates long strings cleanly", () => {
      const long = "A".repeat(200);
      const truncated = truncateErrorMessage(long, 50);
      assert.equal(truncated.length, 50);
      assert.ok(truncated.endsWith("..."));
    });
  });
});
