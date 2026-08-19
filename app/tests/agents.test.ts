import { describe, expect, test } from "bun:test";
import { agentFormSchema } from "@/lib/agents/form";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";

describe("coworker query keys", () => {
  test("separates the visible roster from the hidden one", () => {
    expect(agentKeys.list()).toEqual(["agents", "list", { hidden: false }]);
    expect(agentKeys.list(true)).toEqual(["agents", "list", { hidden: true }]);
    // Both lists and every profile sit under one prefix, so a mutation can invalidate all of them.
    expect(agentKeys.detail("agent_1")[0]).toBe(agentKeys.all[0]);
    expect(channelKeys.detail("channel_1")).toEqual([
      "channels",
      "detail",
      "channel_1",
    ]);
  });
});

describe("coworker form validation", () => {
  test("accepts the fields a person fills in", () => {
    expect(
      agentFormSchema.parse({
        name: "  Expense Manager  ",
        title: "Finance Operations",
        roleDescription: "Review receipts and prepare reimbursement reports.",
        visibility: "private",
        endpoint: "",
        authValue: "",
      }).name,
    ).toBe("Expense Manager");
  });

  test("an endpoint is optional, and must look like a web address", () => {
    const valid = {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private" as const,
      authValue: "",
    };
    // Empty means the Bot in the box, which is what most people want first time.
    expect(agentFormSchema.safeParse({ ...valid, endpoint: "" }).success).toBe(
      true,
    );
    expect(
      agentFormSchema.safeParse({
        ...valid,
        endpoint: "https://agents.example.com/ag-ui",
      }).success,
    ).toBe(true);
    // Shape only. WHETHER an address is allowed is the server's decision, because it depends on the
    // deployment and a check that lives in a browser is a check an attacker skips.
    expect(
      agentFormSchema.safeParse({ ...valid, endpoint: "not a url" }).success,
    ).toBe(false);
  });

  test("rejects what the server would reject", () => {
    const valid = {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private" as const,
      endpoint: "",
      authValue: "",
    };

    expect(agentFormSchema.safeParse({ ...valid, name: "   " }).success).toBe(
      false,
    );
    expect(
      agentFormSchema.safeParse({ ...valid, name: "n".repeat(81) }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({ ...valid, title: "t".repeat(121) }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({
        ...valid,
        roleDescription: "r".repeat(1001),
      }).success,
    ).toBe(false);
    expect(
      agentFormSchema.safeParse({ ...valid, visibility: "everyone" }).success,
    ).toBe(false);
  });
});
