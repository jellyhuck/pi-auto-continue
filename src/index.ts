import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyInterruption, extractRetryAfterInfo } from "./classifier.ts";
import { loadConfig, parseMaxRetries, parseTargetTime } from "./config.ts";
import {
  formatDateTime,
  formatDelay,
  formatDuration,
  formatMaxRetries,
  formatTime,
  truncateErrorMessage,
} from "./formatter.ts";
import { RetryManager, type RetryCheckResult } from "./retry-manager.ts";
import type { AutoContinueConfig } from "./types.ts";

/**
 * Utility helper to pause execution for a given number of milliseconds, cancellable via AbortSignal.
 */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      resolve(true);
    }, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true }
    );
  });
}

export default function (pi: ExtensionAPI, customSettingsPath?: string) {
  let config: AutoContinueConfig = loadConfig(customSettingsPath);
  const retryManager = new RetryManager();
  let activeAbortController: AbortController | null = null;
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
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    retryManager.reset();
    lastProcessedMessageTimestamp = null;
    lastHttpResponse = null;
    lastExpectedTokenResetTime = null;
    isExecutingContinuation = false;
  };

  /**
   * Executes a retry attempt: emits user notification, waits for delayMs with cancellation support,
   * and dispatches continuation prompt to Pi.
   */
  const executeRetry = async (
    retryResult: RetryCheckResult,
    ctx: any,
    errorMessage?: string,
    expectedResetTime?: number
  ) => {
    if (!retryResult.canRetry) {
      if (retryResult.deadlineExceeded) {
        if (ctx?.hasUI) {
          const errorSuffix = errorMessage
            ? `\nObserved error: "${truncateErrorMessage(errorMessage)}"`
            : "";
          notify(
            ctx,
            `⏱️ Rate limit retry stopped: ${
              retryResult.reason || "limit exceeded"
            } after ${retryResult.attempt} attempt(s).${errorSuffix}`,
            "error"
          );
        }
      } else if (retryResult.reason) {
        if (ctx?.hasUI) {
          notify(ctx, `Rate limit retry stopped: ${retryResult.reason}`, "warning");
        }
      }
      retryManager.reset();
      return;
    }

    if (ctx?.hasUI) {
      const activeLimit = retryManager.getActiveLimit(config, "RATE_LIMIT");
      const limitStr =
        activeLimit.type === "duration"
          ? `attempt #${retryResult.attempt}, elapsed: ${formatDuration(
              retryResult.elapsedMs
            )} / max: ${formatDuration(activeLimit.durationMs)}`
          : `attempt #${retryResult.attempt} of ${activeLimit.count}, elapsed: ${formatDuration(
              retryResult.elapsedMs
            )}`;

      let waitMsg = `Waiting ${formatDelay(retryResult.delayMs)} before retry (${limitStr})...`;

      if (errorMessage) {
        waitMsg =
          `⚠️ Rate limit / quota error detected: "${truncateErrorMessage(errorMessage)}"\n` +
          waitMsg;
      }

      const resetTime = expectedResetTime ?? retryManager.getState().expectedTokenResetTime;
      if (resetTime) {
        waitMsg += `\nExpected token reset time: ${formatDateTime(resetTime)}`;
      }

      notify(ctx, waitMsg, "warning");
    }

    // Cancel any previous pending wait
    if (activeAbortController) {
      activeAbortController.abort();
    }
    const abortController = new AbortController();
    activeAbortController = abortController;

    isExecutingContinuation = true;
    try {
      const completed = await cancellableSleep(retryResult.delayMs, abortController.signal);
      if (!completed || abortController.signal.aborted) {
        return;
      }

      if (ctx?.hasUI) {
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
      if (ctx?.hasUI) {
        notify(
          ctx,
          `Failed to send retry prompt: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    } finally {
      if (activeAbortController === abortController) {
        isExecutingContinuation = false;
        activeAbortController = null;
      }
    }
  };

  // 1. Session start: reload config and reset all state
  pi.on("session_start", async (_event, _ctx) => {
    config = loadConfig(customSettingsPath);
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

  // 3. Reset turn-level retry/continuation state on fresh user input
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!isExecutingContinuation) {
      retryManager.reset();
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
      if (classification.expectedResetTime) {
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

      await executeRetry(
        retryResult,
        ctx,
        classification.errorMessage,
        classification.expectedResetTime
      );
      return;
    }

    // =========================================================================
    // CASE 2: Token Limit Truncation (max_tokens / stopReason: "length")
    // =========================================================================
    if (classification.type === "TOKEN_LIMIT") {
      const continuationResult = retryManager.evaluateContinuation(
        config,
        "TOKEN_LIMIT",
        "Token limit reached (stopReason: length)"
      );

      if (!continuationResult.canRetry) {
        if (continuationResult.deadlineExceeded) {
          if (ctx.hasUI) {
            notify(
              ctx,
              `⏱️ Token limit continuation stopped: ${
                continuationResult.reason || "limit exceeded"
              } after ${continuationResult.attempt} attempt(s).`,
              "error"
            );
          }
        }
        return;
      }

      if (ctx.hasUI) {
        notify(
          ctx,
          `✂️ Response truncated (max tokens reached). Continuing (attempt #${continuationResult.attempt}, delay: ${formatDelay(
            continuationResult.delayMs
          )})...`,
          "info"
        );
      }

      if (activeAbortController) {
        activeAbortController.abort();
      }
      const abortController = new AbortController();
      activeAbortController = abortController;

      isExecutingContinuation = true;
      try {
        const completed = await cancellableSleep(continuationResult.delayMs, abortController.signal);
        if (!completed || abortController.signal.aborted) {
          return;
        }
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
        retryManager.decrementAttempt();
      } finally {
        if (activeAbortController === abortController) {
          isExecutingContinuation = false;
          activeAbortController = null;
        }
      }
      return;
    }

    // =========================================================================
    // CASE 3: Incomplete Tool Call (Cut off mid-arguments)
    // =========================================================================
    if (classification.type === "INCOMPLETE_TOOL_CALL") {
      const continuationResult = retryManager.evaluateContinuation(
        config,
        "INCOMPLETE_TOOL_CALL",
        "Incomplete tool call (output truncated)"
      );

      if (!continuationResult.canRetry) {
        if (continuationResult.deadlineExceeded) {
          if (ctx.hasUI) {
            notify(
              ctx,
              `⏱️ Incomplete tool call continuation stopped: ${
                continuationResult.reason || "limit exceeded"
              } after ${continuationResult.attempt} attempt(s).`,
              "error"
            );
          }
        }
        return;
      }

      if (ctx.hasUI) {
        notify(
          ctx,
          `⚙️ Output cut off mid-tool-call. Requesting continuation (attempt #${continuationResult.attempt}, delay: ${formatDelay(
            continuationResult.delayMs
          )})...`,
          "info"
        );
      }

      if (activeAbortController) {
        activeAbortController.abort();
      }
      const abortController = new AbortController();
      activeAbortController = abortController;

      isExecutingContinuation = true;
      try {
        const completed = await cancellableSleep(continuationResult.delayMs, abortController.signal);
        if (!completed || abortController.signal.aborted) {
          return;
        }
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
        retryManager.decrementAttempt();
      } finally {
        if (activeAbortController === abortController) {
          isExecutingContinuation = false;
          activeAbortController = null;
        }
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
        if (retryState.lastInterruptionType === "RATE_LIMIT") {
          notify(
            ctx,
            `✅ Successfully recovered from rate limit after ${
              retryState.attempt
            } retry attempt(s) (total time: ${formatDuration(totalElapsed)}).`,
            "info"
          );
        } else {
          notify(
            ctx,
            `✅ Successfully completed response after ${
              retryState.attempt
            } continuation attempt(s) (total time: ${formatDuration(totalElapsed)}).`,
            "info"
          );
        }
      }
      retryManager.reset();
    }
  });

  // 6. Register slash command: /auto-continue
  const commandHandler = async (args: string, ctx: any) => {
    const trimmedArgs = args.trim();
    const subcommand = trimmedArgs.toLowerCase();

    // Check for "at <HH:MM>" subcommand
    if (/^at(\s+.*)?$/i.test(trimmedArgs)) {
      const timeArg = trimmedArgs.replace(/^at\s*/i, "").trim();
      if (!timeArg) {
        if (ctx.hasUI) {
          notify(
            ctx,
            "Please specify a time in HH:MM format (e.g. /auto-continue at 14:30).",
            "warning"
          );
        }
        return;
      }

      const parsed = parseTargetTime(timeArg);
      if (!parsed) {
        if (ctx.hasUI) {
          notify(
            ctx,
            `Invalid time format "${timeArg}". Please use HH:MM (e.g. /auto-continue at 14:30).`,
            "warning"
          );
        }
        return;
      }

      // Ensure auto-continue and rate-limit retries are enabled
      config.enabled = true;
      config.rateLimit.enabled = true;

      const retryResult = retryManager.scheduleRetry(config, parsed.targetTimeMs);
      executeRetry(retryResult, ctx, undefined, parsed.targetTimeMs);
      return;
    }

    if (subcommand === "status" || subcommand === "") {
      const retryState = retryManager.getState();
      const retryInfo = retryState.isRetrying
        ? `Active (attempt #${retryState.attempt}, elapsed: ${formatDuration(
            Date.now() - (retryState.startTime || Date.now())
          )}, last delay: ${formatDelay(retryState.lastDelayMs)})`
        : "Idle (no active retry loop)";

      const globalLimit = parseMaxRetries(config.maxRetries);
      const rateLimitRetries =
        config.rateLimit.maxRetries !== undefined
          ? formatMaxRetries(config.rateLimit.maxRetries)
          : `${formatMaxRetries(globalLimit)} (uses global)`;

      const rateLimitLines = [
        `  Rate Limit Settings & Status:`,
        `    Retry: ${config.rateLimit.enabled ? "enabled" : "disabled"}`,
        `    Max retries: ${rateLimitRetries}`,
        `    Jitter: ${config.rateLimit.jitter ? "enabled" : "disabled"}`,
      ];

      const expectedResetTime =
        retryState.expectedTokenResetTime || lastExpectedTokenResetTime;
      if (expectedResetTime) {
        const remaining = Math.max(0, expectedResetTime - Date.now());
        const remainingHint = remaining > 0 ? ` (in ${formatDelay(remaining)})` : " (passed)";
        rateLimitLines.push(
          `    Expected token reset time: ${formatDateTime(expectedResetTime)}${remainingHint}`
        );
      }

      const statusText =
        `Auto-Continue Status:\n` +
        `  Global:\n` +
        `    Enabled: ${config.enabled ? "yes" : "no"}\n` +
        `    Base delay / Max delay: ${formatDelay(config.baseDelayMs)} / ${formatDelay(config.maxDelayMs)}\n` +
        `    Max retries: ${formatMaxRetries(globalLimit)}\n` +
        `    Backoff multiplier: ${config.backoffMultiplier}x\n` +
        `    Current retry status: ${retryInfo}\n\n` +
        rateLimitLines.join("\n");

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
      notify(ctx, "Usage: /auto-continue [status | on | off | reset | at <HH:MM>]", "info");
    }
  };

  pi.registerCommand("auto-continue", {
    description: "Check auto-continue status or configure settings",
    handler: commandHandler,
  });
}
