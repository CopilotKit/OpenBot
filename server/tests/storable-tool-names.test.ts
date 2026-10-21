import { describe, expect, test } from "bun:test";
import {
  OFFERABLE_TOOL_NAME,
  storableTools,
  toolNameFor,
} from "../src/plugins/plugin-store/model";

/**
 * THE ONE SEAM EVERY TRANSPORT'S LISTING CROSSES ON ITS WAY INTO THE DATABASE, asked the question
 * nothing used to ask it: is this a name a model can actually be offered?
 *
 * The defect that put this here was Arcade's, but the hole was general. `mcp_tools.name` is spliced
 * into `mcp__<server>__<name>` and handed to the model API, which takes `^[a-zA-Z0-9_-]+$` and
 * nothing else — and no code between the vendor's listing and that request ever looked. A dotted
 * `Gmail.ListEmails` was recorded, offered, and refused as `Invalid 'tools[47].name'`: a 400 on the
 * whole request, naming an index, mentioning neither the app nor the action nor the refresh that
 * recorded it. Whoever read that had nothing to act on.
 */
describe("a listing never records a name the model API would refuse", () => {
  const listed = (name: string) => [{ name, description: "", inputSchema: {} }];

  test("a dotted name is skipped and named, and the rest of the listing is stored", () => {
    /*
     * SKIPPED, NOT REFUSED. The MCP spec allows a dot in a tool name, so a custom server with one
     * dotted action among forty ordinary ones is a server working as its author meant. Refusing the
     * whole listing stored none of the forty on an add, and froze the list on every refresh after;
     * skipping the one name keeps it away from the model and keeps the rest offered.
     */
    const { rows, skipped } = storableTools("notes", [
      { name: "search", description: "", inputSchema: {} },
      { name: "notes.export", description: "", inputSchema: {} },
      { name: "create-note", description: "", inputSchema: {} },
    ]);

    expect(rows.map((row) => row.name)).toEqual(["search", "create-note"]);
    // The name as the vendor listed it, which is what an administrator will look for.
    expect(skipped).toEqual(["notes.export"]);
  });

  test("a name skipped twice is reported once", () => {
    const { rows, skipped } = storableTools("arcade-Gmail", [
      ...listed("Gmail.ListEmails"),
      ...listed("Gmail.ListEmails"),
    ]);

    expect(rows).toEqual([]);
    expect(skipped).toEqual(["Gmail.ListEmails"]);
  });

  test("the names the other transports publish are untouched", () => {
    /*
     * COMPOSIO AND MCP PASS AS THEY STAND, which is what makes this guard safe to add to a live
     * deployment: the only non-alphanumeric character in any name those transports publish is `_`.
     * A guard that refused them would take every working connector down with it.
     */
    const { rows, skipped } = storableTools(
      "gmail",
      listed("GMAIL_FETCH_EMAILS"),
    );

    expect(rows).toMatchObject([
      { name: "GMAIL_FETCH_EMAILS", vendorName: "GMAIL_FETCH_EMAILS" },
    ]);
    expect(skipped).toEqual([]);
  });

  test("a transport that draws no distinction records the same string twice", () => {
    /*
     * ABSENCE MEANS "THE SAME NAME", AND IS RECORDED AS THE SAME NAME rather than as a null the
     * readers would each have to remember to fall back from. Every read of `vendorName` is a call
     * about to be made or a gate about to be answered; a tri-state there is a branch each one could
     * get wrong separately.
     */
    expect(storableTools("notes", listed("search")).rows).toMatchObject([
      { name: "search", vendorName: "search" },
    ]);
  });

  test("a transport's own spelling is kept when it gives one", () => {
    const { rows } = storableTools("arcade-Gmail", [
      {
        name: "ListEmails",
        vendorName: "Gmail.ListEmails",
        description: "",
        inputSchema: {},
      },
    ]);

    expect(rows).toMatchObject([
      { name: "ListEmails", vendorName: "Gmail.ListEmails" },
    ]);
  });

  test("what survives the guard is an offered name the API accepts", () => {
    /*
     * THE GUARD'S WHOLE POINT, stated as the property rather than as a list of cases. The prefix and
     * the separator are themselves made of accepted characters, so a `name` that passes is an
     * offered name that passes — and that is the implication worth pinning, because it is the one
     * the guard is relied on for.
     */
    for (const name of [
      "search",
      "GMAIL_FETCH_EMAILS",
      "ListEmails",
      "a-b_C9",
    ]) {
      const [row] = storableTools("server-id", listed(name)).rows;
      expect(OFFERABLE_TOOL_NAME.test(row!.name)).toBe(true);
      expect(toolNameFor(`server-id/${row!.name}`)).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
