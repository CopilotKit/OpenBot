import { afterEach, describe, expect, test } from "bun:test";
import {
  type ComposioAction,
  type ComposioActions,
  type ComposioResult,
  callTool,
  effectOf,
  LISTING_LIMIT,
  listNeedsCredential,
  listTools,
  toolkitOf,
  useComposioClient,
  vendorSentence,
} from "../src/plugins/composio";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";

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

type Recorded = {
  toolkit: string;
  slug: string;
  userId: string;
  version: string;
};

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

/**
 * The two numbers this file reasons about, WRITTEN OUT rather than imported.
 *
 * AN ASSERTION THAT IMPORTS THE CONSTANT IT IS ABOUT CANNOT FAIL WHEN THAT CONSTANT MOVES, because
 * both sides move together. The previous version of this file replaced a loose bound with an
 * equality against `MAX_RESULT_CHARS` itself and called the number pinned; it was not. Applied to
 * the modules, `MAX_RESULT_CHARS` 20,000 → 40,000 and `LISTING_LIMIT` 1000 → 20 both left all 44
 * tests passing: the cap tests measured the answer against whatever the cap had just become, and
 * the listing test asked for whatever page the module had just decided to ask for.
 *
 * So the literals live here, and one test below is the only place the imported constants are read.
 * Changing either constant now reddens exactly that test, which is where the argument for the
 * number belongs: 20,000 is how much of a model's context one tool result may spend, and 1000 is
 * the vendor's stated page ceiling and therefore the whole listing.
 */
const RESULT_CAP = 20_000;
const WHOLE_LISTING = 1000;
const TRUNCATION_MARKER = "\n\n[truncated]";
const CAPPED_LENGTH = RESULT_CAP + TRUNCATION_MARKER.length;

/** The nesting `vendorSentence` reaches through, with whatever the vendor left at the bottom of it. */
function nested(message: unknown): unknown {
  return { cause: { error: { error: { message } } } };
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
        (async (call) => {
          calls.push({ ...call });
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

/** A parameter that stages a file, in the shape `JSONSchemaPropertySchema` keeps it. */
const FILE_PROPERTY = { type: "string", file_uploadable: true };

/**
 * One subschema keyword carrying `sub`, hung off a property so the root stays a `ParametersSchema`.
 *
 * A COMPUTED KEY, for `then` and for nothing else: biome refuses a literal `then` key on an object
 * literal, and the conditional trio has to be reachable here or the branch that walks it is being
 * asserted by nothing. `if`, `then`, `else`, `items` and `$ref` live on `JSONSchemaPropertySchema`
 * and not on the parameters root (`@composio/core` 0.18.1, `src/types/tool.types.ts:77-131` against
 * `:134-175`), so a case for one of them has to nest to be a shape the vendor could send.
 */
function underProperty(keyword: string, sub: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: { field: { type: "object", [keyword]: sub } },
  };
}

/** One action whose whole schema is the case under test, listed beside a plain one. */
function listing(inputParameters: Record<string, unknown>) {
  return recording({
    listActions: async () => [
      GMAIL_READ,
      { slug: "GMAIL_STAGES_A_FILE", version: "20260903_00", inputParameters },
    ],
  }).client;
}

describe("the numbers these assertions are about", () => {
  test("the modules hold the numbers this file has written out", () => {
    // The only reads of the imported constants in this file. Every other assertion measures
    // against the literals above, so a constant that moves reddens this one test — which states
    // the number — instead of quietly redefining what all the others are checking.
    expect(MAX_RESULT_CHARS).toBe(RESULT_CAP);
    expect(LISTING_LIMIT).toBe(WHOLE_LISTING);
  });
});

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

  test("anything past the app slug means the url does not name one app", () => {
    // This answer is the app a person's connection is checked against — `accessFor` puts it on
    // `ServerAccess.toolkit` (`access.ts:133`) and the brokered gate looks `composio_connections`
    // up by it. A url this function reads loosely is a check performed against the wrong app, so
    // anything it cannot read as exactly one slug has to be no app rather than a best guess.
    expect(toolkitOf("composio://gmail/messages")).toBeNull();
    expect(toolkitOf("composio://gmail?scope=read")).toBeNull();
    expect(toolkitOf("composio://gmail#inbox")).toBeNull();
    expect(toolkitOf("composio://gmail slack")).toBeNull();
  });

  test("surrounding space is taken off before the trailing slash, not after", () => {
    // The strip ran first and the trim second, so a slash that was not the last character survived
    // it: `composio://gmail/ ` answered `"gmail/"`, which matches no row in `composio_connections`
    // and is not the app anybody meant.
    expect(toolkitOf("composio://gmail/ ")).toBe("gmail");
    expect(toolkitOf("composio://gmail  ")).toBe("gmail");
    expect(toolkitOf("composio://google_drive//")).toBe("google_drive");
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

  test("a sentence made only of whitespace is not a sentence", () => {
    // The `.trim()` on the return had nothing asserting it. A blank message that counted as a
    // sentence is worse than none: `callTool` and `listingSentence` both prefer it over their
    // fallbacks, so the reader gets an empty refusal instead of the one line naming what to do.
    expect(vendorSentence(nested(""))).toBeNull();
    expect(vendorSentence(nested("   "))).toBeNull();
    expect(vendorSentence(nested("\n\t "))).toBeNull();
  });

  test("the sentence comes back as it was measured, without its padding", () => {
    // The guard trimmed and the return did not, so the one thing the function had already decided
    // about the string was thrown away again. What comes out is a refusal in a model's context and
    // a sentence in an audit row; leading newlines in both are this module's own untidiness, and
    // the cap that measures the string measures the padding with it.
    expect(vendorSentence(nested("  Gmail rejected the query.\n"))).toBe(
      "Gmail rejected the query.",
    );
  });

  test("a message that is not a string is not read as one", () => {
    // Nothing asserted the type guard either. Composio's payloads are somebody else's JSON, so the
    // field can be a number, an object or null; handed on unchecked, each of those reaches a model's
    // context and an audit row as `[object Object]` or `1810`.
    expect(vendorSentence(nested(1810))).toBeNull();
    expect(vendorSentence(nested(null))).toBeNull();
    expect(vendorSentence(nested({ text: "a nested sentence" }))).toBeNull();
    expect(vendorSentence(nested(["a sentence in a list"]))).toBeNull();
  });
});

describe("listing an app's actions", () => {
  test("listing needs no credential", () => {
    expect(listNeedsCredential).toBe(false);
  });

  test("the listing asks for a page, and for one big enough to be the whole list", async () => {
    const asked: unknown[] = [];
    useComposioClient(
      recording({
        listActions: async (toolkit, page) => {
          asked.push({ toolkit, page });
          return [GMAIL_READ];
        },
      }).client,
    );

    await listTools({ url: "composio://gmail" });

    // Composio's default page is 20 and Gmail publishes 63 actions, so an omitted limit truncates.
    // It also NARROWS: `getRawComposioTools` auto-applies `important=true` when no limit, no tags
    // and no search were given (`@composio/core` 0.18.1, `src/models/Tools.ts:505-515`), and
    // nothing in the short answer says a filter was applied. Asking for a page is therefore not an
    // optimisation, and the seam must not let a caller forget to.
    expect(asked).toEqual([
      { toolkit: "gmail", page: { limit: WHOLE_LISTING } },
    ]);
  });

  test("a listing that filled the biggest page the SDK can ask for is not called complete", async () => {
    useComposioClient(
      recording({
        listActions: async () =>
          Array.from({ length: WHOLE_LISTING }, (_unused, index) => ({
            ...GMAIL_READ,
            slug: `GMAIL_ACTION_${index}`,
          })),
      }).client,
    );

    // `ToolListParamsSchema` accepts no cursor and `getRawComposioTools` drops the response's
    // `next_cursor`, so one page at the API's stated maximum is the largest listing expressible
    // through this SDK. A page that came back full is therefore indistinguishable from a truncated
    // one, and committing it would delete every action past the cut while reporting a success.
    await expect(listTools({ url: "composio://gmail" })).rejects.toThrow(
      /there may be more/i,
    );
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

  test("an action that stages a file is not offered at all", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          GMAIL_READ,
          {
            slug: "GMAIL_SEND_EMAIL",
            description: "Send an email.",
            tags: ["createHint"],
            version: "20260903_00",
            inputParameters: {
              type: "object",
              properties: {
                recipient: { type: "string" },
                // What the SDK hands on under its default file handling: the vendor's own staging
                // descriptor, untouched. `dangerouslyAllowAutoUploadDownloadFiles` is off unless a
                // client asks for it (`src/models/Tools.ts:136`, `:242-248`), and only that flag
                // collapses the shape. An `s3key` is issued by an upload nothing here performs.
                attachment: {
                  type: "object",
                  file_uploadable: true,
                  properties: {
                    name: { type: "string" },
                    mimetype: { type: "string" },
                    s3key: { type: "string" },
                  },
                },
              },
              required: ["recipient", "attachment"],
            },
          },
        ],
      }).client,
    );

    const listed = await listTools({ url: "composio://gmail" });

    // Dropped rather than offered with a field the model can only invent. Offering it guarantees a
    // hallucinated key and a rejection at the vendor's staging lookup, and a grant recorded against
    // a name that can never work.
    expect(listed.map((tool) => tool.name)).toEqual(["GMAIL_FETCH_EMAILS"]);
  });

  test("a file parameter reached through $defs and a variant is found too", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          GMAIL_READ,
          {
            slug: "GMAIL_GET_ATTACHMENT",
            version: "20260903_00",
            inputParameters: {
              type: "object",
              properties: { body: { $ref: "#/$defs/upload" } },
              $defs: {
                upload: {
                  anyOf: [
                    { type: "null" },
                    { type: "string", file_uploadable: true },
                  ],
                },
              },
            },
          },
        ],
      }).client,
    );

    // Composio toolkits routinely express the flag through a `$ref`/`$defs` indirection, which is
    // why the SDK's own predicate walks `$defs` and every composed variant
    // (`src/utils/modifiers/FileToolModifier.utils.neutral.ts:77-134`). A walk that stopped at
    // `properties` would answer false for every ref-based schema and offer it anyway.
    const listed = await listTools({ url: "composio://gmail" });
    expect(listed.map((tool) => tool.name)).toEqual(["GMAIL_FETCH_EMAILS"]);
  });

  test("a file parameter is found down every subschema keyword the SDK keeps", async () => {
    /*
     * ONE CASE PER KEYWORD, because a keyword the walk does not descend is an action offered to a
     * model under BOTH auto-upload settings — the parameter is either a bucket key nobody here can
     * issue or a server-side path nobody should promise — so every call against it fails.
     *
     * `additionalProperties` is the one that was missing, and it is not exotic: both
     * `ParametersSchema` and `JSONSchemaPropertySchema` keep it as a full subschema
     * (`@composio/core` 0.18.1, `src/types/tool.types.ts:154` and `:111`), which is precisely how a
     * toolkit spells "a bag of attachments". The rest were already walked and asserted by nothing.
     */
    const hidden: { where: string; schema: Record<string, unknown> }[] = [
      {
        where: "additionalProperties at the root",
        schema: { type: "object", additionalProperties: FILE_PROPERTY },
      },
      {
        where: "additionalProperties under a property",
        schema: underProperty("additionalProperties", FILE_PROPERTY),
      },
      {
        where: "patternProperties at the root",
        schema: {
          type: "object",
          patternProperties: { "^attachment_": FILE_PROPERTY },
        },
      },
      {
        where: "patternProperties under a property",
        schema: underProperty("patternProperties", { any: FILE_PROPERTY }),
      },
      {
        where: "not at the root",
        schema: { type: "object", not: FILE_PROPERTY },
      },
      { where: "not", schema: underProperty("not", FILE_PROPERTY) },
      { where: "if", schema: underProperty("if", FILE_PROPERTY) },
      { where: "then", schema: underProperty("then", FILE_PROPERTY) },
      { where: "else", schema: underProperty("else", FILE_PROPERTY) },
      { where: "items", schema: underProperty("items", FILE_PROPERTY) },
      {
        where: "items as a tuple",
        schema: underProperty("items", [{ type: "string" }, FILE_PROPERTY]),
      },
      { where: "oneOf", schema: underProperty("oneOf", [FILE_PROPERTY]) },
      { where: "allOf", schema: underProperty("allOf", [FILE_PROPERTY]) },
      {
        where: "definitions at the root",
        schema: {
          type: "object",
          properties: { body: { $ref: "#/definitions/upload" } },
          definitions: { upload: FILE_PROPERTY },
        },
      },
    ];

    for (const { where, schema } of hidden) {
      useComposioClient(listing(schema));
      const listed = await listTools({ url: "composio://gmail" });
      // The keyword is carried into the comparison so a failure names which one escaped.
      expect({ where, offered: listed.map((tool) => tool.name) }).toEqual({
        where,
        offered: ["GMAIL_FETCH_EMAILS"],
      });
    }
  });

  test("an action is dropped only where the flag is actually set", async () => {
    /*
     * THE OTHER HALF OF THE WALK, which decides what stays offered. `file_uploadable` is
     * `z.boolean().optional()` (`src/types/tool.types.ts:89`), so `false` is a value the vendor
     * really sends and the comparison against `true` rather than against truthiness is what keeps
     * it from dropping an action nobody has to stage anything for. `additionalProperties` is a
     * union with `boolean` (`:111`, `:154`), so `true` and `false` arrive there as values and the
     * walk has to read them as "not a subschema" instead of tripping over them.
     */
    const offered: { where: string; schema: Record<string, unknown> }[] = [
      {
        where: "the flag is explicitly false",
        schema: {
          type: "object",
          properties: { note: { type: "string", file_uploadable: false } },
        },
      },
      {
        where: "additionalProperties is open",
        schema: { type: "object", additionalProperties: true },
      },
      {
        where: "additionalProperties is closed",
        schema: { type: "object", additionalProperties: false },
      },
    ];

    for (const { where, schema } of offered) {
      useComposioClient(listing(schema));
      const listed = await listTools({ url: "composio://gmail" });
      expect({ where, offered: listed.map((tool) => tool.name) }).toEqual({
        where,
        offered: ["GMAIL_FETCH_EMAILS", "GMAIL_STAGES_A_FILE"],
      });
    }
  });

  test("the schema a model is shown is the one the SDK handed over, unaltered", async () => {
    /*
     * A CHARACTERIZATION TEST, and it passed before the claim beside `inputParameters` was
     * corrected — the correction is to a comment, because the loss it describes happens inside
     * `ToolSchema.parse` and there is no key left here to restore.
     *
     * What it pins is the narrower promise that replaced the false one: this module adds nothing to
     * the schema and removes nothing from it. The keys below are ones `ParametersSchema` and
     * `JSONSchemaPropertySchema` would have stripped, so a real client never delivers them — which
     * is exactly why they are the right probe for whether anything HERE also strips. `listTools`
     * now walks the schema looking for a file parameter, and a walk that rebuilt what it read
     * would silently narrow every schema in the listing.
     */
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", deprecated: true, contentEncoding: "utf-8" },
      },
      if: { required: ["query"] },
      // No `then` beside it: biome bans a `then` key on an object literal, and the point of these
      // is only that they are root keywords `ParametersSchema` does not name.
      else: { required: [] },
      examples: [{ query: "is:unread" }],
      "x-openbot-probe": "kept",
    };
    /*
     * SNAPSHOTTED BEFORE THE CALL, because comparing the answer to `schema` compares it to the very
     * object the stub handed over. `toEqual` between two references to one object holds whatever
     * happened in between, so an in-place `delete` inside `listTools` — a walk that pruned what it
     * read — passed this test unchanged. Proven: one added `delete` of a root keyword in the map
     * left all 44 tests green.
     *
     * The snapshot is what the SDK handed over. The first assertion is that a model is shown that;
     * the second is that the vendor's own object still IS that, because a module returning a
     * faithful copy while wrecking the original would corrupt every later reader of one listing.
     */
    const asHandedOver = structuredClone(schema);
    useComposioClient(
      recording({
        listActions: async () => [{ ...GMAIL_READ, inputParameters: schema }],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });
    expect(tool?.inputSchema).toEqual(asHandedOver);
    expect(schema).toEqual(asHandedOver);
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

  test("an action Composio published no version for is listed with no version key", async () => {
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_UNVERSIONED", tags: ["readOnlyHint"] },
        ],
      }).client,
    );

    const [tool] = await listTools({ url: "composio://gmail" });

    // The branch that spreads the key only when the vendor sent one had nothing exercising it:
    // every listing stub above carries a version. What it guards is not cosmetic. `store.ts`
    // writes `tool.version ?? null`, so a key present and empty would be recorded as a version this
    // deployment believes it has, and `callTool` would send `""` to a vendor that rejects it —
    // instead of the refusal that names what the reader can and cannot do about it.
    expect(Object.keys(tool ?? {})).not.toContain("version");
    expect(tool?.name).toBe("GMAIL_UNVERSIONED");
    expect(tool?.effect).toBe("read");
  });

  test("a listing nobody was asked for throws rather than answering empty", async () => {
    // `[]` means "the vendor was asked and advertises none" everywhere else in this codebase, and
    // `refreshTools` commits it as a healthy refresh. No client installed is the SHIPPED state —
    // nothing under `server/src` calls `useComposioClient` — so `[]` here was the only answer a
    // real Composio refresh could produce, and committing it deleted every recorded action.
    const listing = listTools({ url: "composio://gmail" });

    await expect(listing).rejects.toThrow(
      /not configured for this deployment/i,
    );

    const thrown = (await listing.catch((error: unknown) => error)) as Error;
    expect(thrown.message).toContain("gmail");
    // Not a crash report. No deployment installs a client yet, so an operator reading this has to
    // recognise a state rather than go hunting for a fault.
    expect(thrown.message).toMatch(/expected/i);
  });

  test("a url that names no app throws about the url, and asks nobody", async () => {
    /*
     * THE REFUSAL IS ONLY HALF THE CLAIM, and this test used to make only that half.
     *
     * With the default stub answering `[]`, nothing here noticed whether Composio had been asked
     * at all — so the guard could be moved to after the dial and every assertion below still
     * passed, while the transport handed `https://example.com` to the vendor as an app slug. That
     * is the failure the guard exists to prevent: `toolkitOf` is what keeps a url this deployment
     * cannot read from becoming a request, and a test that cannot tell a refusal from a round trip
     * is not testing the guard.
     */
    const asked: unknown[] = [];
    useComposioClient(
      recording({
        listActions: async (toolkit, page) => {
          asked.push({ toolkit, page });
          return [];
        },
      }).client,
    );

    const listing = listTools({ url: "https://example.com" });

    // The two refusals send an operator to different places — one to this deployment's
    // configuration, one to the row — so they must not share a sentence.
    await expect(listing).rejects.toThrow(/does not name a Composio app/i);

    const thrown = (await listing.catch((error: unknown) => error)) as Error;
    expect(thrown.message).not.toMatch(/not configured/i);
    expect(thrown.message).toContain("https://example.com");
    expect(asked).toEqual([]);
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

  test("a listing that failed with nothing said still names the app it was about", async () => {
    // The other arm of `listingSentence`'s fallback, which nothing reached. `refreshTools` puts
    // this string in the row's `lastError` and an administrator reads it off the Plugins page, so
    // a blank one is a refresh that reports having failed and declines to say about what.
    for (const thrown of [{ status: 502 }, new Error(""), new Error("   ")]) {
      useComposioClient(
        recording({
          listActions: async () => {
            throw thrown;
          },
        }).client,
      );

      const message = await listTools({ url: "composio://gmail" }).then(
        () => "",
        (error: unknown) => (error as Error).message,
      );

      expect(message.trim()).not.toBe("");
      expect(message).toContain("gmail");
    }
  });

  test("a listing failure carrying only the vendor's placeholder says something else", async () => {
    /*
     * `callTool` already refuses to pass "Error executing the tool X" on, and the listing path did
     * not. Same string, same reader: `refreshTools` writes this sentence into the row's
     * `lastError` and an administrator reads it off the Plugins page, where the name of the thing
     * they asked to refresh is the one fact they already have.
     */
    useComposioClient(
      recording({
        listActions: async () => {
          throw new Error("Error executing the tool GMAIL_FETCH_EMAILS");
        },
      }).client,
    );

    const message = await listTools({ url: "composio://gmail" }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).not.toMatch(/error executing the tool/i);
    expect(message).toContain("gmail");
  });

  test("an answer that is not a list of actions throws a sentence, not a TypeError", async () => {
    /*
     * `ComposioActions` is OUR projection of the vendor, implemented by an adapter nobody has
     * written yet, and TypeScript polices none of what a promise actually resolves to at runtime.
     * A client that answers `null` — a 204, an SDK path that returns before assigning, a mock in
     * somebody's staging deployment — used to reach `actions.length` and `actions.filter` outside
     * the try that wraps the vendor's call, so what propagated was `null is not an object`. That
     * lands verbatim in `lastError` on the Plugins page and tells an administrator nothing about
     * which app or what to do, which is the whole reason this path throws sentences.
     */
    // `[null]` is the same failure one level down: it clears `Array.isArray` and then reaches
    // `action.inputParameters` in the filter, which is outside that try as well.
    for (const shape of [null, undefined, { items: [] }, "gmail", [null]]) {
      useComposioClient(
        recording({
          listActions: async () => shape as unknown as ComposioAction[],
        }).client,
      );

      const message = await listTools({ url: "composio://gmail" }).then(
        () => "",
        (error: unknown) => (error as Error).message,
      );

      expect(message).toContain("gmail");
      expect(message).not.toMatch(/is not an object|is not a function/i);
    }
  });

  test("a version made only of whitespace is recorded as no version at all", async () => {
    /*
     * TRIMMED ON THE WAY IN BECAUSE IT IS TRIMMED ON THE WAY OUT. `callTool` trims the recorded
     * version and refuses an empty one, so a blank string that counts as a version here is written
     * to `mcp_tools` as a version this deployment believes it has and is then permanently
     * unusable — and the refusal the caller gets names a refresh, which rewrites the same blank.
     * That is exactly the loop the test above reasons about, reached by recording rather than by
     * the vendor publishing nothing.
     */
    useComposioClient(
      recording({
        listActions: async () => [
          { slug: "GMAIL_BLANK", tags: ["readOnlyHint"], version: "   " },
          {
            slug: "GMAIL_PADDED",
            tags: ["readOnlyHint"],
            version: " 20260903_00\n",
          },
        ],
      }).client,
    );

    const [blank, padded] = await listTools({ url: "composio://gmail" });

    expect(Object.keys(blank ?? {})).not.toContain("version");
    // Recorded as the version `callTool` will actually send, rather than as one it has to repair.
    expect(padded?.version).toBe("20260903_00");
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
        toolkit: "gmail",
        slug: "GMAIL_FETCH_EMAILS",
        userId: "user_asker",
        version: "20260903_00",
      },
    ]);
    expect(result.isError).toBe(false);
  });

  test("the app goes out with the call, and follows the url when the url changes", async () => {
    /*
     * THE DEEPEST HOLE THIS TRANSPORT HAD. `toolkitOf` resolved the app, `accessFor` gated the
     * person's `composio_connections` row on it, and then the call went out as the slug alone —
     * and a slug is what a LISTING recorded, not what the url says now. A url edited between a
     * refresh and a call was therefore gated on the app it names today and run against the app it
     * named when the tools were last read: a person who connected Slack satisfying the gate for a
     * Gmail action that still runs in their Gmail.
     *
     * Composio's wire cannot carry the pair — `ToolExecuteParams` has no toolkit field and
     * `tools.execute(toolSlug, params)` takes the slug alone (`@composio/client` 0.1.0-alpha.76,
     * `resources/tools.d.ts:480-493` and `:41`) — so what binds them here is that the app is an
     * argument of the call this module makes and an implementation has to reconcile it with the
     * tool it resolves. Asserting it is passed asserts the implementation was handed the fact it
     * needs; asserting it FOLLOWS the url is the part a check performed and then discarded could
     * never show, and discarding it was the defect.
     */
    const { client, calls } = recording();
    useComposioClient(client);

    for (const app of ["gmail", "slack"]) {
      await callTool(
        { url: `composio://${app}`, actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );
    }

    expect(calls.map((call) => call.toolkit)).toEqual(["gmail", "slack"]);
  });

  test("the version is not passed on to the vendor as an argument", async () => {
    const seen: Record<string, unknown>[] = [];
    useComposioClient(
      recording({
        execute: async (_call, args) => {
          seen.push(args);
          return answered({});
        },
      }).client,
    );

    // Held in a variable rather than written inline, because `seen` showing the version absent
    // shows it only of whatever object the module chose to pass on. Deleting the key from the
    // CALLER'S object and forwarding that satisfies the assertion below while destroying the
    // record the call path still holds — the same identity-for-value mistake the schema test had.
    const args = { query: "is:unread", __version: "20260903_00" };
    await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      args,
    );

    expect(seen).toEqual([{ query: "is:unread" }]);
    expect(args).toEqual({ query: "is:unread", __version: "20260903_00" });
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

    // The refusal used to name a refresh as THE fix, unconditionally. It is not one where the
    // vendor published no version: `listTools` sets the field only when Composio sent one, so a
    // refresh writes the same nothing back and the reader presses the button again. The sentence
    // has to make the remedy conditional on the vendor, which is the part nobody here controls.
    expect(result.text).not.toContain(
      "Refresh this app's tools on its Plugins page and try again.",
    );
    expect(result.text).toMatch(/only if Composio publishes/i);
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
        toolkit: "gmail",
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

    // VISIBLY is the marker and RATHER THAN SILENTLY is the flag, and this test asserted only the
    // flag. `truncated: true` beside text that just stops is exactly the silent cut the name
    // promises against: the model reads a JSON document that ends mid-token and completes it from
    // memory, because nothing in what it was handed says the ending is ours.
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text.slice(-TRUNCATION_MARKER.length)).toBe(
      TRUNCATION_MARKER,
    );
    expect(result.text.length).toBe(CAPPED_LENGTH);
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
    // Nothing to say is not a failure and is not a truncation. Both fields were unasserted, so this
    // branch could have started reporting an error and the test would not have noticed.
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(false);
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
    // `successful`, `error` and `logId` are the envelope this transport reads to decide the
    // outcome. Reporting them as content spends a model's context on our own bookkeeping. Pinned
    // as the whole string rather than as three absences, because a list of things that must not
    // appear is only ever as long as the fields the envelope had on the day it was written — the
    // vendor's `sessionInfo` is already in the type and named in none of them.
    expect(result.text).toBe(
      JSON.stringify({ messages: [{ id: "m1" }] }, null, 2),
    );
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

  test("a failure that carries no message at all still says something actionable", async () => {
    /*
     * The empty-message arm of the fallback, which nothing reached. Both ways of arriving at it are
     * real: `@composio/core` rejects with plain objects on some paths, so `error instanceof Error`
     * is false and there is no message to read at all; and a thrown `Error` whose message is blank
     * or whitespace is what a transport-level abort produces.
     *
     * Passed on unchanged, either one lands in a model's context and in `store.ts`'s audit row as an
     * empty refusal — a failure with `isError: true` and nothing said, which reads to a model as
     * permission to invent a reason and retry.
     */
    for (const thrown of [{ status: 502 }, new Error(""), new Error("  \n ")]) {
      useComposioClient(
        recording({
          execute: async () => {
            throw thrown;
          },
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(result.isError).toBe(true);
      expect(result.text.trim()).not.toBe("");
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      expect(result.text).toMatch(/Plugins page/);
    }
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
    // "and says so" is the marker, which nothing here used to check.
    expect(result.text.slice(-TRUNCATION_MARKER.length)).toBe(
      TRUNCATION_MARKER,
    );
    expect(result.text.length).toBe(CAPPED_LENGTH);
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
    expect(result.text.slice(-TRUNCATION_MARKER.length)).toBe(
      TRUNCATION_MARKER,
    );
    expect(result.text.length).toBe(CAPPED_LENGTH);
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

  test("an answer reporting an error while claiming success is a failure", async () => {
    /*
     * `ToolExecuteResponseSchema` spells `error` and `successful` as two independent required
     * fields and correlates them nowhere; `transformToolExecuteResponse` copies both straight off
     * the wire (`@composio/core` 0.18.1, `src/models/Tools.ts:215-222`). So the combination is a
     * shape the vendor's own schema permits, and keying only on `successful === false` dropped the
     * one sentence in it that says anything — audited as `mcp.call_succeeded`, with the failure
     * handed to the model as though it were content.
     *
     * The strict reading is the safe one and it is also the vendor's: where the SDK has to derive
     * the flag itself it writes `successful: !response.error` (`src/models/Tools.ts:1247`), so a
     * present error IS a failure by their own arithmetic. Same rule as `effectOf` uses for
     * contradictory labels — both at once is somebody else's bug, and we take the strict branch.
     */
    useComposioClient(
      recording({
        execute: async () =>
          answered(
            { messages: [{ id: "m1" }] },
            {
              successful: true,
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
    // The data must not be handed over as content beside a reported failure.
    expect(result.text).not.toContain("m1");
  });

  test("an empty error beside a success is still a success", async () => {
    // The other side of the rule, and the reason it is worded as a SENTENCE rather than as a
    // present field: `successful: !response.error` treats `""` as success, so an empty string is
    // the vendor saying nothing went wrong in the least committal way available to it.
    useComposioClient(
      recording({
        execute: async () =>
          answered({ messages: [] }, { successful: true, error: "" }),
      }).client,
    );

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { __version: "20260903_00" },
    );

    expect(result.isError).toBe(false);
    expect(result.text).toBe(JSON.stringify({ messages: [] }, null, 2));
  });

  test("an answer that is not an envelope refuses rather than throwing", async () => {
    /*
     * THE NEVER-THROW CONTRACT, asserted against the shape that broke it. This module documents a
     * failure as a RESULT and `store.ts` relies on it: a model is mid-run with a person waiting,
     * and an exception ends the turn with nothing said and nothing audited.
     *
     * `reportedFailure(answer, …)` read `answer.successful` outside every try, so a client
     * resolving `null` threw a `TypeError` straight out of `callTool`. Like the listing case, this
     * is a shape `ToolExecuteResponseSchema` forbids and `ComposioActions` cannot police — the
     * projection is ours, the adapter is unwritten, and a runtime resolution is not a type.
     */
    for (const shape of [null, undefined, "ok", 7]) {
      useComposioClient(
        recording({
          execute: async () => shape as unknown as ComposioResult,
        }).client,
      );

      const result = await callTool(
        { url: "composio://gmail", actorId: "user_asker" },
        "GMAIL_FETCH_EMAILS",
        { __version: "20260903_00" },
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("GMAIL_FETCH_EMAILS");
      expect(result.text).not.toMatch(/is not an object|undefined is not/i);
    }
  });
});
