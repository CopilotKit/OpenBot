import { describe, expect, test } from "bun:test";
import {
  readConnectPrompt,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import type { AppAccess, AppAccessState } from "../src/plugins/app-access";
import { appAccessTools } from "../src/plugins/app-access-tool";
import type { AppInspection } from "../src/plugins/plugin-store/app-access";
import { PluginRefusedError, type PluginStore } from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";

/**
 * The tool every Bot holds for putting an app it cannot use in front of the person, and the Bot's
 * name on the refusals that already carried a card.
 *
 * The tool is a read: it asks the store what the app is for this person on this Bot and answers
 * with the card marker — the app, the Bot, `reason: "access"` — and a sentence for the model. It
 * never files a request; pressing the card does that, as the person.
 */

function access(state: AppAccessState): AppAccess {
  return {
    key: "composio-gmail",
    displayName: "Gmail",
    logo: null,
    provider: "composio",
    account: "personal",
    connect: "consent",
    authScheme: "OAUTH2",
    accountMode: "personal",
    state,
    unavailable: state === "disabled" ? "absent" : null,
    accountHolder: "you",
    asksFirst: false,
    granted:
      state !== "not_granted" &&
      state !== "disabled" &&
      state !== "owner_grantable",
    ownerGrants: "any",
    givenByOwner: false,
    needsConnect: false,
    connectedAt: null,
    requestKind: null,
    request: null,
  };
}

function toolOver(answer: AppAccess | null) {
  const asked: unknown[] = [];
  const [tool] = appAccessTools({
    store: {
      inspectApp: async (input) => {
        asked.push(input);
        return answer ? ({ access: answer } as unknown as AppInspection) : null;
      },
    },
    botId: "expenses",
    actorId: "usr_7",
    composioConfigured: true,
  });
  if (!tool) throw new Error("no tool");
  return { tool, asked };
}

describe("show_app_access", () => {
  test("is offered under its shared name, as a read anybody may hold", () => {
    const { tool } = toolOver(null);
    expect(tool.name).toBe(SHOW_APP_ACCESS_TOOL);
    expect(tool.description).toContain("instead of only saying it is missing");
  });

  test("asks about the app for this person on this Bot", async () => {
    const { tool, asked } = toolOver(access("disabled"));
    await tool.execute({ app: "Gmail" });
    expect(asked).toEqual([
      {
        app: "Gmail",
        agentId: "expenses",
        userId: "usr_7",
        composioConfigured: true,
        ownerGrantsAllowed: true,
      },
    ]);
  });

  test.each([
    ["ready", /ready for this person to use through you/],
    ["not_connected", /offers Connect/],
    ["reconnect", /offers Reconnect/],
    ["shared_not_connected", /ask an administrator for it/],
    ["disabled", /switched off on this deployment/],
    ["not_granted", /you have not been granted it/],
    ["owner_grantable", /can give it to you themselves/],
  ] as const)(
    "answers %s with the card marker and the state in words",
    async (state, said) => {
      const { tool } = toolOver(access(state));
      const answer = await tool.execute({ app: "gmail" });
      // Not a refusal: the transcript reads this tool's ordinary answer for its card.
      expect(answer.startsWith(REFUSAL_MARKER)).toBe(false);
      const prompt = readConnectPrompt(answer);
      expect(prompt).toMatchObject({
        serverId: "composio-gmail",
        title: "Gmail",
        agentId: "expenses",
        reason: "access",
        blocked: state !== "ready",
      });
      expect(prompt?.message).toMatch(said);
      expect(prompt?.message).toContain("Do not browse to its website");
    },
  );

  test("an app nobody can name gets a plain sentence and no card", async () => {
    const { tool } = toolOver(null);
    const answer = await tool.execute({ app: "Frobnicator" });
    expect(readConnectPrompt(answer)).toBeNull();
    expect(answer).toContain("no app called Frobnicator");
  });

  test("arguments that name no app are refused before the store is asked", async () => {
    const { tool, asked } = toolOver(access("ready"));
    expect(await tool.execute({})).toBe("Name the app to show.");
    expect(await tool.execute({ app: "   " })).toBe("Name the app to show.");
    expect(asked).toEqual([]);
  });
});

describe("a refusal carrying a card, on its way to the model", () => {
  async function refusedWith(message: string) {
    const [tool] = await grantedTools({
      store: {
        callTool: async () => {
          throw new PluginRefusedError(message, null);
        },
        listForAgent: async () => ({
          tools: [
            {
              toolName: "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
              ref: "composio-gmail/GMAIL_FETCH_EMAILS",
              description: "Fetch mail.",
              inputSchema: { type: "object" },
            },
          ],
        }),
      } as unknown as PluginStore,
      botId: "expenses",
      actorId: "usr_7",
    });
    return (await tool?.execute({})) ?? "";
  }

  test("names the Bot that refused, so the card asks about the right one", async () => {
    const answer = await refusedWith(
      '[connect-app]{"serverId":"composio-gmail","title":"Gmail","reason":"shared"} Gmail uses a shared account, and nobody has connected it yet. Ask an admin to connect it.',
    );
    expect(answer.startsWith(`${REFUSAL_MARKER} `)).toBe(true);
    expect(
      readConnectPrompt(answer.slice(REFUSAL_MARKER.length).trim()),
    ).toMatchObject({ agentId: "expenses", reason: "shared" });
  });

  test("leaves an ordinary refusal exactly as it was", async () => {
    expect(await refusedWith("That tool is not granted.")).toBe(
      `${REFUSAL_MARKER} That tool is not granted.`,
    );
  });
});
