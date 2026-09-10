import { describe, expect, test } from "bun:test";
import { catalogueEntry, classifyTool } from "../src/plugins/catalogue";

/**
 * What an action does, when the vendor said so and when nobody did.
 *
 * The property under test is the direction of the failure. Exactly two things can earn a read, and
 * both require somebody to have said so: the vendor recorded exactly `read`, or a curated entry
 * advertised the action and a reviewed list declined to call it a write. Everything else — a
 * recorded write, an unrecognised value, a different case, an empty string, a name no server
 * advertised, a server nobody reviewed — is a write. That asymmetry is the point: an action wrongly
 * gated as a write costs a confirmation, and one wrongly waved through as a read costs somebody's
 * mailbox.
 *
 * THE RECORDED VALUE MAY NARROW WHAT A BOT MAY DO AND MAY NEVER WIDEN IT. It arrives from a vendor
 * listing into a plain `text` column with no constraint on its contents, so it outranks nothing that
 * a human reviewed. Both halves are pinned below: a recorded write settles an action the curated
 * list forgot, and a recorded read cannot unsettle one the curated list named.
 *
 * The first block passes a null entry throughout, which is the brokered shape — a Composio app has
 * no curated entry behind it. The second block passes a real one, because a null entry is itself a
 * blanket write and would let the precedence cases below pass without exercising the precedence.
 */
describe("classifyTool with a recorded effect", () => {
  test("a recorded read is a read", () => {
    expect(classifyTool(null, "GMAIL_FETCH_EMAILS", true, "read")).toBe("read");
  });

  test("a recorded write is a write", () => {
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "write")).toBe("write");
  });

  test("no recorded effect is a write, not a read", () => {
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, null)).toBe("write");
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, undefined)).toBe(
      "write",
    );
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "")).toBe("write");
  });

  test("a value nothing recognises is a write", () => {
    // A future label, a typo, or a column somebody wrote by hand. None is a licence to read.
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "readonly")).toBe(
      "write",
    );
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "destructive")).toBe(
      "write",
    );
    expect(classifyTool(null, "GMAIL_SEND_EMAIL", true, "READ")).toBe("write");
  });

  test("a recorded read cannot rescue an action the server never advertised", () => {
    // The name came from somewhere other than a listing, so no recorded effect is about it.
    expect(classifyTool(null, "GMAIL_INVENTED", false, "read")).toBe("write");
  });
});

describe("a recorded effect against a curated entry", () => {
  const notion = catalogueEntry("notion");

  /*
   * The two names every case below is built on, asserted once.
   *
   * `notion-update-page` has to be ON the write list and `notion-fetch` has to be OFF it, or the
   * expectations stop meaning what they say: a reviewed write whose name drifted off the list would
   * turn the precedence cases into ordinary unlisted-tool cases and they would keep passing.
   */
  test("the entry these cases are about names one of them a write and not the other", () => {
    expect(notion).not.toBeNull();
    expect(notion?.writeTools).toContain("notion-update-page");
    expect(notion?.writeTools).not.toContain("notion-fetch");
  });

  test("a recorded read cannot override a curated entry's write list", () => {
    /*
     * THE CASE THIS WHOLE BLOCK EXISTS FOR. `effect` is vendor-supplied text in a column with no
     * check constraint and no product writer other than the refresh path, so a `read` in it is
     * reachable by a hand edit or a restore. `writeTools` was reviewed by a person. Letting the
     * column win here would buy an action LESS scrutiny than review already gave it, which is the
     * one direction this classifier must never move in.
     */
    expect(classifyTool(notion, "notion-update-page", true, "read")).toBe(
      "write",
    );
    expect(classifyTool(notion, "notion-create-pages", true, "read")).toBe(
      "write",
    );
    expect(classifyTool(notion, "notion-move-pages", true, "read")).toBe(
      "write",
    );
  });

  test("a recorded read still settles an action the write list does not name", () => {
    // The permitted direction, and the reason the column is consulted at all: where review said
    // nothing, the vendor's own label is the better source and is taken at its word.
    expect(classifyTool(notion, "notion-fetch", true, "read")).toBe("read");
  });

  test("a recorded write settles an action the write list forgot", () => {
    // The other permitted direction. The write list is known-incomplete, so a vendor saying an
    // action writes narrows what a Bot may do and is honoured.
    expect(classifyTool(notion, "notion-fetch", true, "write")).toBe("write");
  });

  test("an empty recorded effect is a write, not an absence of opinion", () => {
    /*
     * A `text` column holding the empty string is a value, not a null. Reading it as "nothing was
     * recorded" sends an advertised action that no reviewed list names down the read branch, which
     * is the widening this classifier exists to refuse. Both sides of the write list are pinned so
     * the answer cannot depend on which one the name falls on.
     */
    expect(classifyTool(notion, "notion-fetch", true, "")).toBe("write");
    expect(classifyTool(notion, "notion-update-page", true, "")).toBe("write");
  });

  test("a recorded value nothing recognises is a write", () => {
    // A label a vendor invents later, a typo, or the wrong case. None of them is `read`, so none of
    // them earns a read, whether or not the reviewed list names the action.
    for (const value of ["readonly", "READ", "Read", "destructive", "none"]) {
      expect(classifyTool(notion, "notion-fetch", true, value)).toBe("write");
      expect(classifyTool(notion, "notion-update-page", true, value)).toBe(
        "write",
      );
    }
  });

  test("nothing recorded leaves the curated write list deciding", () => {
    // The behaviour that shipped before the column existed, unchanged for every row written before
    // it. Null and undefined are the column saying nothing, which is not a value.
    for (const value of [null, undefined]) {
      expect(classifyTool(notion, "notion-update-page", true, value)).toBe(
        "write",
      );
      expect(classifyTool(notion, "notion-fetch", true, value)).toBe("read");
    }
  });

  test("a recorded read cannot rescue a name the entry's server never advertised", () => {
    // Checked before either source, so the model-invented name is refused whatever the column says
    // and whatever the reviewed list says.
    expect(classifyTool(notion, "notion-fetch", false, "read")).toBe("write");
    expect(classifyTool(notion, "notion-invented", false, "read")).toBe(
      "write",
    );
  });
});
