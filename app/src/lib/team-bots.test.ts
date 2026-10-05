import { describe, expect, test } from "bun:test";
import { readTeamBotConsent, TEAM_BOT_CONSENT_MARKER } from "./team-bots";

describe("readTeamBotConsent", () => {
  test("reads the card from a consent refusal and nothing else", () => {
    expect(
      readTeamBotConsent(
        `${TEAM_BOT_CONSENT_MARKER}{"botId":"agent_1","serverId":"gmail"} This Team Bot wants to use your own gmail account.`,
      ),
    ).toEqual({
      botId: "agent_1",
      serverId: "gmail",
      message: "This Team Bot wants to use your own gmail account.",
    });
    expect(readTeamBotConsent("That tool is not granted.")).toBeNull();
    expect(readTeamBotConsent(`${TEAM_BOT_CONSENT_MARKER}{broken`)).toBeNull();
    expect(readTeamBotConsent(undefined)).toBeNull();
  });
});
