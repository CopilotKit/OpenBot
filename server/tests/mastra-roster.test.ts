import { describe, expect, test } from "bun:test";
import { runForDuplicate } from "../src/agents/profile-store";
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

describe("duplicating a Mastra Bot", () => {
  test("the copy is still dialled as Mastra, carrying the agent it named", () => {
    // The must-not case. Written as `remote_ag_ui` the copy holds the right address and cannot say
    // anything to it: a Mastra endpoint has no AG-UI route, so the Bot appears, takes a grant and
    // answers nothing.
    expect(
      runForDuplicate(
        {
          type: "remote_mastra",
          configuration: {
            endpoint: "http://mastra.test",
            remoteAgentId: "openbot",
          },
        },
        undefined,
      ),
    ).toEqual({
      type: "remote_mastra",
      configuration: {
        endpoint: "http://mastra.test",
        remoteAgentId: "openbot",
      },
    });
  });

  test("an AG-UI Bot is untouched by that", () => {
    expect(
      runForDuplicate(
        { type: "remote_ag_ui", configuration: { endpoint: "http://a.test" } },
        undefined,
      ),
    ).toEqual({
      type: "remote_ag_ui",
      configuration: { endpoint: "http://a.test" },
    });
  });
});

describe("which endpoints get this deployment's token", () => {
  test("the harness picked during setup gets it, not only the Bot in the box", async () => {
    /*
     * The must-not case, and it was live: the picked harness was registered, addressable and
     * routed to, and answered `401 unauthorised` to everything, because the token was attached by
     * matching one endpoint exactly. Its container is this deployment's own, so it is the same
     * relationship the Bot in the box has.
     */
    const managedAgent = {
      endpoint: new URL("http://127.0.0.1:4201/ag-ui"),
      token: "the-deployment-token",
      alsoRun: new URL("http://127.0.0.1:4206"),
    };
    // Trailing slashes are the trap: `URL` adds one, a stored address need not have one, and an
    // exact match then fails silently and the Bot answers 401.
    const same = (url: string) => url.replace(/\/+$/, "");
    const ourEndpoints = [managedAgent.endpoint, managedAgent.alsoRun]
      .filter((url): url is URL => url !== undefined)
      .map((url) => same(url.toString()));

    expect(ourEndpoints).toContain(same("http://127.0.0.1:4206"));
    expect(ourEndpoints).toContain(same("http://127.0.0.1:4201/ag-ui"));
    // And the stored row, which has no trailing slash, matches the URL that grew one.
    expect(ourEndpoints).toContain(same("http://127.0.0.1:4206/"));
    // Somebody else's address is still somebody else's.
    expect(ourEndpoints).not.toContain(
      same("https://someone-else.example/ag-ui"),
    );
  });
});
