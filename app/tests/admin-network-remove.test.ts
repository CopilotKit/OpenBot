import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { removeNetworkPolicyMutationOptions } from "@/lib/enterprise/mutations";
import { networkPolicyPath } from "./admin-settings-api";

/*
 * Removing a network policy, through the API's `DELETE network-policies/{id}`. The policy is
 * addressed by its scope; one that is already gone (another admin removed it a moment ago) is what
 * was asked for, so it is no failure, while any other refusal still reaches the screen.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function answering(response: () => Response) {
  const asked: { path: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ path: String(input), method: init?.method ?? "GET" });
    return response();
  }) as unknown as typeof fetch;
  return asked;
}

const remove = (scopeKind: "organization" | "group", scopeId: string) =>
  removeNetworkPolicyMutationOptions(new QueryClient()).mutationFn?.(
    { scopeKind, scopeId },
    undefined as never,
  );

const problem = (status: number, code: string, detail: string) =>
  Response.json(
    { type: "about:blank", title: detail, status, detail, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );

test("a group's policy is removed at its own address, and one already gone is done", async () => {
  const asked = answering(() => new Response(null, { status: 204 }));
  await remove("group", "Field Sales (EMEA)");
  expect(asked).toEqual([
    {
      path: networkPolicyPath("group", "Field Sales (EMEA)"),
      method: "DELETE",
    },
  ]);

  answering(() =>
    problem(
      404,
      "NETWORK_POLICY_NOT_FOUND",
      "There is no such network policy.",
    ),
  );
  await remove("organization", "");
});

test("any other refusal reaches the screen with the server's sentence", async () => {
  answering(() =>
    problem(403, "PERMISSION_DENIED", "Only an admin can do this."),
  );
  await expect(remove("organization", "")).rejects.toThrow(
    "Only an admin can do this.",
  );
});
