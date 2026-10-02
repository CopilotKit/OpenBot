import { describe, expect, test } from "bun:test";
import { streamPathBotId } from "../src/computer/stream-path";

describe("which Bot a stream path names", () => {
  test("a plain id reads as itself", () => {
    expect(streamPathBotId("/api/computers/my-bot/stream")).toBe("my-bot");
  });

  test("a percent-encoded id decodes", () => {
    expect(streamPathBotId("/api/computers/my%20bot/stream")).toBe("my bot");
  });

  test("a malformed escape is not a Bot id, not a 500", () => {
    expect(streamPathBotId("/api/computers/%zz/stream")).toBeNull();
    expect(streamPathBotId("/api/computers/%E2%28/stream")).toBeNull();
  });

  test("other paths name no Bot", () => {
    expect(streamPathBotId("/api/computers/my-bot/files")).toBeNull();
    expect(streamPathBotId("/api/computers/stream")).toBeNull();
    expect(streamPathBotId("/")).toBeNull();
  });
});
