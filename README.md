# pi-auto-continue

An extension for the [Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) that automatically resumes and retries agent sessions interrupted by:

1. **Provider Rate Limits & Quota Exhaustion**: HTTP 429 errors, `RESOURCE_EXHAUSTED`, temporary capacity overload (503/529), requests-per-minute (RPM) / tokens-per-minute (TPM) limits, and provider quota resets.
2. **Output Token Limits (max_tokens)**: Responses cut off due to hitting model context output limits (`stopReason: "length"`).
3. **Incomplete Tool Calls**: Responses truncated mid-argument emission during tool calling.
4. **Context Overflow & Fatal Limits**: Intelligently defers context window overflow to Pi's built-in auto-compaction and alerts on non-retryable billing hard limits.

---

## Key Features

- **Duration-Based Retry Deadline (`maxRetryDurationMs`)**: Instead of counting fixed attempts, retrying continues with backoff until a configurable deadline (default: **5 hours**, matching standard AI quota reset cycles).
- **Informative UI Notifications**: Clear, real-time status notices displaying calculated delays, elapsed time, observed provider errors, retry attempt counts, and remaining duration.
- **Header & Error Hint Parsing**: Automatically honors `Retry-After` headers and extracts inline delay hints from error messages (e.g. `try again in 25s`).
- **Exponential Backoff with Jitter**: Smooth backoff progression with random jitter to prevent thundering herd retries.
- **Slash Commands**: Interactive `/auto-continue` (and `/auto-resume`) command with `status`, `on`, `off`, and `reset` subcommands.

---

## Installation

### Option 1: Global Installation
Copy or symlink `pi-auto-continue` into your global Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-auto-continue
```

### Option 2: Project-Local Installation
Place in your project's `.pi/extensions/` directory:

```bash
mkdir -p .pi/extensions/
cp -r /path/to/pi-auto-continue .pi/extensions/
```

### Option 3: Command-Line Flag
Pass directly when starting Pi:

```bash
pi -e /path/to/pi-auto-continue/index.ts
```

---

## Configuration

Configure `pi-auto-continue` in your `~/.pi/agent/settings.json` under the `autoContinue` key (or `autoResume` for backwards compatibility):

```json
{
  "autoContinue": {
    "enabled": true,
    "rateLimit": {
      "enabled": true,
      "maxRetryDurationMs": "5h",
      "baseDelayMs": "5s",
      "maxDelayMs": "1m",
      "backoffMultiplier": 2,
      "jitter": true
    },
    "tokenLimit": {
      "enabled": true,
      "maxContinuations": 5,
      "delayMs": 1000,
      "continuePrompt": "Continue from where you left off. Do not repeat what you've already written. Pick up exactly where the previous response was cut off."
    },
    "incompleteToolCall": {
      "enabled": true,
      "continuePrompt": "Your previous response was cut off mid-tool-call. Please complete the tool call you were making, or if you were finished with tool calls, provide your final response."
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | Master switch to enable or disable the extension. |
| `rateLimit.enabled` | `boolean` | `true` | Whether to automatically retry on rate limits and quota exhaustion. |
| `rateLimit.maxRetryDurationMs` | `number \| string` | `18000000` (`"5h"`) | Maximum duration to keep retrying after the first rate limit failure before giving up. |
| `rateLimit.baseDelayMs` | `number \| string` | `5000` (`"5s"`) | Starting delay for exponential backoff. |
| `rateLimit.maxDelayMs` | `number \| string` | `60000` (`"1m"`) | Maximum delay cap for a single retry attempt. |
| `rateLimit.backoffMultiplier` | `number` | `2` | Multiplier for exponential backoff. |
| `rateLimit.jitter` | `boolean` | `true` | Adds ±15% random variation to delays to avoid synchronized retries. |
| `tokenLimit.enabled` | `boolean` | `true` | Whether to continue responses truncated by max output tokens. |
| `tokenLimit.maxContinuations` | `number` | `5` | Maximum consecutive continuations in a single turn. |
| `tokenLimit.delayMs` | `number \| string` | `1000` (`"1s"`) | Delay before sending continuation prompt. |
| `tokenLimit.continuePrompt` | `string` | *(default prompt)* | Prompt sent to LLM to resume text generation. |
| `incompleteToolCall.enabled` | `boolean` | `true` | Whether to continue responses cut off mid tool call. |
| `incompleteToolCall.continuePrompt` | `string` | *(default prompt)* | Prompt sent to LLM to complete tool call. |

---

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/auto-continue status` | Display current active status, retry state, elapsed time, and configuration. |
| `/auto-continue on` | Enable auto-continue in the current session. |
| `/auto-continue off` | Disable auto-continue in the current session. |
| `/auto-continue reset` | Reset retry counters and reload settings from disk. |

*(Note: `/auto-resume` is also supported as an alias)*

---

## Development & Testing

Run unit tests:

```bash
npm test
```

Type check with TypeScript:

```bash
npx tsc --noEmit
```

---

## License

MIT
