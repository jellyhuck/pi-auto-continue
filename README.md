# pi-auto-continue

An extension for the [Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) that automatically resumes and retries agent sessions interrupted by:

1. **Provider Rate Limits & Quota Exhaustion**: Provider plan/quota resets, HTTP 429 errors, `RESOURCE_EXHAUSTED`, temporary capacity overloads (503/529), and requests-per-minute (RPM) / tokens-per-minute (TPM) thresholds.
2. **Output Token Limits (`max_tokens`)**: Responses cut off when hitting model context output limits (`stopReason: "length"`).
3. **Incomplete Tool Calls**: Responses truncated mid-argument serialization during tool calls.
4. **Context Overflow & Fatal Limits**: Intelligently defers context window overflow to Pi's built-in auto-compaction and alerts immediately on non-retryable billing hard limits.

---

> [!WARNING]
>
> ### ⚠️ AI Usage & Cost Considerations
>
> Automated session continuations and retries inevitably incur AI provider token usage and associated API costs:
>
> - **Output Token Continuations**: Resuming a truncated response or incomplete tool call submits a follow-up prompt alongside the conversation history, generating additional tokens.
> - **"Cold" Session Cache Misses**: Extended rate limit waits (such as waiting minutes or hours for quota reset windows) will exceed provider prompt cache TTLs (e.g., Anthropic's 5-minute ephemeral cache or OpenAI's prompt cache). When the retry fires, the full conversation context is re-evaluated as an uncached prompt, incurring full input token costs.

---

## Key Features

- **Flexible Retry Limits (Attempts or Duration)**: Retries until a configurable limit is reached. The limit can be specified as a number of attempts (e.g., `3`) or as a duration deadline (e.g., `"15m"`, `"5h"`). When a duration is configured, retrying stops once the total elapsed retry time reaches the deadline.
- **Informative UI Notifications**: Clear, real-time status notices displaying calculated backoff delays, elapsed time, observed provider errors, retry attempt counts, and remaining duration.
- **Header & Error Hint Parsing**: Automatically respects `Retry-After` HTTP headers and extracts inline delay hints from provider error messages (e.g., `try again in 25s`, `resets at 14:30`). The first retry attempt aligns with provider reset hints.
- **Exponential Backoff with Jitter**: Smooth backoff progression with random jitter (±15%) to prevent synchronized retry stampedes.
- **Slash Commands**: Interactive `/auto-continue` command with `status`, `on`, `off`, `reset`, and `at <HH:MM>` subcommands. The `at <HH:MM>` subcommand allows scheduling a retry at a specific local time (e.g., `/auto-continue at 14:30`).

---

## Installation

Repository: [https://github.com/jellyhuck/pi-auto-continue](https://github.com/jellyhuck/pi-auto-continue)

### Option 1: Direct Install via Pi (Recommended)

Install directly from GitHub using Pi's package installer:

```bash
pi install git:github.com/jellyhuck/pi-auto-continue
```

### Option 2: Project-Local Installation

Install locally for a specific repository or workspace:

```bash
pi install -l git:github.com/jellyhuck/pi-auto-continue
```

### Option 3: Development / Local Symlink

Clone the repository, inspect or build the source, and symlink:

```bash
git clone https://github.com/jellyhuck/pi-auto-continue.git
cd pi-auto-continue
npm install
npm test

# Symlink to global extensions:
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-auto-continue

# Or test directly with the -e flag:
pi -e ./index.ts
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
      "jitter": true,
      "retryPrompt": "The previous request encountered a provider rate/quota limit, which has now resolved. Please resume your task directly from where you left off. Do not apologize or discuss the delay—proceed immediately with the next step."
    },
    "tokenLimit": {
      "enabled": true,
      "continuePrompt": "Continue from where you left off without repeating any text or code already provided. Do not add conversational preamble, explanations, or filler—resume output immediately at the exact point of interruption."
    },
    "incompleteToolCall": {
      "enabled": true,
      "continuePrompt": "Your previous response was cut off while emitting a tool call, leaving arguments incomplete. Please re-issue the complete tool call with all required arguments. Do not add conversational preamble, explanations, or apologies—proceed directly with executing the tool call, or provide your final response if finished."
    }
  }
}
```

### Configuration Options

| Option                              | Type               | Default            | Description                                                                                                            |
| :---------------------------------- | :----------------- | :----------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `enabled`                           | `boolean`          | `true`             | Master switch to enable or disable the extension.                                                                      |
| `baseDelayMs`                       | `number \| string` | `5000` (`"5s"`)    | Global starting delay for exponential backoff (token continuations and tool calls).                                    |
| `maxDelayMs`                        | `number \| string` | `600000` (`"10m"`) | Global maximum delay cap for a single retry attempt.                                                                   |
| `maxRetries`                        | `number \| string` | `3`                | Maximum retries: either a numeric count of attempts (e.g., `3`) or a duration string deadline (e.g., `"15m"`, `"5h"`). |
| `backoffMultiplier`                 | `number`           | `2`                | Multiplier for exponential backoff calculations.                                                                       |
| `rateLimit.enabled`                 | `boolean`          | `true`             | Whether to automatically retry on rate limits and quota exhaustion.                                                    |
| `rateLimit.baseDelayMs`             | `number \| string` | `60000` (`"1m"`)   | Base delay for rate limit retries (default: 1 minute).                                                                 |
| `rateLimit.maxDelayMs`              | `number \| string` | `600000` (`"10m"`) | Maximum delay cap for a single rate limit retry attempt (default: 10 minutes).                                         |
| `rateLimit.maxRetries`              | `number \| string` | `"5h"`             | Maximum retries or duration deadline for rate limits (default: 5 hours, matching provider quota reset windows).        |
| `rateLimit.jitter`                  | `boolean`          | `true`             | Adds ±15% random variation to rate limit delays to avoid synchronized thundering herds.                                |
| `rateLimit.retryPrompt`             | `string`           | _(default prompt)_ | Prompt sent to LLM to resume task execution once rate limit clears.                                                    |
| `tokenLimit.enabled`                | `boolean`          | `true`             | Whether to automatically continue responses truncated by max output tokens.                                            |
| `tokenLimit.continuePrompt`         | `string`           | _(default prompt)_ | Prompt sent to LLM to resume text/code generation seamlessly without repeating prior output.                           |
| `incompleteToolCall.enabled`        | `boolean`          | `true`             | Whether to automatically continue responses cut off mid-tool-call.                                                     |
| `incompleteToolCall.continuePrompt` | `string`           | _(default prompt)_ | Prompt sent to LLM to re-issue the completed tool call with valid arguments.                                           |

---

## Slash Commands

| Command                     | Description                                                                         |
| :-------------------------- | :---------------------------------------------------------------------------------- |
| `/auto-continue status`     | Display current active status, retry state, elapsed time, and active configuration. |
| `/auto-continue at <HH:MM>` | Schedule a retry at the specified local time (e.g. `/auto-continue at 14:30`).      |
| `/auto-continue on`         | Enable auto-continue in the current session.                                        |
| `/auto-continue off`        | Disable auto-continue in the current session.                                       |
| `/auto-continue reset`      | Reset retry counters and reload settings from disk.                                 |

---

## Development & Testing

Run the native test suite:

```bash
npm test
```

Type check TypeScript sources:

```bash
npm run typecheck
```

Compile TypeScript to JavaScript:

```bash
npm run build
```

---

## Credits

- Inspired by [kasaiarashi/pi-auto-resume](https://github.com/kasaiarashi/pi-auto-resume), rewritten with duration deadlines, jittered backoff, unified retry state machines, and non-interfering extension message filtering.

## License

MIT
