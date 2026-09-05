import { expect, test } from "bun:test";
import * as delivery from "../src/agents/handoff-delivery";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";

const actor: AgentActor = { id: "member", role: "admin" };
const profile: AgentProfile = {
  id: "collector",
  name: "Collector",
  title: "",
  roleDescription: "",
  avatarSeed: "collector",
  visibility: "private",
  ownerUserId: null,
  systemOwned: true,
  hidden: false,
  deletedAt: null,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  computerAccess: "enabled",
};

test.each([
  "enabled",
  "disabled",
  "remote",
  "missing-actor",
  "missing-profile",
])("interactive handoff resolution: %s", async (mode) => {
  const create = delivery.createInteractiveHandoffResolver;
  expect(create).toBeFunction();
  let directCalls = 0;
  const resolve = create({
    actorFor: async () => (mode === "missing-actor" ? null : actor),
    profiles: {
      get: async (who, id) => {
        expect(who).toEqual(actor);
        expect(id).toBe("collector");
        return mode === "missing-profile"
          ? null
          : {
              ...profile,
              computerAccess: mode === "disabled" ? "disabled" : "enabled",
              endpoint: mode === "remote" ? "https://agent.example" : null,
            };
      },
    },
    channels: {
      direct: async (who, id) => {
        directCalls++;
        expect(who).toEqual(actor);
        return {
          id: "channel",
          name: "Collector",
          agentIds: [id],
          threadId: "thread",
          active: true,
        };
      },
    },
  });
  const result = resolve({ actorId: actor.id, botId: "collector" });
  if (mode.startsWith("missing")) {
    await expect(result).rejects.toThrow("could not be confirmed");
  } else {
    expect(await result).toEqual(
      mode === "enabled" ? { channelId: "channel", threadId: "thread" } : null,
    );
  }
  expect(directCalls).toBe(mode === "enabled" ? 1 : 0);
});
