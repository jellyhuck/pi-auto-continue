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
- **Slash Commands**: Interactive `/auto-continue` command with `status`, `on`, `off`, `reset`, and `at <HH:MM>` subcommands.

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

Configure `pi-auto-continue` in your `~/.pi/agent/settings.json` under the `autoContinue` key:

```json
{
  "autoContinue": {
    "enabled": true,
    "baseDelayMs": "5s",
    "maxDelayMs": "10m",
    "maxRetries": 3,
    "backoffMultiplier": 2,
    "rateLimit": {
      "enabled": true,
      "baseDelayMs": "1m",
      "maxDelayMs": "10m",
      "maxRetries": "5h",
      "jitter": true
    },
    "tokenLimit": {
      "enabled": true,
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
| `baseDelayMs` | `number \| string` | `5000` (`"5s"`) | Global starting delay for exponential backoff (token continuations and tool calls). |
| `maxDelayMs` | `number \| string` | `600000` (`"10m"`) | Global maximum delay cap for a single retry attempt. |
| `maxRetries` | `number \| string` | `3` | Maximum retries: either a number of attempts (e.g. `3`) or a duration string (e.g. `"15m"`, `"5h"`). |
| `backoffMultiplier` | `number` | `2` | Global multiplier for exponential backoff. |
| `rateLimit.enabled` | `boolean` | `true` | Whether to automatically retry on rate limits and quota exhaustion. |
| `rateLimit.baseDelayMs` | `number \| string` | `60000` (`"1m"`) | Base delay for rate limits and quota exhaustion retries (default: 1 minute). |
| `rateLimit.maxDelayMs` | `number \| string` | `600000` (`"10m"`) | Maximum delay cap for a single rate limit retry attempt (default: 10 minutes). |
| `rateLimit.maxRetries` | `number \| string` | `"5h"` | Maximum retries or duration deadline for rate limits (default: 5 hours). |
| `rateLimit.jitter` | `boolean` | `true` | Adds ±15% random variation to rate limit delays to avoid synchronized retries. |
| `tokenLimit.enabled` | `boolean` | `true` | Whether to continue responses truncated by max output tokens. |
| `tokenLimit.continuePrompt` | `string` | *(default prompt)* | Prompt sent to LLM to resume text generation. |
| `incompleteToolCall.enabled` | `boolean` | `true` | Whether to continue responses cut off mid tool call. |
| `incompleteToolCall.continuePrompt` | `string` | *(default prompt)* | Prompt sent to LLM to complete tool call. |

---

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/auto-continue status` | Display current active status, retry state, elapsed time, and configuration. |
| `/auto-continue at <HH:MM>` | Schedule a retry at the specified local time (e.g. `/auto-continue at 14:30`). |
| `/auto-continue on` | Enable auto-continue in the current session. |
| `/auto-continue off` | Disable auto-continue in the current session. |
| `/auto-continue reset` | Reset retry counters and reload settings from disk. |

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
