import { afterEach, describe, expect, test } from "bun:test";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import fixture from "./fixtures/arcade-catalogue.json";

afterEach(() => useArcadeClient(null));

type Query = { toolkit: string; limit: number; offset: number };

function pagesOf(total: number) {
  return async ({ offset, limit }: { offset: number; limit: number }) => {
    const items = Array.from(
      { length: Math.max(0, Math.min(limit, total - offset)) },
      (_, i) => ({
        qualified_name: `GithubApi.Tool${offset + i}`,
        description: "",
        input: { parameters: [] },
      }),
    );
    return { items }; // NO total_count
  };
}

/** Records every query the client was sent, so assertions are on what went OUT. */
function recording(answer: (q: Query) => Promise<{ items: unknown[] }>) {
  const sent: Record<string, unknown>[] = [];
  useArcadeClient({
    listTools: async (q) => {
      sent.push({ ...q });
      return answer(q);
    },
    execute: async () => {
      throw new Error("listing must not execute anything");
    },
  });
  return sent;
}

describe("listTools scopes", () => {
  /*
   * `requirements.authorization.oauth2.scopes` is READ. `requirements.met` is NEVER read. They sit in
   * the same object and behave oppositely: `met` is a per-person claim that answers true for
   * everybody when asked without a `user_id`; `scopes` is a static property of the action.
   * Every tool below says `met: true`, and nothing about the answer may carry it.
   */
  test("reads oauth2.scopes and never requirements.met", async () => {
    const behavior = { read_only: true, destructive: false };
    recording(async () => ({
      items: [
        {
          qualified_name: "Gmail.ArchiveEmail",
          description: "Archive",
          input: { parameters: [] },
          requirements: {
            met: true,
            authorization: {
              status: "active",
              oauth2: {
                scopes: ["https://www.googleapis.com/auth/gmail.modify"],
              },
            },
          },
          metadata: { behavior },
        },
        {
          qualified_name: "Gmail.Plain",
          description: "",
          input: { parameters: [] },
          requirements: { met: true },
          metadata: { behavior },
        },
      ],
    }));
    const tools = await listTools({ url: "arcade://Mixed" });
    expect(tools[0].scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
    expect(tools[1].scopes).toEqual([]);
    expect(JSON.stringify(tools)).not.toContain('"met"');
  });
});

describe("listTools against the captured catalogue", () => {
  /*
   * The captured fixture carries TWO tools with `requirements.met: true` (Asana.AttachFileToTask and
   * Attio.RemoveFromList), so the "no met" assertion here is strictly stronger than the one the
   * hand-built tools above give it.
   */
  test("keeps scopes intact, reads an unscoped oauth2 as none, and never carries met", async () => {
    const entries = Object.values(
      (fixture as { tools: Record<string, unknown> }).tools,
    );
    recording(async () => ({ items: entries }));
    const tools = await listTools({ url: "arcade://Captured" });
    const byName = (n: string) => tools.find((t) => t.name === n);

    expect(byName("Attio.RemoveFromList")?.scopes).toEqual([
      "call_recording:read",
      "list_configuration:read-write",
      "list_entry:read-write",
      "meeting:read",
      "note:read-write",
      "object_configuration:read-write",
      "record_permission:read-write",
      "task:read-write",
      "user_management:read",
    ]);
    expect(byName("AirtableApi.ListBases")?.scopes).toEqual([]);
    expect(JSON.stringify(tools)).not.toContain('"met"');
  });
});

describe("listTools pagination", () => {
  test("stops on a short page, with no total_count", async () => {
    const sent = recording(async (q) => pagesOf(250)(q));
    const tools = await listTools({ url: "arcade://GithubApi" });
    expect(tools).toHaveLength(250);
    expect(new Set(tools.map((t) => t.name)).size).toBe(250);
    expect(sent.map((q) => q.offset)).toEqual([0, 100, 200]);
  });
});

describe("listTools identity", () => {
  test("no request carried a user_id", async () => {
    const sent = recording(async (q) => pagesOf(250)(q));
    await listTools({ url: "arcade://GithubApi" });
    expect(sent.length).toBeGreaterThan(0);
    for (const q of sent) {
      expect("user_id" in q).toBe(false);
      expect(q.toolkit).toBe("GithubApi");
    }
  });
});

describe("listTools runaway guard", () => {
  test("a vendor that ignores offset and always returns full pages throws", async () => {
    recording(async () => pagesOf(100)({ offset: 0, limit: 100 }));
    await expect(listTools({ url: "arcade://Runaway" })).rejects.toThrow(
      /never ended/,
    );
  });
});
