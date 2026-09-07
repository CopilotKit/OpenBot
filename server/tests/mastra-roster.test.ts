import { describe, expect, test } from "bun:test";
import { pickFromRoster } from "../src/copilot";

describe("which agent on a Mastra server a Bot means", () => {
  test("the name it asks for, when the endpoint serves it", () => {
    expect(
      pickFromRoster(["research", "openbot"], {
        id: "bot-7",
        remoteAgentId: "openbot",
      }),
    ).toBe("openbot");
  });

  test("its own id, for a server that names the agent after the Bot", () => {
    expect(pickFromRoster(["bot-7", "other"], { id: "bot-7" })).toBe("bot-7");
  });

  test("the only agent on a single-agent server, when no name was asked for", () => {
    expect(pickFromRoster(["openbot"], { id: "bot-7" })).toBe("openbot");
  });

  test("a name that was asked for is never replaced by the only agent present", () => {
    // The must-not case. Falling back here turns a typo into a Bot that runs and answers as
    // somebody else, which is indistinguishable from a bad model at the point somebody notices.
    expect(() =>
      pickFromRoster(["openbot"], { id: "bot-7", remoteAgentId: "typo" }),
    ).toThrow(/serves no agent named "typo"/);
  });

  test("several agents and no name asked for is refused, not guessed", () => {
    expect(() => pickFromRoster(["a", "b"], { id: "bot-7" })).toThrow(
      /It serves: a, b/,
    );
  });

  test("an endpoint serving nothing says so", () => {
    expect(() => pickFromRoster([], { id: "bot-7" })).toThrow(
      /It serves: none/,
    );
  });
});
