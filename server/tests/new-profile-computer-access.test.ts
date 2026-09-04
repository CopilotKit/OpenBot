import { describe, expect, test } from "bun:test";
import { newProfileConfiguration } from "../src/agents/profile-store";

describe("new profile computer configuration", () => {
  test("a created profile persists an explicit disabled entitlement", () => {
    expect(
      newProfileConfiguration({
        endpoint: "https://managed.example.test/ag-ui",
        auth: { credentialId: "credential-created" },
      }),
    ).toEqual({
      endpoint: "https://managed.example.test/ag-ui",
      auth: { credentialId: "credential-created" },
      computerAccess: "disabled",
    });
  });

  test("a duplicated profile persists an explicit disabled entitlement", () => {
    expect(
      newProfileConfiguration({
        endpoint: "https://managed.example.test/ag-ui",
      }),
    ).toEqual({
      endpoint: "https://managed.example.test/ag-ui",
      computerAccess: "disabled",
    });
  });
});
