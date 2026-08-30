import { describe, expect, test } from "bun:test";
import {
  currentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "../src/slack/execution-context";

function execution(id: string): SlackExecution {
  return {
    actor: { id, role: "user" },
    applicationUser: { id, name: id },
    provider: "slack",
    providerTenantId: "T1",
    providerConversationId: "C1",
    providerThreadId: "thread-1",
    messageText: "hello",
  };
}

describe("private Slack execution context", () => {
  test("survives await and microtask boundaries", async () => {
    const value = execution("alice");
    let current: SlackExecution | undefined;
    await runWithSlackExecution(value, async () => {
      await Promise.resolve();
      current = currentSlackExecution();
      expect(current).toMatchObject(value);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(currentSlackExecution()).toBe(current);
    });
  });

  test("isolates overlapping turns", async () => {
    let releaseAlice!: () => void;
    const aliceGate = new Promise<void>((resolve) => (releaseAlice = resolve));
    const alice = runWithSlackExecution(execution("alice"), async () => {
      await aliceGate;
      return currentSlackExecution().actor.id;
    });
    const bob = runWithSlackExecution(execution("bob"), async () => {
      await Promise.resolve();
      return currentSlackExecution().actor.id;
    });

    await expect(bob).resolves.toBe("bob");
    releaseAlice();
    await expect(alice).resolves.toBe("alice");
  });

  test("restores an outer run after a nested run", async () => {
    await runWithSlackExecution(execution("alice"), async () => {
      expect(currentSlackExecution().actor.id).toBe("alice");
      await runWithSlackExecution(execution("bob"), async () => {
        expect(currentSlackExecution().actor.id).toBe("bob");
      });
      expect(currentSlackExecution().actor.id).toBe("alice");
    });
  });

  test("protects identity fields while leaving later routing fields writable", () => {
    const value = execution("alice");
    runWithSlackExecution(value, () => {
      const current = currentSlackExecution();
      expect(Reflect.set(current, "provider", "discord")).toBe(false);
      expect(Reflect.set(current, "providerTenantId", "other-tenant")).toBe(
        false,
      );
      expect(
        Reflect.set(current, "providerConversationId", "other-conversation"),
      ).toBe(false);
      expect(Reflect.set(current, "providerThreadId", "other-thread")).toBe(
        false,
      );
      expect(Reflect.set(current, "messageText", "different message")).toBe(
        false,
      );
      expect(Reflect.set(current.actor, "id", "mallory")).toBe(false);
      expect(Reflect.set(current.applicationUser, "name", "Mallory")).toBe(
        false,
      );
      current.channelsThreadId = "channels-thread";
      current.agentId = "agent-1";

      expect(currentSlackExecution()).toMatchObject({
        provider: "slack",
        actor: { id: "alice" },
        applicationUser: { name: "alice" },
        providerTenantId: "T1",
        providerConversationId: "C1",
        providerThreadId: "thread-1",
        messageText: "hello",
        channelsThreadId: "channels-thread",
        agentId: "agent-1",
      });
    });
    expect(value.channelsThreadId).toBeUndefined();
  });

  test("requires a private context outside Slack execution", () => {
    expect(() => currentSlackExecution()).toThrow(
      "A Slack agent run requires a private execution context.",
    );
  });
});
