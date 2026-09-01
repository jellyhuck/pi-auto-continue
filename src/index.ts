import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyInterruption } from "./classifier.ts";
import { loadConfig } from "./config.ts";
import { formatDelay, formatDuration, truncateErrorMessage } from "./formatter.ts";
import { RetryManager } from "./retry-manager.ts";
import type { AutoContinueConfig } from "./types.ts";

/**
 * Utility helper to pause execution for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  let config: AutoContinueConfig = loadConfig();
  const retryManager = new RetryManager();
  let continuationCount = 0;
  let lastProcessedMessageTimestamp: number | null = null;
  let lastHttpResponse: { status: number; headers: Record<string, string>; time: number } | null = null;
  let isExecutingContinuation = false;

  const resetTurnState = () => {
    continuationCount = 0;
    lastProcessedMessageTimestamp = null;
    lastHttpResponse = null;
  };

  // 1. Session start: reload config and reset all state
  pi.on("session_start", async (_event, _ctx) => {
    config = loadConfig();
    retryManager.reset();
    resetTurnState();
    isExecutingContinuation = false;
  });

  // 2. Capture HTTP responses (e.g. 429 with retry-after headers)
  pi.on("after_provider_response", async (event, _ctx) => {
    lastHttpResponse = {
      status: event.status,
      headers: event.headers,
      time: Date.now(),
    };
  });

  // 3. Reset turn-level continuation counter on fresh user input
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!isExecutingContinuation) {
      continuationCount = 0;
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
      const retryResult = retryManager.evaluateRetry(
        config,
        classification.errorMessage || classification.reason,
        classification.retryAfterMs
      );

      if (!retryResult.canRetry) {
        if (retryResult.deadlineExceeded) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `[auto-continue] ⏱️ Rate limit retry stopped: maximum retry duration of ${formatDuration(
                config.rateLimit.maxRetryDurationMs
              )} exceeded after ${retryResult.attempt} attempt(s).\nObserved error: "${truncateErrorMessage(
                classification.errorMessage
              )}"`,
              "error"
            );
          }
        } else if (retryResult.reason) {
          if (ctx.hasUI) {
            ctx.ui.notify(`[auto-continue] Rate limit retry stopped: ${retryResult.reason}`, "warning");
          }
        }
        retryManager.reset();
        return;
      }

      if (ctx.hasUI) {
        const errorSummary = truncateErrorMessage(classification.errorMessage);
        ctx.ui.notify(
          `[auto-continue] ⚠️ Rate limit / quota error detected: "${errorSummary}"\n` +
            `Waiting ${formatDelay(retryResult.delayMs)} before retry (attempt #${
              retryResult.attempt
            }, elapsed: ${formatDuration(retryResult.elapsedMs)} / max: ${formatDuration(
              config.rateLimit.maxRetryDurationMs
            )})...`,
          "warning"
        );
      }

      // Asynchronously wait for backoff or retry-after delay
      isExecutingContinuation = true;
      try {
        await sleep(retryResult.delayMs);

        if (ctx.hasUI) {
          ctx.ui.notify(
            `[auto-continue] 🔄 Retrying request (attempt #${retryResult.attempt}, elapsed: ${formatDuration(
              Date.now() - (retryManager.getState().startTime || Date.now())
            )})...`,
            "info"
          );
        }

        pi.sendUserMessage(
          "The previous request encountered a rate/quota limit. Please continue with your task.",
          { deliverAs: "followUp", streamingBehavior: "followUp" } as any
        );
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[auto-continue] Failed to send retry prompt: ${err instanceof Error ? err.message : String(err)}`,
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

      if (continuationCount >= config.tokenLimit.maxContinuations) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[auto-continue] Token limit cutoff: maximum continuations (${config.tokenLimit.maxContinuations}) reached for this turn. Stopping.`,
            "warning"
          );
        }
        return;
      }

      continuationCount++;

      if (ctx.hasUI) {
        ctx.ui.notify(
          `[auto-continue] ✂️ Response truncated (max tokens reached). Continuing (${continuationCount}/${config.tokenLimit.maxContinuations})...`,
          "info"
        );
      }

      isExecutingContinuation = true;
      try {
        await sleep(config.tokenLimit.delayMs);
        pi.sendUserMessage(config.tokenLimit.continuePrompt, {
          deliverAs: "followUp",
          streamingBehavior: "followUp",
        } as any);
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[auto-continue] Auto-continue failed: ${err instanceof Error ? err.message : String(err)}`,
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

      if (continuationCount >= config.tokenLimit.maxContinuations) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[auto-continue] Incomplete tool call: maximum continuations (${config.tokenLimit.maxContinuations}) reached. Stopping.`,
            "warning"
          );
        }
        return;
      }

      continuationCount++;

      if (ctx.hasUI) {
        ctx.ui.notify(
          `[auto-continue] ⚙️ Output cut off mid-tool-call. Requesting continuation (${continuationCount}/${config.tokenLimit.maxContinuations})...`,
          "info"
        );
      }

      isExecutingContinuation = true;
      try {
        await sleep(config.tokenLimit.delayMs);
        pi.sendUserMessage(config.incompleteToolCall.continuePrompt, {
          deliverAs: "followUp",
          streamingBehavior: "followUp",
        } as any);
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `[auto-continue] Auto-continue failed: ${err instanceof Error ? err.message : String(err)}`,
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
        ctx.ui.notify(
          `[auto-continue] ℹ️ Context overflow detected. Deferring to Pi's built-in auto-compaction.`,
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
        ctx.ui.notify(
          `[auto-continue] 🛑 Non-retryable error detected: "${truncateErrorMessage(
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
        ctx.ui.notify(
          `[auto-continue] ✅ Successfully recovered from rate limit after ${
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

      const statusText =
        `Auto-Continue Status:\n` +
        `  Enabled: ${config.enabled ? "yes" : "no"}\n` +
        `  Rate limit retry: ${config.rateLimit.enabled ? "enabled" : "disabled"}\n` +
        `  Max retry duration: ${formatDuration(config.rateLimit.maxRetryDurationMs)} (${config.rateLimit.maxRetryDurationMs} ms)\n` +
        `  Base delay / Max delay: ${formatDelay(config.rateLimit.baseDelayMs)} / ${formatDelay(config.rateLimit.maxDelayMs)}\n` +
        `  Current retry status: ${retryInfo}\n` +
        `  Token limit continuations: ${continuationCount}/${config.tokenLimit.maxContinuations} (enabled: ${config.tokenLimit.enabled ? "yes" : "no"})\n` +
        `  Incomplete tool call handling: ${config.incompleteToolCall.enabled ? "enabled" : "disabled"}`;

      if (ctx.hasUI) {
        ctx.ui.notify(statusText, "info");
      }
      return;
    }

    if (subcommand === "on" || subcommand === "enable") {
      config.enabled = true;
      if (ctx.hasUI) {
        ctx.ui.notify("[auto-continue] Auto-continue enabled", "info");
      }
      return;
    }

    if (subcommand === "off" || subcommand === "disable") {
      config.enabled = false;
      retryManager.reset();
      if (ctx.hasUI) {
        ctx.ui.notify("[auto-continue] Auto-continue disabled", "info");
      }
      return;
    }

    if (subcommand === "reset") {
      retryManager.reset();
      resetTurnState();
      config = loadConfig();
      if (ctx.hasUI) {
        ctx.ui.notify("[auto-continue] Counters and retry state reset to defaults", "info");
      }
      return;
    }

    if (ctx.hasUI) {
      ctx.ui.notify("Usage: /auto-continue [status | on | off | reset]", "info");
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
