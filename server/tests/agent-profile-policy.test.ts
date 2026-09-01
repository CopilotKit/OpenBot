import { describe, expect, test } from "bun:test";
import {
  canAccessAgent,
  canCustomizeAgentAvatar,
  canManageAgent,
  canRunAgent,
} from "../src/agents/profile-policy";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";

const creator: AgentActor = { id: "user-1", role: "user" };
const otherUser: AgentActor = { id: "user-2", role: "user" };
const admin: AgentActor = { id: "admin-1", role: "admin" };

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Researcher",
    title: "Research Assistant",
    roleDescription: "Finds and summarizes information.",
    avatarSeed: "researcher",
    hasCustomAvatar: false,
    avatarUpdatedAt: new Date(0),
    visibility: "private",
    ownerUserId: creator.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("agent profile permissions", () => {
  test("allows every actor to access and run an active public profile", () => {
    const agent = profile({ visibility: "public", hidden: true });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(true);
      expect(canRunAgent(actor, agent)).toBe(true);
    }
  });

  test("limits active private profile access and runs to its creator and admins", () => {
    const agent = profile({ visibility: "private" });

    expect(canAccessAgent(creator, agent)).toBe(true);
    expect(canAccessAgent(otherUser, agent)).toBe(false);
    expect(canAccessAgent(admin, agent)).toBe(true);
    expect(canRunAgent(creator, agent)).toBe(true);
    expect(canRunAgent(otherUser, agent)).toBe(false);
    expect(canRunAgent(admin, agent)).toBe(true);
  });

  test("allows only the creator and admins to manage active user profiles", () => {
    for (const visibility of ["public", "private"] as const) {
      const agent = profile({ visibility });

      expect(canManageAgent(creator, agent)).toBe(true);
      expect(canManageAgent(otherUser, agent)).toBe(false);
      expect(canManageAgent(admin, agent)).toBe(true);
    }
  });

  test("allows all actors to access and run a system public profile but nobody to manage it", () => {
    const agent = profile({
      visibility: "public",
      ownerUserId: null,
      systemOwned: true,
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(true);
      expect(canRunAgent(actor, agent)).toBe(true);
      expect(canManageAgent(actor, agent)).toBe(false);
    }
    expect(canCustomizeAgentAvatar(admin, agent)).toBe(true);
    expect(canCustomizeAgentAvatar(creator, agent)).toBe(false);
  });

  test("lets an owner or administrator customize a user-owned avatar", () => {
    const agent = profile();

    expect(canCustomizeAgentAvatar(creator, agent)).toBe(true);
    expect(canCustomizeAgentAvatar(otherUser, agent)).toBe(false);
    expect(canCustomizeAgentAvatar(admin, agent)).toBe(true);
  });

  test("denies every permission for deleted profiles", () => {
    const agent = profile({
      visibility: "public",
      deletedAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(false);
      expect(canManageAgent(actor, agent)).toBe(false);
      expect(canRunAgent(actor, agent)).toBe(false);
    }
  });

  test("exports canRunAgent as the canAccessAgent alias", () => {
    expect(canRunAgent).toBe(canAccessAgent);
  });
});
