import { expect, test } from "bun:test";
import type { PluginTool } from "@/lib/plugins/queries";
import { readOnlyRefs } from "@/routes/_authed/admin/plugins/$key_.bots.$agentId";

/**
 * What one button on the per-Bot grant screen promises, checked without drawing anything.
 *
 * The screen lists every action an app offers with a switch each, and offers one bulk action:
 * "Turn on every read-only action". That button is the only control on the page that grants more
 * than one thing at a time, so the only thing worth pinning about it is the set it acts on — every
 * read, and nothing that changes anything, however the vendor labels it.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `agent-roster-error.test.tsx`. Nothing here renders, though — `readOnlyRefs` is exported as a
 * function rather than left inline for exactly that reason, following `composio-picker.test.tsx`:
 * the promise the button makes can be asserted without a DOM, a router or a query client.
 */

/** A minimal but complete `PluginTool`, overridable per case. */
function tool(overrides: Partial<PluginTool> & { name: string }): PluginTool {
  return {
    serverId: "slack",
    description: "Does something.",
    inputSchema: {},
    ref: `slack/${overrides.name}`,
    effect: "read",
    destructive: false,
    grantedTo: [],
    ...overrides,
  };
}

const LIST_CHANNELS = tool({ name: "list_channels" });
const SEARCH_MESSAGES = tool({ name: "search_messages" });
const SEND_MESSAGE = tool({ name: "send_message", effect: "write" });
const DELETE_CHANNEL = tool({
  name: "delete_channel",
  effect: "write",
  destructive: true,
});

test("the bulk action covers every read, and nothing that changes anything", () => {
  const refs = readOnlyRefs([
    LIST_CHANNELS,
    SEND_MESSAGE,
    SEARCH_MESSAGES,
    DELETE_CHANNEL,
  ]);

  // Every read, so the button's own sentence about what the Bot would then hold is true.
  expect(refs).toEqual(["slack/list_channels", "slack/search_messages"]);
  // And nothing else: a bulk grant that quietly swept a write in would be the one mistake this
  // button must never make, because nobody switched that write on.
  expect(refs).not.toContain("slack/send_message");
});

test("a destructive action never appears in the bulk action", () => {
  const tools = [LIST_CHANNELS, SEND_MESSAGE, DELETE_CHANNEL];
  const refs = readOnlyRefs(tools);

  // Read back through the tools rather than naming the ref: this asserts the property — nothing
  // the vendor warns about destroying anything comes out — rather than one hard-coded absence.
  const granted = tools.filter((entry) => refs.includes(entry.ref));
  expect(granted.every((entry) => !entry.destructive)).toBe(true);
  expect(granted.every((entry) => entry.effect === "read")).toBe(true);
});

test("an app that offers nothing to read grants nothing", () => {
  // The button is hidden in this case, and would still be harmless if it were not: an empty
  // promise is kept by doing nothing, not by falling back to the whole list.
  expect(readOnlyRefs([SEND_MESSAGE, DELETE_CHANNEL])).toEqual([]);
  expect(readOnlyRefs([])).toEqual([]);
});
