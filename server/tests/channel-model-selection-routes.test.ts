import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ModelSelectionError } from "../src/agents/model-selection";
import type { AppVariables } from "../src/auth/guards";
import {
  type ChannelModelStore,
  createChannelModelRoutes,
} from "../src/channels/model-selection";

const dto = {
  selectable: true,
  provider: "openai" as const,
  defaultModel: "gpt-5.5",
  selectedModel: null,
  options: [],
  selectionUnavailable: false,
};
function app(overrides: Partial<ChannelModelStore> = {}) {
  const store: ChannelModelStore = {
    readOptions: async () => dto,
    read: async () => dto,
    write: async (_actor, _channel, _agent, model) => ({
      ...dto,
      selectedModel: model,
    }),
    readForRun: async () => ({ provider: "openai", defaultModel: "gpt-5.5" }),
    ...overrides,
  };
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/channels",
    createChannelModelRoutes(store, async (c, next) => {
      c.set("actor", {
        id: "verified",
        role: "user",
        email: "verified@test.invalid",
      });
      await next();
    }),
  );
}
const path = "/api/channels/channel/agents/bot/model";
test("authenticated read and reset use the verified actor", async () => {
  const server = app({
    write: async (actor, channel, agent, model) => {
      expect(actor.id).toBe("verified");
      expect([channel, agent, model]).toEqual(["channel", "bot", null]);
      return dto;
    },
  });
  expect((await server.request(path)).status).toBe(200);
  expect(
    (
      await server.request(path, {
        method: "PUT",
        body: JSON.stringify({ model: null }),
      })
    ).status,
  ).toBe(200);
});
test("strict input rejects provider, credential and actor injection", async () => {
  for (const body of [
    { model: "gpt-5.5", provider: "anthropic" },
    { model: "gpt-5.5", apiKey: "secret" },
    { model: "gpt-5.5", userId: "other" },
    { model: "" },
    {},
  ]) {
    expect(
      (await app().request(path, { method: "PUT", body: JSON.stringify(body) }))
        .status,
    ).toBe(400);
  }
});
test("returns authorization, eligibility and policy refusals; hides storage errors", async () => {
  for (const status of [400, 403, 404, 409, 503] as const) {
    expect(
      (
        await app({
          read: async () => {
            throw new ModelSelectionError("Unavailable", status);
          },
        }).request(path)
      ).status,
    ).toBe(status);
  }
  const result = await app({
    read: async () => {
      throw new Error("private db credential");
    },
  }).request(path);
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain("credential");
});

test("pre-conversation options use the authenticated actor", async () => {
  const response = await app({
    readOptions: async (actor, agent) => {
      expect(actor.id).toBe("verified");
      expect(agent).toBe("bot");
      return dto;
    },
  }).request("/api/channels/model-options/bot");
  expect(response.status).toBe(200);
});
