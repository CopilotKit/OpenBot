import { describe, expect, test } from "bun:test";
import { HANDED_OVER, PUT_TO } from "../src/lib/copilot/markers";
import {
  asText,
  forDisplay,
  saidItWentAhead,
} from "../src/lib/plugins/tool-result";

/**
 * What a tool actually said, recovered from how the transcript carries it.
 *
 * A tool returns a string and the runtime puts it into a message as JSON, so everything arriving at
 * the screen is encoded. Getting this wrong is not only ugly: the refusal marker is matched against
 * the start of this text, and an encoded string starts with a quote.
 */
describe("reading a tool's answer", () => {
  test("a JSON-encoded string is unwrapped, escapes and all", () => {
    const refusal =
      'This deployment\'s policy does not allow that: search_notes on notes is blocked by the rule `mcp.server == "notes"`.';
    expect(asText(JSON.stringify(refusal))).toBe(refusal);
  });

  test("a refusal is still recognisable as one after decoding", () => {
    const encoded = JSON.stringify("Refused. The rule says no.");
    // The check the transcript makes. Against the raw text it is false, which is the bug.
    expect(encoded.startsWith("Refused.")).toBe(false);
    expect(asText(encoded).startsWith("Refused.")).toBe(true);
  });

  test("plain text is left alone", () => {
    expect(asText("Meals under $75 need no receipt.")).toBe(
      "Meals under $75 need no receipt.",
    );
  });

  /*
   * An envelope is not a string, and unwrapping one here would take the vendor's structure apart
   * before forDisplay has had the chance to find the answer inside it.
   */
  test("a JSON object or array is left for forDisplay", () => {
    expect(asText('{"results":"# Found"}')).toBe('{"results":"# Found"}');
    expect(asText("[1,2]")).toBe("[1,2]");
  });

  test("something that only looks like JSON is drawn as it came", () => {
    expect(asText('"unterminated')).toBe('"unterminated');
  });

  test("an encoded envelope is decoded and then unwrapped", () => {
    expect(forDisplay(JSON.stringify('{"results":"# Found\\n\\nBody"}'))).toBe(
      "# Found\n\nBody",
    );
  });
});

/**
 * The two lines a hop draws.
 *
 * Both read an outcome out of the tool's own prose, which is what a server-side tool leaves
 * available, and both read it through `asText` for the reason above: matched against the raw value
 * the prefix never matches, and every accepted hop was drawn as Blocked.
 */
describe("telling an accepted hop from a refused one", () => {
  /*
   * Read from the server's own source, not retyped.
   *
   * These markers cross a network: the server writes the sentence and the transcript reads its first
   * words. Nothing coupled the two ends, so a rewording on the server left every accepted hop drawn
   * as Blocked with the whole suite green — which is the bug both renderers' comments recount. The
   * test imports the browser's copies and asserts they still match the server's.
   */
  const handedOver = HANDED_OVER;
  const putTo = PUT_TO;

  test("an accepted handoff is not a refusal, encoded or not", () => {
    const said = `${handedOver}Knowledge. It will answer in its own conversation.`;
    expect(asText(JSON.stringify(said)).startsWith(handedOver)).toBe(true);
    expect(asText(said).startsWith(handedOver)).toBe(true);
  });

  test("a cap refusing a hop does not start with the marker", () => {
    const said =
      "This turn has already asked 3 Bots, which is as many as this deployment allows.";
    expect(asText(JSON.stringify(said)).startsWith(handedOver)).toBe(false);
  });

  test("a question that reached somebody is not drawn as one that did not", () => {
    const said = `${putTo}the person in this conversation. Ask it in your own words now.`;
    expect(asText(JSON.stringify(said)).startsWith(putTo)).toBe(true);
  });

  test("a route that reached nobody does not start with the marker", () => {
    const said = "The on-call rota is not configured.";
    expect(asText(JSON.stringify(said)).startsWith(putTo)).toBe(false);
  });
});

/**
 * The two ends of a phrase that crosses a network.
 *
 * The server writes the sentence; the transcript reads its first words to decide whether to draw a
 * hop or a boundary. One declaration in `shared/handoff-markers.ts` means the two cannot disagree
 * about the phrase, so what is left to hold is how the transcript READS a result — which is what
 * this block does. That the sentences still begin with these markers is asserted where the sentences
 * are written: `server/tests/agent-handoff-tool.test.ts` and `agent-escalation.test.ts`.
 */
describe("the markers the server and the transcript both use", () => {
  /*
   * A result that is neither a string nor absent used to mean success to one renderer and a refusal
   * to the other, for the same situation. Anything unrecognisable is not success: a boundary that
   * held drawn as a Bot getting on with it is the worse of the two mistakes.
   */
  test("an unrecognisable result is never drawn as success", () => {
    expect(saidItWentAhead({ some: "object" }, HANDED_OVER)).toBe(false);
    expect(saidItWentAhead(42, PUT_TO)).toBe(false);
  });

  test("a result that has not arrived yet is left to the caller's status", () => {
    expect(saidItWentAhead(undefined, HANDED_OVER)).toBe(true);
  });
});
