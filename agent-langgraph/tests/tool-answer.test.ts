import { describe, expect, test } from "bun:test";
import { toolAnswer } from "../src/tool-answer";

/**
 * What the model is told a governed tool call came back with.
 *
 * Driven with hand-built responses rather than a deployment, because the thing worth pinning is the
 * reading: the three answers `/api/agent-tools/call` can give — a result, a refusal before any grant
 * was consulted, and a malformed call — and what each becomes in front of the model.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("what a tool call came back with", () => {
  test("a result reaches the model as the deployment wrote it", async () => {
    expect(await toolAnswer(json({ text: "found 3", isError: false }))).toBe(
      "found 3",
    );
  });

  test("a refusal the store made is passed on untouched, marker and all", async () => {
    const text =
      "Refused. No grant lets this Bot use google-drive/search_files.";
    expect(await toolAnswer(json({ text, isError: true }))).toBe(text);
  });

  test("a callback the deployment would not accept is a refusal, not an empty result", async () => {
    // The shape of a Bot holding a token the deployment no longer accepts: every call answers 401
    // with the reason under `error` and no `text`. Told "the tool returned nothing", the model tells
    // the person nothing was found.
    const answer = await toolAnswer(json({ error: "Not authorised." }, 401));
    expect(answer).not.toBe("The tool returned nothing.");
    expect(answer.startsWith("Refused.")).toBe(true);
    expect(answer).toContain("401");
    expect(answer).toContain("Not authorised.");
  });

  test("a token issued to another Bot is a refusal that says so", async () => {
    const answer = await toolAnswer(
      json({ error: "That token is not for this Bot." }, 403),
    );
    expect(answer.startsWith("Refused.")).toBe(true);
    expect(answer).toContain("That token is not for this Bot.");
  });

  test("a failure with no readable body still says it failed", async () => {
    const answer = await toolAnswer(
      new Response("<html>Bad Gateway</html>", { status: 502 }),
    );
    expect(answer).not.toBe("The tool returned nothing.");
    expect(answer.startsWith("Refused.")).toBe(true);
    expect(answer).toContain("502");
  });
});
