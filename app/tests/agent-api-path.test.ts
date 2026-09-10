import { afterEach, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import {
  AgentNotManageableError,
  type AgentProfileStore,
} from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  issueCallbackTokenMutationOptions,
  revokeCallbackTokenMutationOptions,
  setAgentHiddenMutationOptions,
  updateAgentMutationOptions,
} from "../src/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentKeys,
  agentQueryOptions,
} from "../src/lib/agents/queries";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const actor = {
  id: "synthetic-reader",
  email: "reader@example.test",
  role: "user" as const,
};
const input = {
  name: "Synthetic",
  title: "Public test",
  roleDescription: "Preserve request body",
  visibility: "private" as const,
};

function boundary(id: string, refusal?: "unauthenticated" | "forbidden") {
  const calls: { operation: string; id: string; value?: unknown }[] = [];
  const statuses: number[] = [];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const profile: AgentProfile = {
    ...input,
    id,
    avatarSeed: id,
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
  };
  const record = (operation: string, receivedId: string, value?: unknown) => {
    expect(receivedId).toBe(id);
    if (refusal === "forbidden") throw new AgentNotManageableError(receivedId);
    calls.push({
      operation,
      id: receivedId,
      ...(value === undefined ? {} : { value }),
    });
  };
  const store: AgentProfileStore = {
    async list() {
      throw new Error("unexpected list");
    },
    async get(_actor, receivedId) {
      record("get", receivedId);
      return profile;
    },
    async getWithin() {
      throw new Error("unexpected transaction");
    },
    async create() {
      throw new Error("unexpected create");
    },
    async update(_actor, receivedId, value) {
      record("update", receivedId, value);
      return { ...profile, ...value };
    },
    async duplicate(_actor, receivedId) {
      record("duplicate", receivedId);
      return { ...profile, id: "synthetic-copy" };
    },
    async setHidden(_actor, receivedId, value) {
      record("setHidden", receivedId, value);
    },
    async softDelete(_actor, receivedId) {
      record("softDelete", receivedId);
    },
    async issueCallbackToken(_actor, receivedId) {
      record("issue", receivedId);
      return "synthetic-not-a-credential";
    },
    async revokeCallbackToken(_actor, receivedId) {
      record("revoke", receivedId);
    },
    async agentForCallbackToken() {
      throw new Error("unexpected callback lookup");
    },
  };
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    if (refusal === "unauthenticated")
      return context.json({ error: "Sign in required" }, 401);
    context.set("actor", actor);
    await next();
  };
  const app = createAgentRoutes(store, auth);
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof path !== "string" || !path.startsWith("/api/agents/"))
        throw new Error("unexpected request; never forward");
      const request = new Request(`http://synthetic.invalid${path}`, init);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      expect(init?.credentials).toBe("include");
      // The production app mounts these actual handlers at /api/agents.
      const response = await app.request(
        new Request(
          `http://synthetic.invalid${path.slice("/api/agents".length)}`,
          init,
        ),
      );
      statuses.push(response.status);
      return response;
    },
    { preconnect: originalFetch.preconnect },
  );
  return { calls, requests, statuses };
}

function operations(client: QueryClient, id: string) {
  return [
    {
      method: "PATCH",
      suffix: "",
      body: input,
      run: () =>
        new MutationObserver(client, updateAgentMutationOptions(client)).mutate(
          { agentId: id, input },
        ),
    },
    {
      method: "POST",
      suffix: "/duplicate",
      body: null,
      run: () =>
        new MutationObserver(
          client,
          duplicateAgentMutationOptions(client),
        ).mutate(id),
    },
    {
      method: "POST",
      suffix: "/hide",
      body: null,
      run: () =>
        new MutationObserver(
          client,
          setAgentHiddenMutationOptions(client),
        ).mutate({ agentId: id, hidden: true }),
    },
    {
      method: "POST",
      suffix: "/unhide",
      body: null,
      run: () =>
        new MutationObserver(
          client,
          setAgentHiddenMutationOptions(client),
        ).mutate({ agentId: id, hidden: false }),
    },
    {
      method: "DELETE",
      suffix: "",
      body: null,
      run: () =>
        new MutationObserver(client, deleteAgentMutationOptions(client)).mutate(
          id,
        ),
    },
    {
      method: "POST",
      suffix: "/callback-token",
      body: null,
      run: () =>
        new MutationObserver(
          client,
          issueCallbackTokenMutationOptions(client),
        ).mutate(id),
    },
    {
      method: "DELETE",
      suffix: "/callback-token",
      body: null,
      run: () =>
        new MutationObserver(
          client,
          revokeCallbackTokenMutationOptions(client),
        ).mutate(id),
    },
  ];
}

for (const id of [
  "risk-analyst",
  "team/risk",
  "team#risk",
  "team?risk",
  "team%2Frisk",
]) {
  test(`agent API preserves the exact ID through queries and mutations: ${id}`, async () => {
    const { calls, requests } = boundary(id);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      expect((await client.fetchQuery(agentQueryOptions(id))).id).toBe(id);
      expect(client.getQueryData(agentKeys.detail(id))).toBeDefined();
      expect(
        (await client.fetchQuery(agentHandoffQueryOptions(id))).enabled,
      ).toBe(false);
      for (const operation of operations(client, id)) {
        await operation.run();
        expect(requests.at(-1)).toEqual({
          method: operation.method,
          path: `/api/agents/${encodeURIComponent(id)}${operation.suffix}`,
          body: operation.body,
        });
      }
      expect(calls.map((call) => call.id)).toEqual(Array(9).fill(id));
      expect(calls.find((call) => call.operation === "update")?.value).toEqual(
        input,
      );
    } finally {
      client.clear();
    }
  });
}

for (const refusal of ["unauthenticated", "forbidden"] as const) {
  test(`encoded agent paths preserve ${refusal} refusal`, async () => {
    const id = "team/risk#private";
    const { calls, requests, statuses } = boundary(id, refusal);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      await expect(client.fetchQuery(agentQueryOptions(id))).rejects.toThrow();
      await expect(
        client.fetchQuery(agentHandoffQueryOptions(id)),
      ).rejects.toThrow();
      for (const operation of operations(client, id))
        await expect(operation.run()).rejects.toThrow();
      expect(requests).toHaveLength(9);
      expect(calls).toHaveLength(0);
      expect(statuses).toEqual(
        Array(9).fill(refusal === "unauthenticated" ? 401 : 403),
      );
      expect(
        requests.every((request) =>
          request.path.includes(encodeURIComponent(id)),
        ),
      ).toBe(true);
      // Authentication/store refusal remains observable; no mutation side effect is recorded.
    } finally {
      client.clear();
    }
  });
}
