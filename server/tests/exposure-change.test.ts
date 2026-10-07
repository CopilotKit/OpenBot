import { describe, expect, test } from "bun:test";
import { afterExposureChange } from "../src/plugins/exposure-change";
import type { SharedUseStore } from "../src/plugins/shared-use-store";

const short = [{ serverId: "gh", title: "Team GitHub", needed: { audience: "team" as const, outsideInput: false, members: [] } }];
function fake() {
  const reapproved: string[] = [];
  const store = {
    shortfall: async () => short,
    reapprove: async (botId: string, by: string) => {
      reapproved.push(`${botId}:${by}`);
      return short.map(({ serverId, title }) => ({ serverId, title }));
    },
  } as unknown as SharedUseStore;
  return { store, reapproved };
}

describe("afterExposureChange", () => {
  test("an administrator's change approves the wider audience in the same request", async () => {
    const { store, reapproved } = fake();
    expect(await afterExposureChange(store, { id: "a1", role: "admin" }, "bot1")).toEqual({
      approved: [{ serverId: "gh", title: "Team GitHub" }], needsApproval: [],
    });
    expect(reapproved).toEqual(["bot1:a1"]);
  });

  test("an owner's change approves nothing and says what still needs an administrator", async () => {
    const { store, reapproved } = fake();
    expect(await afterExposureChange(store, { id: "u1", role: "user" }, "bot1")).toEqual({
      approved: [], needsApproval: [{ serverId: "gh", title: "Team GitHub" }],
    });
    expect(reapproved).toEqual([]);
  });

  test("a deployment without shared accounts reports nothing", async () => {
    expect(await afterExposureChange(undefined, { id: "a1", role: "admin" }, "bot1")).toEqual({ approved: [], needsApproval: [] });
  });
});
