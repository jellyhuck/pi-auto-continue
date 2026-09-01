import { describe, it } from "node:test";
import assert from "node:assert/strict";
import extension from "../src/index.ts";

type EventHandler = (event: any, ctx: any) => Promise<any> | any;

class MockExtensionAPI {
  public handlers: Map<string, EventHandler[]> = new Map();
  public commands: Map<string, any> = new Map();
  public sentUserMessages: Array<{ content: any; options?: any }> = [];

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, command: any): void {
    this.commands.set(name, command);
  }

  sendUserMessage(content: any, options?: any): void {
    this.sentUserMessages.push({ content, options });
  }

  async emit(event: string, payload: any, ctx: any): Promise<any> {
    const list = this.handlers.get(event) || [];
    let lastResult: any;
    for (const h of list) {
      lastResult = await h(payload, ctx);
    }
    return lastResult;
  }
}

class MockContext {
  public notifications: Array<{ message: string; type?: string }> = [];
  public hasUI = true;
  public ui = {
    notify: (message: string, type?: string) => {
      this.notifications.push({ message, type });
    },
  };
  isIdle() {
    return true;
  }
}

describe("pi-auto-continue extension", () => {
  it("registers event listeners and slash commands", () => {
    const pi = new MockExtensionAPI();
    extension(pi as any);

    assert.ok(pi.handlers.has("session_start"));
    assert.ok(pi.handlers.has("after_provider_response"));
    assert.ok(pi.handlers.has("before_agent_start"));
    assert.ok(pi.handlers.has("message_end"));
    assert.ok(pi.handlers.has("agent_settled"));

    assert.ok(pi.commands.has("auto-continue"));
    assert.ok(pi.commands.has("auto-resume"));
  });

  it("adds guidance to system prompt in before_agent_start", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any);

    const ctx = new MockContext();
    const result = await pi.emit(
      "before_agent_start",
      { systemPrompt: "Base prompt." },
      ctx
    );

    assert.ok(result?.systemPrompt?.includes("Auto-Continue Behavior"));
    assert.ok(result?.systemPrompt?.includes("Base prompt."));
  });

  it("handles token limit truncation with auto-continuation message", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any);

    const ctx = new MockContext();

    // Trigger message_end with stopReason: length
    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: "Partially completed code..." }],
          timestamp: 1000,
        },
      },
      ctx
    );

    assert.equal(pi.sentUserMessages.length, 1);
    assert.ok(
      typeof pi.sentUserMessages[0].content === "string" &&
        pi.sentUserMessages[0].content.includes("Continue from where you left off")
    );
    assert.equal(pi.sentUserMessages[0].options?.deliverAs, "followUp");

    assert.ok(ctx.notifications.some((n) => n.message.includes("Response truncated")));
  });

  it("handles rate limit errors with warning notification and retry message", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any);

    const ctx = new MockContext();

    await pi.emit(
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Rate limit reached (429): Please try again in 0.05 seconds.",
          timestamp: 2000,
        },
      },
      ctx
    );

    assert.equal(pi.sentUserMessages.length, 1);
    assert.ok(
      typeof pi.sentUserMessages[0].content === "string" &&
        pi.sentUserMessages[0].content.includes("rate/quota limit")
    );

    // Verify informational messages in UI
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Rate limit / quota error detected") && n.type === "warning"
      )
    );
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Retrying request") && n.type === "info"
      )
    );

    // Settling after recovery triggers success notification
    await pi.emit("agent_settled", {}, ctx);
    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Successfully recovered from rate limit") && n.type === "info"
      )
    );
  });

  it("handles /auto-continue status command", async () => {
    const pi = new MockExtensionAPI();
    extension(pi as any);

    const ctx = new MockContext();
    const cmd = pi.commands.get("auto-continue");
    assert.ok(cmd);

    await cmd.handler("status", ctx);

    assert.ok(
      ctx.notifications.some(
        (n) => n.message.includes("Auto-Continue Status:") && n.message.includes("Max retry duration:")
      )
    );
  });
});
