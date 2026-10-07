import { describe, expect, test } from "bun:test";
import { createMemoryIngestion } from "../src/memory/ingestion";

const tool = { ref: "gh/GITHUB_LIST_ISSUES", effect: "read", destructive: false };
const server = (accountMode: string | null) => ({
  id: "gh", title: "Team GitHub", provenance: "composio", url: "composio://gh", authScheme: "OAUTH2", accountMode, tools: [tool],
});
function ingestionFor(options: { accountMode: string | null; sharedConnected: boolean; personal: boolean }) {
  const plugins = {
    agentOwner: async () => "owner",
    listForAgent: async () => ({ tools: [tool] }),
    listServers: async () => [server(options.accountMode)],
    connectionsFor: async () => [],
    brokeredConnectionsFor: async () => (options.personal ? [{ serverId: "gh" }] : []),
    deploymentConnectionFor: async () => (options.sharedConnected ? { connectedAt: "x" } : null),
    callTool: async () => ({ text: "[]", isError: false }),
  };
  return createMemoryIngestion({ store: {} as never, plugins: plugins as never });
}

describe("a memory source on a Shared app", () => {
  test("needs the deployment's account, not the owner's", async () => {
    const ingestion = ingestionFor({ accountMode: "shared", sharedConnected: true, personal: false });
    await expect(ingestion.authorize({ ownerUserId: "owner", agentId: "bot", toolRef: tool.ref })).resolves.toBeDefined();
  });

  test("is refused, naming the shared account, when nobody has connected it", async () => {
    const ingestion = ingestionFor({ accountMode: "shared", sharedConnected: false, personal: true });
    await expect(ingestion.authorize({ ownerUserId: "owner", agentId: "bot", toolRef: tool.ref }))
      .rejects.toThrow(/Team GitHub is shared and no account is connected to it yet/);
  });

  test("a Personal app still needs the owner's own account", async () => {
    const ingestion = ingestionFor({ accountMode: "personal", sharedConnected: true, personal: false });
    await expect(ingestion.authorize({ ownerUserId: "owner", agentId: "bot", toolRef: tool.ref }))
      .rejects.toThrow(/Reconnect this app/);
  });
});
