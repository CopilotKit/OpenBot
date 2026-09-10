import { afterEach, describe, expect, test } from "bun:test";
import {
  type ComposioActions,
  callTool,
  effectOf,
  listNeedsCredential,
  listTools,
  toolkitOf,
  useComposioClient,
  vendorSentence,
} from "../src/plugins/composio";

/**
 * The Composio transport's boundary, asserted with no network and no database.
 *
 * What is under test is the boundary rather than the SDK: which app a connection names, whose id a
 * call is attributed to, what a label means, which version is sent, and what a refusal reads as. The
 * client arrives through {@link useComposioClient}, which is the only seam the module has —
 * `transportFor` resolves a kind to a MODULE, so there is no constructor to pass one to. Same shape
 * as `builtin-routines`.
 *
 * The security property this file exists for is the attribution one: the user id comes off the
 * connection and never out of the arguments a model produced. A model that could name a user id
 * could open somebody else's mailbox.
 */

afterEach(() => useComposioClient(null));

type Recorded = { slug: string; userId: string; version: string };

/**
 * An answer in the shape `ToolExecuteResponseSchema` actually permits.
 *
 * Every stub here goes through this rather than returning a shape of its own, because the SDK's
 * schema makes `data`, `error` and `successful` all REQUIRED — so a stub that resolves `null`, or a
 * bare string, is testing a case the library cannot produce, and a test built on an impossible input
 * proves nothing about the code that reads a real one.
 */
function answered(
  data: Record<string, unknown>,
  outcome: { error?: string | null; successful?: boolean } = {},
) {
  return {
    data,
    error: outcome.error ?? null,
    successful: outcome.successful ?? true,
  };
}

function recording(answers: Partial<ComposioActions> = {}): {
  client: ComposioActions;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    client: {
      listActions: answers.listActions ?? (async () => []),
      execute:
        answers.execute ??
        (async (slug, userId, version) => {
          calls.push({ slug, userId, version });
          return answered({ ok: true });
        }),
    },
  };
}

const GMAIL_READ = {
  slug: "GMAIL_FETCH_EMAILS",
  description: "Fetch emails.",
  inputParameters: {
    type: "object",
    properties: { query: { type: "string" } },
  },
  tags: ["readOnlyHint", "important"],
  version: "20260903_00",
};

describe("which app a connection names", () => {
  test("the app slug comes off the url", () => {
    expect(toolkitOf("composio://gmail")).toBe("gmail");
    expect(toolkitOf("composio://gmail/")).toBe("gmail");
  });

  test("anything that is not a composio url names no app", () => {
    expect(toolkitOf("https://mcp.notion.com/mcp")).toBeNull();
    expect(toolkitOf("composio://")).toBeNull();
    expect(toolkitOf("")).toBeNull();
  });
});

describe("what a label means", () => {
  test("read-only is a read", () => {
    expect(effectOf(["readOnlyHint", "openWorldHint", "gmail"])).toEqual({
      effect: "read",
      destructive: false,
    });
  });

  test("destructive is a destructive write", () => {
    expect(effectOf(["destructiveHint", "important"])).toEqual({
      effect: "write",
      destructive: true,
    });
  });

  test("create and update are writes that are not destructive", () => {
    expect(effectOf(["createHint", "openWorldHint"])).toEqual({
      effect: "write",
      destructive: false,
    });
    expect(effectOf(["updateHint", "labels", "inbox"])).toEqual({
      effect: "write",
      destructive: false,
    });
  });

  test("idempotent is not a read, because deleting is idempotent", () => {
    expect(effectOf(["idempotentHint", "openWorldHint"])).toEqual({
      effect: "write",
      destructive: false,
    });
  });

  test("no label at all is a write", () => {
    // Measured across five apps and never seen, so this branch guards the future rather than the
    // present: an app that labels nothing, or a label added later, must land on write.
    expect(effectOf([])).toEqual({ effect: "write", destructive: false });
    expect(effectOf(undefined)).toEqual({
      effect: "write",
      destructive: false,
    });
    expect(effectOf(["gmail", "inbox"])).toEqual({
      effect: "write",
      destructive: false,
    });
  });

  test("destructive wins over read-only when both are present", () => {
    // Contradictory labels are somebody else's bug, and the safe reading is the strict one.
    expect(effectOf(["readOnlyHint", "destructiveHint"])).toEqual({
      effect: "write",
      destructive: true,
    });
  });
});

describe("finding the vendor's own sentence", () => {
  test("the sentence nested inside the cause is what comes out", () => {
    // The real shape, copied from a live failure. The top-level message is useless.
    const error = Object.assign(new Error("Error executing the tool X"), {
      cause: {
        status: 404,
        headers: { "x-request-id": "must-not-appear" },
        error: {
          error: {
            message:
              "No connected account found for user ID u1 for toolkit gmail",
            code: 1810,
          },
        },
      },
    });

    expect(vendorSentence(error)).toBe(
      "No connected account found for user ID u1 for toolkit gmail",
    );
  });

  test("an error with no such sentence yields nothing rather than a guess", () => {
    expect(vendorSentence(new Error("boom"))).toBeNull();
    expect(vendorSentence({ cause: { error: {} } })).toBeNull();
    expect(vendorSentence(undefined)).toBeNull();
  });
});

describe("listing an app's actions", () => {
  test("listing needs no credential", () => {
    expect(listNeedsCredential).toBe(false);
  });

  test("an action arrives with its schema, its effect and its version", async () => {
    const { client } = recording({
      listActions: async (toolkit) => {
        expect(toolkit).toBe("gmail");
        return [GMAIL_READ];
      },
    });
    useComposioClient(client);

    expect(await listTools({ url: "composio://gmail" })).toEqual([
      {
        name: "GMAIL_FETCH_EMAILS",
        description: "Fetch emails.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        effect: "read",
        destructive: false,
        version: "20260903_00",
      },
    ]);
  });

  test("an action with no schema is still listed, with an open one", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_ODD", tags: ["updateHint"], version: "20260903_00" },
        ],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });

    // Offered rather than dropped: the vendor is the right party to reject a bad argument, and a
    // silently missing action reads to an administrator as an app that does not have it.
    expect(tool?.name).toBe("GMAIL_ODD");
    expect(tool?.inputSchema).toEqual({});
    expect(tool?.effect).toBe("write");
  });

  test("listing a url that names no app is empty rather than an error", async () => {
    useComposioClient(recording().client);
    expect(await listTools({ url: "https://example.com" })).toEqual([]);
  });

  test("listing with no client installed is empty rather than a crash", async () => {
    expect(await listTools({ url: "composio://gmail" })).toEqual([]);
  });

  test("a listing the vendor's own schema rejects throws a sentence, not a Zod dump", async () => {
    const issues = [
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["slug"],
        message: "Expected string, received number",
      },
    ];
    useComposioClient(
      recording({
        listActions: async () => {
          // What `ToolSchema` throws: `message` is the issue array as JSON, which is what would land
          // in `lastError` and, before `refreshTools` existed, in a model's context.
          throw Object.assign(new Error(JSON.stringify(issues, null, 2)), {
            name: "ZodError",
            issues,
          });
        },
      }).client,
    );

    const listing = listTools({ url: "composio://gmail" });

    // Propagated rather than answered empty, because `refreshTools` records a throw in `lastError`
    // and leaves the tools it already holds alone. An empty answer would read as an app that has no
    // actions, and every grant would point at a name nothing advertises.
    await expect(listing).rejects.toThrow(/did not match/i);

    const thrown = await listing.catch((error: unknown) => error);
    expect(String((thrown as Error).message)).not.toContain("invalid_type");
    expect(String((thrown as Error).message)).toContain("gmail");
  });
});

describe("calling one action", () => {
  test("the call runs as the connection's actor, at the recorded version", async () => {
    const { client, calls } = recording();
    useComposioClient(client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { query: "is:unread", __version: "20260903_00" },
    );

    expect(calls).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_asker",
        version: "20260903_00",
      },
    ]);
    expect(result.isError).toBe(false);
  });

  test("the version is not passed on to the vendor as an argument", async () => {
    const seen: Record<string, unknown>[] = [];
    useComposioClient(
      recording({
        execute: async (_slug, _userId, _version, args) => {
          seen.push(args);
          return answered({});
        },
      }).client,
    );

    await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { query: "is:unread", __version: "20260903_00" },
    );

    expect(seen).toEqual([{ query: "is:unread" }]);
  });

  test("a call with no recorded version refuses rather than guessing one", async () => {
    const { client, calls } = recording();
    useComposioClient(client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      {},
    );

    // Composio refuses a call without a specific version and refuses "latest" too. A guessed version
    // is a call against some other revision of the action, which is worse than not calling.
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/version/i);
    expect(calls).toEqual([]);
  });

  test("an actor named in the arguments is ignored, whichever way it is spelled", async () => {
    const { client, calls } = recording();
    useComposioClient(client);

    await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      {
        userId: "user_victim",
        user_id: "user_victim",
        entityId: "user_victim",
        __version: "20260903_00",
      },
    );

    // The identity is not a field a model fills. This is the defect OpenTag got wrong three times,
    // and the only structural defence is that the argument name is never read.
    expect(calls).toEqual([
      {
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_asker",
        version: "20260903_00",
      },
    ]);
  });

  test("a call with nobody attributed refuses and reaches nothing", async () => {
    const { client, calls } = recording();
    useComposioClient(client);

    const result = await callTool(
      { url: "composio://gmail" },
      "GMAIL_FETCH_EMAILS",
      {
        __version: "20260903_00",
      },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not attributed to anybody/i);
    expect(calls).toEqual([]);
  });

  test("a thrown failure is reported with the vendor's own sentence", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          throw Object.assign(
            new Error("Error executing the tool GMAIL_FETCH_EMAILS"),
            {
              cause: {
                status: 404,
                headers: { "x-request-id": "must-not-appear" },
                error: {
                  error: {
                    message:
                      "No connected account found for user ID u1 for toolkit gmail",
                  },
                },
              },
            },
          );
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No connected account found");
    // The error also carries the whole HTTP response. None of it belongs in a model's context or an
    // audit row.
    expect(result.text).not.toContain("must-not-appear");
    expect(result.text).not.toContain("x-request-id");
  });

  test("a failure with no vendor sentence falls back to the thrown message", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          throw new Error("composio unreachable");
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("composio unreachable");
  });

  test("a result is capped visibly rather than silently", async () => {
    useComposioClient(
      recording({
        execute: async () => answered({ body: "x".repeat(60_000) }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(25_000);
  });

  test("an empty answer says so in words rather than being empty", async () => {
    useComposioClient(recording({ execute: async () => answered({}) }).client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    // An empty string in front of a model reads as "the action had nothing to say" rather than "there
    // is nothing there", and the model closes the gap from memory. Same reasoning as `resultText`.
    // `data` is a required record, so the empty answer the SDK can actually produce is `{}` — if that
    // did not count, this branch would be unreachable and its promise would be a fiction.
    expect(result.text).toMatch(/returned nothing/i);
  });

  test("an answer the vendor marked unsuccessful is a failure, not content", async () => {
    // `ToolExecuteResponseSchema` makes `successful` REQUIRED and resolves `{ data, error,
    // successful }`, so a 200 answer can carry a failure. Reported as a success it is audited as
    // `mcp.call_succeeded` and the failure is handed to the model as though it were content.
    useComposioClient(
      recording({
        execute: async () =>
          answered(
            {},
            {
              successful: false,
              error: "Gmail rejected the query: invalid search syntax.",
            },
          ),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid search syntax");
  });

  test("a successful answer hands the model the action's data and not the envelope", async () => {
    useComposioClient(
      recording({
        execute: async () => ({
          ...answered({ messages: [{ id: "m1" }] }),
          logId: "log_must_not_appear",
        }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(false);
    expect(result.text).toContain("m1");
    // `successful`, `error` and `logId` are the envelope this transport reads to decide the outcome.
    // Reporting them as content spends a model's context on our own bookkeeping.
    expect(result.text).not.toContain("log_must_not_appear");
    expect(result.text).not.toContain("successful");
  });

  test("an unsuccessful answer with no sentence still says something actionable", async () => {
    useComposioClient(
      recording({
        execute: async () => answered({}, { successful: false, error: null }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
    expect(result.text).toMatch(/Plugins page/);
  });

  test("a failure carrying only the vendor's placeholder says something actionable", async () => {
    // "Error executing the tool X" is the string this module's own comment calls useless. Echoing it
    // tells a person nothing they did not already know: they asked for that tool.
    useComposioClient(
      recording({
        execute: async () => {
          throw new Error("Error executing the tool GMAIL_FETCH_EMAILS");
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.text).not.toBe("Error executing the tool GMAIL_FETCH_EMAILS");
    expect(result.text).toMatch(/Plugins page/);
  });

  test("an enormous vendor sentence is capped in a refusal too, and says so", async () => {
    useComposioClient(
      recording({
        execute: async () =>
          answered({}, { successful: false, error: "x".repeat(60_000) }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    // A refusal goes into a model's context exactly as a result does, so an uncapped vendor sentence
    // is the same unbounded spend the success path already refuses to make.
    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(25_000);
  });

  test("an enormous thrown message is capped in a refusal too", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          throw new Error("y".repeat(60_000));
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(25_000);
  });

  test("our own serialization failure is not reported as the action having failed", async () => {
    useComposioClient(
      recording({
        execute: async () => {
          const data: Record<string, unknown> = { subject: "hello" };
          // A circular reference, which `JSON.stringify` refuses. The action already ran and the
          // vendor already answered; what fails is this deployment reading that answer.
          data.itself = data;
          return answered(data);
        },
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(true);
    // Two different events, and the audit trail has to be able to tell them apart: the vendor did
    // its part here.
    expect(result.text).toMatch(/could not turn that answer into text/i);
    expect(result.text).toContain("GMAIL_FETCH_EMAILS");
  });
});
