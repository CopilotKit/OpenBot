import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MCPMock, type MCPToolDefinition } from "@copilotkit/aimock/mcp";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { catalogueEntry, classifyTool } from "../src/plugins/catalogue";
import { listTools } from "../src/plugins/mcp";

/**
 * What an MCP listing carries out of the transport, and what the classifier then makes of it.
 *
 * WHY THIS SUITE EXISTS. The MCP specification lets a server publish `annotations.destructiveHint`,
 * and `listTools` used to drop the whole `annotations` object on the floor. Nothing failed: every
 * MCP-listed tool simply arrived with no effect, `refreshTools` recorded null, and `classifyTool`
 * fell through to the reviewed write list. That looked correct — and it was, for every name a
 * person had already reviewed. For a name the reviewed list did not happen to hold, a tool the
 * vendor had explicitly declared destructive classified as a READ. Fail-open on a
 * permission-adjacent decision, and invisible, because the only evidence was a field never read.
 *
 * These cases pin the transport and the classifier TOGETHER rather than separately. A unit test of
 * `listTools` alone would prove a field is copied; a unit test of `classifyTool` alone would prove
 * a string is honoured. Neither would have caught this, because the defect lived exactly in the
 * join: the transport never produced the string the classifier was already willing to act on. So
 * each case here goes over a real MCP connection and then through the same call `store.ts` makes,
 * `classifyTool(entry, name, true, tool.effect ?? null)` — what `refreshTools` writes to the column
 * and what the call path reads back out of it.
 */

const mock = new MCPMock();
let url = "";

/**
 * A tool definition including the annotations the mock's own type does not declare.
 *
 * `MCPToolDefinition` names only `name`, `description` and `inputSchema`, but the mock stores the
 * definition it is handed and serves it back verbatim, so annotations really do cross the wire.
 * Widening the type here rather than casting keeps the fixture honest: `ToolAnnotations` is the
 * SDK's own declaration, so a hint renamed upstream fails this file at compile time instead of
 * silently ceasing to be served.
 */
type AnnotatedTool = MCPToolDefinition & { annotations?: ToolAnnotations };

/** Every tool needs one: the SDK rejects an entire listing that omits a single `inputSchema`. */
const NO_ARGUMENTS = { type: "object", properties: {} } as const;

/**
 * Notion's real catalogue entry, not a fabricated one.
 *
 * The question this suite answers is what happens to the connector this deployment actually ships,
 * so the reviewed write list under test has to be the shipped one. `notion-fetch` is on Notion's
 * advertised listing and absent from `writeTools`; `notion-update-page` is on `writeTools`. Those
 * two names are what make the narrowing and the no-widening cases meaningful.
 */
const notion = catalogueEntry("notion");

/**
 * A destructive action absent from Notion's reviewed write list.
 *
 * Deliberately a name `writeTools` does not hold, because a name it DOES hold classifies as a write
 * whatever the listing says — which would make this case pass without the transport carrying
 * anything at all.
 */
const destructiveUnreviewed: AnnotatedTool = {
  name: "notion-purge-workspace",
  description: "Removes everything.",
  inputSchema: NO_ARGUMENTS,
  annotations: { destructiveHint: true },
};

/** A read the vendor labels as one, which the reviewed list already classified as a read. */
const readOnlyUnreviewed: AnnotatedTool = {
  name: "notion-fetch",
  description: "Reads a page.",
  inputSchema: NO_ARGUMENTS,
  annotations: { readOnlyHint: true },
};

/** A reviewed write that the vendor contradicts by calling it read-only. */
const readOnlyButReviewedAsWrite: AnnotatedTool = {
  name: "notion-update-page",
  description: "The vendor claims this only reads.",
  inputSchema: NO_ARGUMENTS,
  annotations: { readOnlyHint: true },
};

/** A tool with no annotations at all, which is what most MCP servers publish. */
const unannotated: AnnotatedTool = {
  name: "notion-search",
  description: "Says nothing about what it does.",
  inputSchema: NO_ARGUMENTS,
};

beforeAll(async () => {
  mock
    .addTool(destructiveUnreviewed)
    .addTool(readOnlyUnreviewed)
    .addTool(readOnlyButReviewedAsWrite)
    .addTool(unannotated);
  url = await mock.start();
});

afterAll(async () => {
  await mock.stop?.();
});

/**
 * The classification a refresh would commit for one listed tool.
 *
 * Written as `tool.effect ?? null` because that is literally what `refreshTools` inserts into
 * `mcp_tools.effect`, and `classifyTool` distinguishes null from the empty string. Reproducing the
 * `??` here rather than passing `tool.effect` through is the difference between testing the shipped
 * path and testing a plausible one.
 */
const classify = (
  tools: Awaited<ReturnType<typeof listTools>>,
  name: string,
) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`the mock did not list ${name}`);
  return classifyTool(notion, name, true, tool.effect ?? null);
};

describe("what an MCP listing tells the classifier", () => {
  test("a tool the vendor declares destructive is a write", async () => {
    /*
     * The case the whole change exists for. Nothing in the reviewed list names
     * `notion-purge-workspace`, so before the annotations were surfaced this returned "read" — a
     * Bot with a read grant could have called it.
     */
    const tools = await listTools({ url });

    expect(classify(tools, "notion-purge-workspace")).toBe("write");
  });

  test("a destructive tool is also carried as destructive, not only as a write", async () => {
    // `effect` gates the call; `destructive` is what the confirmation card reads. A tool that
    // arrived as a write with `destructive` false would be gated correctly and presented wrongly.
    const tools = await listTools({ url });
    const purge = tools.find((tool) => tool.name === "notion-purge-workspace");

    expect(purge?.destructive).toBe(true);
  });

  test("a vendor's read-only claim cannot take a reviewed write off the write list", async () => {
    /*
     * The direction the criterion forbids. `notion-update-page` is on the reviewed `writeTools`,
     * and a server that says otherwise — whether mistakenly or because somebody stood up a server
     * that says whatever it likes — must not be able to widen what a Bot may do.
     */
    const tools = await listTools({ url });

    expect(classify(tools, "notion-update-page")).toBe("write");
  });

  test("a vendor's read-only claim records nothing at all", async () => {
    /*
     * WITHHELD ON PURPOSE, and pinned so the omission reads as a decision rather than as the same
     * oversight being fixed. `readOnlyHint` can only ever move an action towards "read", which is
     * the widening the classifier's ordering exists to prevent. For a catalogued vendor it would
     * change nothing — an advertised name absent from `writeTools` is already a read — so it buys
     * no accuracy; for a server an administrator added by URL there is no reviewed list at all, and
     * honouring it would let that server declare its own tools harmless and be believed. The SDK
     * says as much where it declares these hints: clients should never make tool use decisions
     * based on annotations received from untrusted servers. Acting only on the hint that narrows is
     * how that warning is honoured while a declared destructive tool still gets gated.
     */
    const tools = await listTools({ url });
    const fetch = tools.find((tool) => tool.name === "notion-fetch");

    expect(fetch?.effect).toBeUndefined();
    // And so the reviewed list still decides, exactly as it did before this change.
    expect(classify(tools, "notion-fetch")).toBe("read");
  });

  test("a tool with no annotations is unchanged in every respect", async () => {
    // The overwhelmingly common case, and the one that says existing Notion grants survive: no
    // annotations means nothing recorded, which means the reviewed list decides as it always did.
    const tools = await listTools({ url });
    const search = tools.find((tool) => tool.name === "notion-search");

    expect(search?.effect).toBeUndefined();
    expect(search?.destructive).toBeUndefined();
    expect(classify(tools, "notion-search")).toBe("read");
  });
});
