import { describe, expect, test } from "bun:test";
import { asText, forDisplay } from "../src/lib/plugins/tool-result";

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
  const handedOver = "Handed to ";
  const putTo = "Put to ";

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
