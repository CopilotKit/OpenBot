import { describe, expect, test } from "bun:test";
import {
  failedRunReason,
  stoppedReason,
} from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

describe("the reason a turn ended", () => {
  test("passes on what ended the turn, in its own words", () => {
    expect(
      stoppedReason(
        "Risk Analyst stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toContain("Risk Analyst stopped responding");
  });

  test("reads an Error the same way, because a failed run carries one", () => {
    expect(
      stoppedReason(new Error("The endpoint refused the connection")),
    ).toBe("The endpoint refused the connection");
  });

  test("says OpenBot couldn't reach its backend, not the raw request failure", () => {
    // The exact text a teammate saw on OpenBot 1.0.0, built by CopilotKit's Intelligence agent when
    // the run request to the runtime fails.
    const run = stoppedReason(
      new Error(
        'REST run request failed: {"error":"Failed to resolve Learning Container"}',
      ),
    );
    expect(run).toBe(
      "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.",
    );

    // The same failure on joining a thread, which sends nothing.
    const connect = stoppedReason(
      "REST connect request failed: Failed to fetch",
    );
    expect(connect).toBe(
      "OpenBot couldn't reach its backend. Try again, or quit and reopen OpenBot.",
    );

    for (const shown of [run, connect]) {
      expect(shown).not.toContain("REST");
      expect(shown).not.toContain("{");
      expect(shown).not.toContain("Learning Container");
    }
  });

  test("a refused request says the Bot isn't shared any more only when the server says the Bot is gone", async () => {
    const gone = async () => true;
    const here = async () => false;
    const unknown = async (): Promise<boolean> => {
      throw new Error("Failed to fetch");
    };
    // The runtime's refusal of a Bot that is not the person's, as CopilotKit's Intelligence agent
    // reports it: the same shape as a back end that is down.
    const refused = new Error(
      `REST run request failed: {"error":"Agent not found","message":"Agent 'pipeline-bot' does not exist"}`,
    );
    expect(await failedRunReason(refused, "pipeline-bot", gone)).toBe(
      "This Bot isn't shared with you any more, so your message wasn't sent. Its owner or an admin can share it again.",
    );
    // Joining its thread sends nothing, so nothing is said about a message.
    expect(
      await failedRunReason(
        "REST connect request failed: Not found",
        "pipeline-bot",
        gone,
      ),
    ).toBe(
      "This Bot isn't shared with you any more. Its owner or an admin can share it again.",
    );
    // Still theirs, or nobody could say: the back end is what failed, as before.
    for (const answer of [here, unknown])
      expect(await failedRunReason(refused, "pipeline-bot", answer)).toBe(
        "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.",
      );
    // A Bot's own words are never second-guessed, whatever the server would say of the Bot.
    expect(
      await failedRunReason("invalid x-api-key", "pipeline-bot", gone),
    ).toBe("invalid x-api-key");
  });

  test("says so plainly when nothing was reported, rather than inventing a cause", () => {
    // This is the one moment a person has no other way to find out what went wrong, so a guess here
    // would be worse than an admission.
    expect(stoppedReason(undefined)).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason("")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason("   ")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason(new Error(""))).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason({ message: "not a string or an Error" })).toBe(
      "The Bot stopped without saying why.",
    );
  });
});
