import { describe, expect, test } from "bun:test";
import {
  failedRunReason,
  laterRunFailure,
  stoppedReason,
  TURN_CUT_OFF,
} from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

/*
 * FOUND ON A PERSON'S 1.1.2 DESKTOP. The server stopped and started again in the middle of a long
 * turn of file saves. The run that would have carried the last save's result was never made, and the
 * failure was dropped as if the person had pressed Stop: the turn ended with nothing said.
 */
describe("a later run of a turn that fails", () => {
  test("says the turn was cut off when the backend couldn't be reached, and keeps what it did", () => {
    expect(
      laterRunFailure(new Error("REST run request failed: Failed to fetch")),
    ).toBe(TURN_CUT_OFF);
    expect(laterRunFailure(new TypeError("Failed to fetch"))).toBe(
      TURN_CUT_OFF,
    );
    // Not the first run's sentence: the message was sent and the Bot worked on it.
    expect(TURN_CUT_OFF).not.toContain("wasn't sent");
  });

  test("a run its server dropped, read back from the stored history, says the turn was cut off", () => {
    // The exact words the backend's event store ends such a run with.
    expect(stoppedReason("Runner connection dropped")).toBe(TURN_CUT_OFF);
  });

  /*
   * FOUND ON A CLOUD 1.2.0-rc.1 DOGFOOD. A Bot's connection to its model was cut part way, and the
   * run ended with the fetch's own words, shown in red word for word.
   */
  test("a run whose connection was cut says the turn was cut off, never the socket's words", () => {
    for (const said of [
      // Bun's fetch, exactly as the conversation showed it.
      "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      // Node's and undici's for the same.
      "socket hang up",
      "read ECONNRESET",
      "terminated",
      "other side closed",
    ]) {
      expect([said, stoppedReason(said)]).toEqual([said, TURN_CUT_OFF]);
      expect([said, laterRunFailure(new TypeError(said))]).toEqual([
        said,
        TURN_CUT_OFF,
      ]);
    }
    // A sentence that only mentions a connection is still passed on in its own words.
    expect(
      stoppedReason(
        "The connection to Claude dropped. Ask the Bot to carry on.",
      ),
    ).toBe("The connection to Claude dropped. Ask the Bot to carry on.");
  });

  test("passes on any other failure in its own words", () => {
    expect(laterRunFailure(new Error("The model refused the request."))).toBe(
      "The model refused the request.",
    );
  });

  test("says nothing about a run stopped here", () => {
    expect(
      laterRunFailure(
        new DOMException("The user aborted a request.", "AbortError"),
      ),
    ).toBeNull();
    expect(
      laterRunFailure(new Error("signal is aborted without reason")),
    ).toBeNull();
  });
});

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
    expect((await failedRunReason(refused, "pipeline-bot", gone)).message).toBe(
      "This Bot isn't shared with you any more, so your message wasn't sent. Its owner or an admin can share it again.",
    );
    // Joining its thread sends nothing, so nothing is said about a message.
    expect(
      (
        await failedRunReason(
          "REST connect request failed: Not found",
          "pipeline-bot",
          gone,
        )
      ).message,
    ).toBe(
      "This Bot isn't shared with you any more. Its owner or an admin can share it again.",
    );
    // Still theirs, or nobody could say: the back end is what failed, as before.
    for (const answer of [here, unknown])
      expect(
        (await failedRunReason(refused, "pipeline-bot", answer)).message,
      ).toBe(
        "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.",
      );
    // A Bot's own words are never second-guessed, whatever the server would say of the Bot.
    expect(
      (await failedRunReason("invalid x-api-key", "pipeline-bot", gone))
        .message,
    ).toBe("invalid x-api-key");
  });

  test("a run the server refused for the person says the server's sentence, not that the backend is unreachable", async () => {
    // An admin's model allowlist refused the run. The server answers a problem (RFC 9457) whose type
    // is OpenBot's own, and CopilotKit's Intelligence agent throws exactly this: its own prefix and
    // the body as it came, the 403 gone.
    const sentence =
      "This Bot uses openai/gpt-6.1-terra, which isn't an allowed model. Ask an admin to allow it.";
    const refused = new Error(
      `REST run request failed: {"type":"https://open.bot/errors/model-not-allowed","title":"That model isn't allowed.","status":403,"detail":"${sentence}","code":"MODEL_NOT_ALLOWED","category":"permission","retryable":false,"requestId":"req_6f1c2a9e-0b7d-4e57-9a43-1d2f3c4b5a69","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","error":"${sentence}"}`,
    );
    expect(stoppedReason(refused)).toBe(sentence);
    // The Bot is still theirs, and the server is not asked again: it already said why.
    let asked = false;
    expect(
      (
        await failedRunReason(refused, "general-assistant", async () => {
          asked = true;
          return false;
        })
      ).message,
    ).toBe(sentence);
    expect(asked).toBe(false);

    // "Use Bots" turned off for the person: the same gate's other refusal, read the same way.
    const capability =
      "Your admin hasn't turned on Use Bots for you. Ask an admin to turn it on.";
    expect(
      stoppedReason(
        `REST run request failed: {"type":"https://open.bot/errors/capability-required","title":"An admin hasn't turned this on for you.","status":403,"detail":"${capability}","code":"CAPABILITY_REQUIRED","category":"permission","retryable":false,"requestId":"req_1","traceId":"t1","capability":"useBots","error":"${capability}"}`,
      ),
    ).toBe(capability);

    // Anything else in a REST failure is still the backend failing, said in the person's terms: a
    // raw body, a problem that is not OpenBot's own, and a problem about a server fault.
    for (const body of [
      '{"error":"Failed to resolve Learning Container"}',
      '{"type":"about:blank","title":"Forbidden","status":403,"detail":"Failed to resolve Learning Container"}',
      '{"type":"https://open.bot/errors/internal-server-error","title":"Unexpected server error.","status":500,"detail":"Unexpected server error.","code":"INTERNAL_SERVER_ERROR"}',
      "not json at all",
    ])
      expect(stoppedReason(`REST run request failed: ${body}`)).toBe(
        "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.",
      );
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
