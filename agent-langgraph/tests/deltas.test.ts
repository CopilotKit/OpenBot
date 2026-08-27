import { describe, expect, test } from "bun:test";
import { textOfChunk } from "../src/deltas";

/**
 * The Responses API streams content blocks, not a string.
 *
 * This is why the framework Bot "answers nothing at all on gpt-5.6-* through the Responses API:
 * RUN_STARTED, then RUN_FINISHED, no text" — the note `.env.example` and `docker-compose.yml` both
 * carry today. The run read `chunk.content` as a string and dropped everything that was not one, and
 * on that API it is never one: `@langchain/openai` converts each `response.output_text.delta` into
 * `[{ type: "text", text: delta, index }]`.
 *
 * Chat completions still hands back a plain string, so both shapes have to work.
 */
describe("text of a streamed chunk", () => {
  test("reads a chat-completions string", () => {
    expect(textOfChunk("Hello")).toBe("Hello");
  });

  test("reads a Responses API text block", () => {
    expect(textOfChunk([{ type: "text", text: "Hello", index: 0 }])).toBe(
      "Hello",
    );
  });

  test("joins the blocks of one chunk in order", () => {
    expect(
      textOfChunk([
        { type: "text", text: "Hel", index: 0 },
        { type: "text", text: "lo", index: 1 },
      ]),
    ).toBe("Hello");
  });

  test("leaves reasoning out of what the person is shown", () => {
    /*
     * A reasoning model streams its summary in the same content array. It is not the answer, and a
     * surface that printed it would be showing the person the Bot's private working — so only text
     * blocks are read, and the block type is what decides, not its position.
     */
    expect(
      textOfChunk([
        { type: "reasoning", reasoning: "the person greeted me, so", index: 0 },
        { type: "text", text: "Hello", index: 1 },
      ]),
    ).toBe("Hello");
  });

  test("ignores blocks carrying no text of their own", () => {
    // Annotations arrive as a text block with an empty string, and a tool call carries no text at
    // all. Neither should open a message on the surface.
    expect(
      textOfChunk([
        { type: "text", text: "", annotations: [{}], index: 0 },
        { type: "tool_call_chunk", index: 1 },
      ]),
    ).toBe("");
  });

  test("says nothing for content it does not recognise", () => {
    expect(textOfChunk(undefined)).toBe("");
    expect(textOfChunk(null)).toBe("");
    expect(textOfChunk(42)).toBe("");
    expect(textOfChunk([{ text: "no type" }])).toBe("");
  });
});
