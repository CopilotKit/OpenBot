import { expect, test } from "bun:test";
import { withVoiceContext } from "../src/lib/voice/agent-bridge";

test("voice history reaches the run as agent-scoped application context and is removed afterwards", async () => {
  const contexts = new Map<
    string,
    { description: string; value: string; agentIds?: string[] }
  >();
  const host = {
    addContext(value: {
      description: string;
      value: string;
      agentIds?: string[];
    }) {
      contexts.set("voice", value);
      return "voice";
    },
    removeContext(id: string) {
      contexts.delete(id);
    },
  };
  for (const fail of [false, true]) {
    const run = withVoiceContext(
      host,
      "channel-agent",
      "The title is Midnight Espresso.",
      async () => {
        expect(contexts.get("voice")?.agentIds).toEqual(["channel-agent"]);
        expect(contexts.get("voice")?.value).toContain("Midnight Espresso");
        expect(contexts.get("voice")?.description).toContain("quoted data");
        if (fail) throw new Error("Run failed");
        return "Midnight Espresso";
      },
    );
    if (fail) await expect(run).rejects.toThrow("Run failed");
    else expect(await run).toBe("Midnight Espresso");
    expect(contexts.size).toBe(0);
  }
});
