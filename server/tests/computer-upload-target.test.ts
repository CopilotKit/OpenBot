import { describe, expect, test } from "bun:test";
import { workspaceUploadTargetFromMcp } from "../src/computer/upload-target";

const token = "server-only-token";
const transferId = "11111111-1111-4111-8111-111111111111";

describe("a fixed workspace upload target", () => {
  test.each([
    "http://erp.test/api/mcp",
    "https://user:pass@erp.test/api/mcp",
    "https://erp.test/path",
    "https://erp.test/api/mcp?query=yes",
    "https://erp.test/api/mcp#fragment",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() => workspaceUploadTargetFromMcp(origin, token)).toThrow();
  });

  test("derives the only permitted ERP path", () => {
    const target = workspaceUploadTargetFromMcp(
      "https://erp.test/api/mcp",
      token,
    );
    expect(target.pathFor(transferId)).toBe(
      `/api/agent-transfers/${transferId}`,
    );
  });
});
