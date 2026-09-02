import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyInterruption, extractRetryAfterInfo } from "./classifier.ts";
import { loadConfig } from "./config.ts";
import {
  formatDateTime,
  formatDelay,
  formatDuration,
  formatTime,
  truncateErrorMessage,
} from "./formatter.ts";
import { RetryManager } from "./retry-manager.ts";
import type { AutoContinueConfig } from "./types.ts";

/**
 * Utility helper to pause execution for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI, customSettingsPath?: string) {
  let config: AutoContinueConfig = loadConfig(customSettingsPath);
  const retryManager = new RetryManager();
  let continuationCount = 0;
  let continuationStartTime: number | null = null;
  let lastProcessedMessageTimestamp: number | null = null;
  let lastHttpResponse: { status: number; headers: Record<string, string>; time: number } | null = null;
  let lastExpectedTokenResetTime: number | null = null;
  let isExecutingContinuation = false;
  let isSendingOwnRetryPrompt = false;

  /**
   * Centralized UI notification helper that adds the current time timestamp [HH:MM:SS].
   */
  const notify = (
    ctx: any,
    message: string,
    type: "info" | "warning" | "error" = "info",
    now = Date.now()
  ) => {
    if (!ctx?.hasUI || !ctx.ui) return;
    const timeStr = formatTime(now);
    let body = message.trim();
    if (body.startsWith("[auto-continue]")) {
      body = body.slice("[auto-continue]".length).trim();
    }
    ctx.ui.notify(`[auto-continue] [${timeStr}] ${body}`, type);
  };

  const resetTurnState = () => {
    continuationCount = 0;
    continuationStartTime = null;
    lastProcessedMessageTimestamp = null;
    lastHttpResponse = null;
    lastExpectedTokenResetTime = null;
  };

  // 1. Session start: reload config and reset all state
  pi.on("session_start", async (_event, _ctx) => {
    config = loadConfig(customSettingsPath);
    retryManager.reset();
    resetTurnState();
    isExecutingContinuation = false;
    isSendingOwnRetryPrompt = false;
  });

  // 2. Capture HTTP responses (e.g. 429 with retry-after headers)
  pi.on("after_provider_response", async (event, _ctx) => {
    lastHttpResponse = {
      status: event.status,
      headers: event.headers,
      time: Date.now(),
    };
    if (event.headers) {
      const info = extractRetryAfterInfo(event.headers, undefined, lastHttpResponse.time);
      if (info.hasHeader && info.expectedResetTime) {
        lastExpectedTokenResetTime = info.expectedResetTime;
      }
    }
  });

  // 3. Intercept input messages: suppress external extension messages during retries
  pi.on("input", async (event, ctx) => {
    if (!config.enabled) return { action: "continue" };

    const isRetrying = retryManager.getState().isRetrying;
    const isBusy = isRetrying || isExecutingContinuation;

    // A. User interactive / RPC input takes precedence and cancels retry loop
    if (event.source === "interactive" || event.source === "rpc") {
      if (isBusy) {
        retryManager.reset();
        resetTurnState();
        if (ctx.hasUI) {
          notify(
            ctx,
            "🛑 User input received: cancelling active retry/continuation loop.",
            "info"
          );
        }
      }
      return { action: "continue" };
    }

    // B. Programmatic messages from auto-continue itself
    const isOwnPrompt =
      isSendingOwnRetryPrompt ||
      event.text ===
        "The previous request encountered a rate/quota limit. Please continue with your task." ||
      event.text === config.tokenLimit.continuePrompt ||
      event.text === config.incompleteToolCall.continuePrompt;

    if (isOwnPrompt) {
      return { action: "continue" };
    }

    // C. Drop third-party extension messages during retry or continuation
    if (isBusy && event.source === "extension") {
      const preview =
        typeof event.text === "string"
          ? event.text.slice(0, 60).replace(/\r?\n/g, " ")
          : "";
      if (ctx.hasUI) {
        notify(
          ctx,
          `⏸️ Dropped extension message while waiting for retry/continuation${
            preview ? `: "${preview}..."` : "."
          }`,
          "warning"
        );
      }
      return { action: "handled" };
    }

    return { action: "continue" };
  });

  // 3. Reset turn-level continuation counter on fresh user input
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!isExecutingContinuation) {
      continuationCount = 0;
      continuationStartTime = null;
      lastProcessedMessageTimestamp = null;
    }

    if (!config.enabled) return;

    const autoContinueGuidance = `

## Auto-Continue Behavior
When your response is cut off due to token limits or incomplete tool calls, you will automatically receive a continuation prompt.
- Do NOT repeat what you have already written.
- Continue immediately and seamlessly from where the previous response ended.
- If a tool call was cut off mid-arguments, complete the tool call.
`;

    return {
      systemPrompt: event.systemPrompt + autoContinueGuidance,
    };
  });

  // 4. Handle interruptions when an assistant message ends
  pi.on("message_end", async (event, ctx) => {
    if (!config.enabled) return;

    const message = event.message;
    if (message.role !== "assistant") return;

    // Prevent duplicate processing of the exact same message
    if (message.timestamp && message.timestamp === lastProcessedMessageTimestamp) {
      return;
    }

    // Check if HTTP response was captured recently (within last 30s)
    const httpStatus =
      lastHttpResponse && Date.now() - lastHttpResponse.time < 30000
        ? lastHttpResponse.status
        : undefined;
    const httpHeaders =
      lastHttpResponse && Date.now() - lastHttpResponse.time < 30000
        ? lastHttpResponse.headers
        : undefined;

    const classification = classifyInterruption({
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      content: message.content,
      httpStatus,
      httpHeaders,
    });

    if (classification.type === "NONE") {
      return;
    }

    lastProcessedMessageTimestamp = message.timestamp || Date.now();

    // =========================================================================
    // CASE 1: Rate Limit / Quota Exhaustion / Provider Overload
    // =========================================================================
    if (classification.type === "RATE_LIMIT") {
      if (classification.retryAfterHeaderReceived && classification.expectedResetTime) {
        lastExpectedTokenResetTime = classification.expectedResetTime;
      }

      const retryResult = retryManager.evaluateRetry(
        config,
        classification.errorMessage || classification.reason,
        classification.retryAfterMs,
        Date.now(),
        classification.expectedResetTime,
        classification.retryAfterHeaderReceived
      );

      if (!retryResult.canRetry) {
        if (retryResult.deadlineExceeded) {
          if (ctx.hasUI) {
            notify(
              ctx,
              `⏱️ Rate limit retry stopped: maximum retry duration of ${formatDuration(
                config.rateLimit.maxRetryDurationMs
              )} exceeded after ${retryResult.attempt} attempt(s).\nObserved error: "${truncateErrorMessage(
                classification.errorMessage
              )}"`,
              "error"
            );
          }
        } else if (retryResult.reason) {
          if (ctx.hasUI) {
            notify(ctx, `Rate limit retry stopped: ${retryResult.reason}`, "warning");
          }
        }
        retryManager.reset();
        return;
      }

      if (ctx.hasUI) {
        const errorSummary = truncateErrorMessage(classification.errorMessage);
        let waitMsg =
          `⚠️ Rate limit / quota error detected: "${errorSummary}"\n` +
          `Waiting ${formatDelay(retryResult.delayMs)} before retry (attempt #${
            retryResult.attempt
          }, elapsed: ${formatDuration(retryResult.elapsedMs)} / max: ${formatDuration(
            config.rateLimit.maxRetryDurationMs
          )})...`;

        if (classification.retryAfterHeaderReceived && classification.expectedResetTime) {
          waitMsg += `\nExpected token reset time: ${formatDateTime(classification.expectedResetTime)}`;
        }

        notify(ctx, waitMsg, "warning");
      }

      // Asynchronously wait for backoff or retry-after delay
      isExecutingContinuation = true;
      try {
        await sleep(retryResult.delayMs);

        if (ctx.hasUI) {
          notify(
            ctx,
            `🔄 Retrying request (attempt #${retryResult.attempt}, elapsed: ${formatDuration(
              Date.now() - (retryManager.getState().startTime || Date.now())
            )})...`,
            "info"
          );
        }

        isSendingOwnRetryPrompt = true;
        try {
          pi.sendUserMessage(
            "The previous request encountered a rate/quota limit. Please continue with your task.",
            { deliverAs: "followUp", streamingBehavior: "followUp" } as any
          );
        } finally {
          queueMicrotask(() => {
            isSendingOwnRetryPrompt = false;
          });
        }
      } catch (err) {
        if (ctx.hasUI) {
          notify(
            ctx,
            `Failed to send retry prompt: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
      } finally {
        isExecutingContinuation = false;
      }
      return;
    }

    // =========================================================================
    // CASE 2: Token Limit Truncation (max_tokens / stopReason: "length")
    // =========================================================================
    if (classification.type === "TOKEN_LIMIT") {
      if (!config.tokenLimit.enabled) return;

      const now = Date.now();
      if (continuationStartTime === null) {
        continuationStartTime = now;
      }
      const elapsedMs = now - continuationStartTime;

      if (elapsedMs >= config.tokenLimit.maxRetryDurationMs) {
        if (ctx.hasUI) {
          notify(
            ctx,
            `⏱️ Token limit continuation stopped: maximum duration of ${formatDuration(
              config.tokenLimit.maxRetryDurationMs
            )} exceeded after ${continuationCount} continuation(s).`,
            "error"
          );
        }
        return;
      }

      const rawDelay =
        config.tokenLimit.baseDelayMs *
        Math.pow(config.tokenLimit.backoffMultiplier, Math.max(0, continuationCount));
      let delayMs = Math.min(rawDelay, config.tokenLimit.maxDelayMs);
      const remainingMs = Math.max(0, config.tokenLimit.maxRetryDurationMs - elapsedMs);
      if (delayMs > remainingMs) {
        delayMs = remainingMs;
      }

      continuationCount++;

      if (ctx.hasUI) {
        notify(
          ctx,
          `✂️ Response truncated (max tokens reached). Continuing (attempt #${continuationCount}, delay: ${formatDelay(
            delayMs
          )})...`,
          "info"
        );
      }

      isExecutingContinuation = true;
      try {
        await sleep(delayMs);
        isSendingOwnRetryPrompt = true;
        try {
          pi.sendUserMessage(config.tokenLimit.continuePrompt, {
            deliverAs: "followUp",
            streamingBehavior: "followUp",
          } as any);
        } finally {
          queueMicrotask(() => {
            isSendingOwnRetryPrompt = false;
          });
        }
      } catch (err) {
        if (ctx.hasUI) {
          notify(
            ctx,
            `Auto-continue failed: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
        continuationCount--;
      } finally {
        isExecutingContinuation = false;
      }
      return;
    }

    // =========================================================================
    // CASE 3: Incomplete Tool Call (Cut off mid-arguments)
    // =========================================================================
    if (classification.type === "INCOMPLETE_TOOL_CALL") {
      if (!config.incompleteToolCall.enabled) return;

      const now = Date.now();
      if (continuationStartTime === null) {
        continuationStartTime = now;
      }
      const elapsedMs = now - continuationStartTime;

      if (elapsedMs >= config.tokenLimit.maxRetryDurationMs) {
        if (ctx.hasUI) {
          notify(
            ctx,
            `⏱️ Incomplete tool call continuation stopped: maximum duration of ${formatDuration(
              config.tokenLimit.maxRetryDurationMs
            )} exceeded.`,
            "error"
          );
        }
        return;
      }

      const rawDelay =
        config.tokenLimit.baseDelayMs *
        Math.pow(config.tokenLimit.backoffMultiplier, Math.max(0, continuationCount));
      let delayMs = Math.min(rawDelay, config.tokenLimit.maxDelayMs);
      const remainingMs = Math.max(0, config.tokenLimit.maxRetryDurationMs - elapsedMs);
      if (delayMs > remainingMs) {
        delayMs = remainingMs;
      }

      continuationCount++;

      if (ctx.hasUI) {
        notify(
          ctx,
          `⚙️ Output cut off mid-tool-call. Requesting continuation (attempt #${continuationCount}, delay: ${formatDelay(
            delayMs
          )})...`,
          "info"
        );
      }

      isExecutingContinuation = true;
      try {
        await sleep(delayMs);
        isSendingOwnRetryPrompt = true;
        try {
          pi.sendUserMessage(config.incompleteToolCall.continuePrompt, {
            deliverAs: "followUp",
            streamingBehavior: "followUp",
          } as any);
        } finally {
          queueMicrotask(() => {
            isSendingOwnRetryPrompt = false;
          });
        }
      } catch (err) {
        if (ctx.hasUI) {
          notify(
            ctx,
            `Auto-continue failed: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
        continuationCount--;
      } finally {
        isExecutingContinuation = false;
      }
      return;
    }

    // =========================================================================
    // CASE 4: Context Overflow (defer to Pi auto-compaction)
    // =========================================================================
    if (classification.type === "CONTEXT_OVERFLOW") {
      if (ctx.hasUI) {
        notify(
          ctx,
          `ℹ️ Context overflow detected. Deferring to Pi's built-in auto-compaction.`,
          "info"
        );
      }
      retryManager.reset();
      return;
    }

    // =========================================================================
    // CASE 5: Permanent Billing / Auth Hard Limits
    // =========================================================================
    if (classification.type === "BILLING_HARD_LIMIT") {
      if (ctx.hasUI) {
        notify(
          ctx,
          `🛑 Non-retryable error detected: "${truncateErrorMessage(
            classification.errorMessage
          )}".\nPlease check your account/billing or switch provider with /model.`,
          "error"
        );
      }
      retryManager.reset();
      return;
    }
  });

  // 5. Agent settled: if we were retrying and succeeded, notify and reset
  pi.on("agent_settled", async (_event, ctx) => {
    const retryState = retryManager.getState();
    if (retryState.isRetrying && retryState.attempt > 0) {
      const totalElapsed = retryState.startTime ? Date.now() - retryState.startTime : 0;
      if (ctx.hasUI) {
        notify(
          ctx,
          `✅ Successfully recovered from rate limit after ${
            retryState.attempt
          } retry attempt(s) (total time: ${formatDuration(totalElapsed)}).`,
          "info"
        );
      }
      retryManager.reset();
    }

    if (continuationCount > 0 && !isExecutingContinuation) {
      continuationCount = 0;
    }
  });

  // 6. Register slash commands: /auto-continue and /auto-resume
  const commandHandler = async (args: string, ctx: any) => {
    const subcommand = args.trim().toLowerCase();

    if (subcommand === "status" || subcommand === "") {
      const retryState = retryManager.getState();
      const retryInfo = retryState.isRetrying
        ? `Active (attempt #${retryState.attempt}, elapsed: ${formatDuration(
            Date.now() - (retryState.startTime || Date.now())
          )}, last delay: ${formatDelay(retryState.lastDelayMs)})`
        : "Idle (no active retry loop)";

      const rateLimitLines = [
        `  Rate Limit Settings & Status:`,
        `    Retry: ${config.rateLimit.enabled ? "enabled" : "disabled"}`,
        `    Max retry duration: ${formatDuration(config.rateLimit.maxRetryDurationMs)} (${config.rateLimit.maxRetryDurationMs} ms)`,
        `    Base delay / Max delay: ${formatDelay(config.rateLimit.baseDelayMs)} / ${formatDelay(config.rateLimit.maxDelayMs)}`,
        `    Backoff multiplier: ${config.rateLimit.backoffMultiplier}x`,
        `    Jitter: ${config.rateLimit.jitter ? "enabled" : "disabled"}`,
        `    Current retry status: ${retryInfo}`,
      ];

      const expectedResetTime =
        retryState.expectedTokenResetTime ||
        (retryState.retryAfterHeaderReceived || lastExpectedTokenResetTime ? lastExpectedTokenResetTime : null);
      if (expectedResetTime) {
        const remaining = Math.max(0, expectedResetTime - Date.now());
        const remainingHint = remaining > 0 ? ` (in ${formatDelay(remaining)})` : " (passed)";
        rateLimitLines.push(
          `    Expected token reset time: ${formatDateTime(expectedResetTime)}${remainingHint}`
        );
      }

      const tokenLimitLines = [
        `  Token Limit Settings & Status:`,
        `    Continuations: ${config.tokenLimit.enabled ? "enabled" : "disabled"} (${continuationCount} in current turn)`,
        `    Max retry duration: ${formatDuration(config.tokenLimit.maxRetryDurationMs)} (${config.tokenLimit.maxRetryDurationMs} ms)`,
        `    Base delay / Max delay: ${formatDelay(config.tokenLimit.baseDelayMs)} / ${formatDelay(config.tokenLimit.maxDelayMs)}`,
        `    Backoff multiplier: ${config.tokenLimit.backoffMultiplier}x`,
        `    Incomplete tool call handling: ${config.incompleteToolCall.enabled ? "enabled" : "disabled"}`,
      ];

      const statusText =
        `Auto-Continue Status:\n` +
        `  Global:\n` +
        `    Enabled: ${config.enabled ? "yes" : "no"}\n\n` +
        rateLimitLines.join("\n") +
        `\n\n` +
        tokenLimitLines.join("\n");

      if (ctx.hasUI) {
        notify(ctx, statusText, "info");
      }
      return;
    }

    if (subcommand === "on" || subcommand === "enable") {
      config.enabled = true;
      if (ctx.hasUI) {
        notify(ctx, "Auto-continue enabled", "info");
      }
      return;
    }

    if (subcommand === "off" || subcommand === "disable") {
      config.enabled = false;
      retryManager.reset();
      if (ctx.hasUI) {
        notify(ctx, "Auto-continue disabled", "info");
      }
      return;
    }

    if (subcommand === "reset") {
      retryManager.reset();
      resetTurnState();
      config = loadConfig();
      if (ctx.hasUI) {
        notify(ctx, "Counters and retry state reset to defaults", "info");
      }
      return;
    }

    if (ctx.hasUI) {
      notify(ctx, "Usage: /auto-continue [status | on | off | reset]", "info");
    }
  };

  pi.registerCommand("auto-continue", {
    description: "Check auto-continue status or configure settings",
    handler: commandHandler,
  });

  // Legacy command alias
  pi.registerCommand("auto-resume", {
    description: "Alias for /auto-continue",
    handler: commandHandler,
  });
}
