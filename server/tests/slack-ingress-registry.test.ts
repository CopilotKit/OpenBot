import { describe, expect, test } from "bun:test";
import type { ChannelIdentityContext } from "@copilotkit/channels";
import {
  SlackIngressRegistry,
  type Timer,
} from "../src/slack/ingress-registry";

type Scheduled = { delay: number; callback: () => void; cancelled: boolean };

function clock() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    after(delay: number, callback: () => void): Timer {
      const entry = { delay, callback, cancelled: false };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  };
}

function context(eventId = "Ev1"): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: "T1" },
    installation: { id: "I1" },
    actor: { id: "U1", kind: "human" },
    conversation: { id: "C1" },
    trigger: "message",
    event: { id: eventId },
    raw: null,
  };
}

function selector(overrides: Record<string, string | null> = {}) {
  return {
    provider: "slack",
    providerActorId: "U1",
    applicationUserId: null,
    ...overrides,
  };
}

const identityResult = {
  kind: "unlinked" as const,
  linkUrl: "https://openbot.test/link/slack?token=token",
  identity: {
    provider: "slack" as const,
    providerTenantId: "T1",
    providerUserId: "U1",
    providerEmail: null,
  },
};

describe("managed Slack ingress registry", () => {
  test("takes a remembered ingress only once", () => {
    const registry = new SlackIngressRegistry(clock());
    const ingress = { identityContext: context(), identityResult };

    registry.remember("Ev1", ingress);

    expect(registry.take("Ev1", selector())).toBe(ingress);
    expect(registry.take("Ev1", selector())).toBeNull();
  });

  test("rejects a missing or blank managed event id", () => {
    const registry = new SlackIngressRegistry(clock());
    const ingress = { identityContext: context(), identityResult };

    for (const eventId of ["", "  ", undefined]) {
      expect(() => registry.remember(eventId, ingress)).toThrow(
        "Managed Slack ingress requires an event id.",
      );
      expect(() => registry.take(eventId, selector())).toThrow(
        "Managed Slack ingress requires an event id.",
      );
    }
  });

  test("replaces an ingress by cancelling its prior expiry", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    const first = { identityContext: context(), identityResult };
    const latest = { identityContext: context("Ev1"), identityResult };

    registry.remember("Ev1", first);
    registry.remember("Ev1", latest);

    expect(timer.scheduled[0]).toMatchObject({
      delay: 30_000,
      cancelled: true,
    });
    expect(registry.take("Ev1", selector())).toBe(latest);
  });

  test("cancels expiry when an ingress is taken", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    registry.remember("Ev1", { identityContext: context(), identityResult });

    registry.take("Ev1", selector());

    expect(timer.scheduled[0]?.cancelled).toBe(true);
  });

  test("expires an untouched ingress after exactly thirty seconds", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    registry.remember("Ev1", { identityContext: context(), identityResult });

    expect(timer.scheduled[0]?.delay).toBe(30_000);
    timer.scheduled[0]?.callback();

    expect(registry.take("Ev1", selector())).toBeNull();
  });

  test("does not let a stale expiry delete a replacement", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    const first = { identityContext: context(), identityResult };
    const latest = { identityContext: context(), identityResult };
    registry.remember("Ev1", first);
    registry.remember("Ev1", latest);

    timer.scheduled[0]?.callback();

    expect(registry.take("Ev1", selector())).toBe(latest);
  });

  test("uses one trimmed event key for replacement, expiry, and take", () => {
    const timer = clock();
    const registry = new SlackIngressRegistry(timer);
    const first = { identityContext: context(), identityResult };
    const latest = { identityContext: context(), identityResult };
    registry.remember(" Ev1 ", first);
    registry.remember("Ev1", latest);

    timer.scheduled[0]?.callback();

    expect(registry.take(" Ev1 ", selector())).toBe(latest);
  });

  test("same event id cannot cross provider actor or conversation principals", () => {
    const registry = new SlackIngressRegistry(clock());
    const first = { identityContext: context(), identityResult };
    const secondContext = {
      ...context(),
      actor: { id: "U2", kind: "human" as const },
      conversation: { id: "C2" },
    };
    const second = {
      identityContext: secondContext,
      identityResult: {
        ...identityResult,
        identity: {
          ...identityResult.identity,
          providerUserId: "U2",
        },
      },
    };
    registry.remember("Ev1", first);
    registry.remember("Ev1", second);

    expect(registry.take("Ev1", selector())).toBe(first);
    expect(
      registry.take(
        "Ev1",
        selector({
          providerActorId: "U2",
        }),
      ),
    ).toBe(second);
  });

  test("same event and linked principal across conversations is ambiguous in either delivery order", () => {
    const linked = (conversationId: string) => ({
      identityContext: {
        ...context(),
        conversation: { id: conversationId },
      },
      identityResult: {
        kind: "linked" as const,
        user: { id: "u1", name: "User One" },
        actor: { id: "u1", role: "user" as const },
        identity: {
          provider: "slack" as const,
          providerTenantId: "T1",
          providerUserId: "U1",
          providerEmail: null,
        },
      },
    });
    const linkedSelector = selector({ applicationUserId: "u1" });

    for (const order of [
      [linked("C1"), linked("C2")],
      [linked("C2"), linked("C1")],
    ]) {
      const registry = new SlackIngressRegistry(clock());
      registry.remember("Ev-shared", order[0]!);
      registry.remember("Ev-shared", order[1]!);

      expect(registry.take("Ev-shared", linkedSelector)).toBeNull();
    }
  });

  test("same event and linked principal cannot overwrite a different provider thread", () => {
    const registry = new SlackIngressRegistry(clock());
    const linked = (providerThreadId: string) => ({
      identityContext: {
        ...context(),
        event: { id: "Ev-shared", threadId: providerThreadId },
      },
      identityResult: {
        kind: "linked" as const,
        user: { id: "u1", name: "User One" },
        actor: { id: "u1", role: "user" as const },
        identity: {
          provider: "slack" as const,
          providerTenantId: "T1",
          providerUserId: "U1",
          providerEmail: null,
        },
      },
    });
    registry.remember("Ev-shared", linked("provider-thread-1"));
    registry.remember("Ev-shared", linked("provider-thread-2"));

    expect(
      registry.take("Ev-shared", selector({ applicationUserId: "u1" })),
    ).toBeNull();
  });

  test("consumes a live linked interaction principal once and burns ambiguity", () => {
    const registry = new SlackIngressRegistry(clock());
    const linked = (actorId: string, conversationId: string) => ({
      identityContext: {
        ...context(),
        actor: { id: actorId, kind: "human" as const },
        conversation: { id: conversationId },
        trigger: "interaction",
      },
      identityResult: {
        kind: "linked" as const,
        user: { id: "u1", name: "User One" },
        actor: { id: "u1", role: "user" as const },
        identity: {
          provider: "slack" as const,
          providerTenantId: "T1",
          providerUserId: actorId,
          providerEmail: null,
        },
      },
    });
    const first = linked("U1", "C1");
    registry.remember("interaction-1", first);
    const interactionSelector = {
      provider: "slack" as const,
      providerActorId: "U1",
      applicationUserId: "u1",
    };

    expect(registry.takeInteraction(interactionSelector)).toBe(first);
    expect(registry.takeInteraction(interactionSelector)).toBeNull();

    registry.remember("interaction-2", linked("U1", "C1"));
    registry.remember("interaction-3", linked("U1", "C2"));
    expect(registry.takeInteraction(interactionSelector)).toBeNull();
    expect(registry.takeInteraction(interactionSelector)).toBeNull();
  });
});
