// server/tests/shared-accounts.test.ts
import { describe, expect, test } from "bun:test";
import {
  accountFor,
  asAccountMode,
  DEPLOYMENT_VENDOR_PREFIX,
  mintDeploymentVendorUserId,
} from "../src/plugins/shared-accounts";

const brokered = (accountMode: string | null, authScheme: string | null = "OAUTH2") => ({
  title: "GitHub",
  provenance: "composio",
  authScheme,
  accountMode,
});

describe("accountFor", () => {
  test("a personal app is reached as whoever the credential actor is", () => {
    expect(accountFor(brokered("personal"), "user_a")).toEqual({ kind: "person", userId: "user_a" });
  });

  test("a shared app is reached as the deployment whatever the credential actor", () => {
    expect(accountFor(brokered("shared"), "user_a")).toEqual({ kind: "deployment" });
    expect(accountFor(brokered("shared"), "owner_of_team_bot")).toEqual({ kind: "deployment" });
  });

  test("an app needing no account has no account in either mode", () => {
    expect(accountFor(brokered(null, "NO_AUTH"), "user_a")).toEqual({ kind: "none" });
    expect(accountFor(brokered("shared", "NO_AUTH"), "user_a")).toEqual({ kind: "none" });
  });

  test("a brokered app needing an account with no mode is refused, not guessed", () => {
    const answer = accountFor(brokered(null), "user_a");
    expect(answer.kind).toBe("ambiguous");
    if (answer.kind === "ambiguous") expect(answer.message).toMatch(/GitHub/);
  });

  test("a mode that is not one of the two is refused, not guessed", () => {
    expect(accountFor(brokered("team"), "user_a").kind).toBe("ambiguous");
  });
});

describe("asAccountMode", () => {
  test("reads the two modes and nothing else", () => {
    expect(asAccountMode("personal")).toBe("personal");
    expect(asAccountMode("shared")).toBe("shared");
    expect(asAccountMode("Shared")).toBeNull();
    expect(asAccountMode(undefined)).toBeNull();
  });
});

describe("mintDeploymentVendorUserId", () => {
  test("names the deployment and carries a random part", () => {
    expect(mintDeploymentVendorUserId("acme", () => "R4nd0m")).toBe(
      `${DEPLOYMENT_VENDOR_PREFIX}acme:R4nd0m`,
    );
  });

  test("two mints for the same deployment differ", () => {
    expect(mintDeploymentVendorUserId("acme")).not.toBe(mintDeploymentVendorUserId("acme"));
  });

  test("refuses a blank deployment id rather than minting a shared namespace", () => {
    expect(() => mintDeploymentVendorUserId("  ")).toThrow(/deployment/);
  });
});
