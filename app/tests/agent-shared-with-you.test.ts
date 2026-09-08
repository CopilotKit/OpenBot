import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@/lib/agents/queries";
import { isSharedWithYou } from "@/lib/agents/queries";

/**
 * "Shared with you" on the roster (`/`) and the browse screen (`/agents`) is one rule, not two
 * copies of the same expression: a coworker somebody else made public. Your own coworkers do not
 * count, however visible, and a private coworker of somebody else's does not count either.
 */

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: "agent_1",
    name: "Renewal Desk",
    title: "Accounts Receivable",
    roleDescription: "Chase overdue invoices.",
    avatarSeed: "renewal-desk",
    visibility: "public",
    endpoint: null,
    builtIn: false,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: false,
    canManage: false,
    mine: false,
    ...overrides,
  };
}

describe("an agent shared with you", () => {
  test("your own agent does not qualify, however visible", () => {
    expect(isSharedWithYou(agent({ mine: true, visibility: "public" }))).toBe(
      false,
    );
  });

  test("a public agent belonging to someone else qualifies", () => {
    expect(isSharedWithYou(agent({ mine: false, visibility: "public" }))).toBe(
      true,
    );
  });

  test("a private agent belonging to someone else does not qualify", () => {
    expect(isSharedWithYou(agent({ mine: false, visibility: "private" }))).toBe(
      false,
    );
  });
});
