import { describe, expect, test } from "bun:test";
import { parseWorkspaceUploadTarget } from "../src/computer/upload-target";

const token = "server-only-token";
const transferId = "11111111-1111-4111-8111-111111111111";

describe("a fixed workspace upload target", () => {
  test.each([
    "http://erp.test",
    "https://user:pass@erp.test",
    "https://erp.test/path",
    "https://erp.test/?query=yes",
    "https://erp.test/#fragment",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() => parseWorkspaceUploadTarget(origin, token)).toThrow();
  });

  test("derives the only permitted ERP path", () => {
    const target = parseWorkspaceUploadTarget("https://erp.test", token);
    expect(target.pathFor(transferId)).toBe(
      `/api/agent-transfers/${transferId}`,
    );
  });
});
