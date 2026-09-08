import { describe, expect, test } from "bun:test";
import { inspectToolArguments } from "../src/plugins/content-governance";

describe("MCP tool argument content governance", () => {
  test("allows ordinary nested business data", () => {
    expect(
      inspectToolArguments({
        query: "quarterly report",
        filters: { ownerEmail: "owner@example.com", limit: 25 },
        rows: [{ customer: "Acme", amount: 1200 }],
      }),
    ).toEqual({ safe: true });
  });

  test("reports a sensitive field without returning its value", () => {
    const secret = "do-not-copy-this-value";
    const result = inspectToolArguments({ nested: { apiKey: secret } });

    expect(result).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [{ category: "credential_field", path: "$.nested.apiKey" }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("detects provider tokens embedded in otherwise ordinary text", () => {
    const result = inspectToolArguments({
      message: `please use sk-${"a".repeat(32)} for this request`,
    });

    expect(result).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [{ category: "provider_token", path: "$.message" }],
    });
  });

  test("detects authorization headers and private keys", () => {
    const result = inspectToolArguments({
      headers: ["Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"],
      material: "-----BEGIN PRIVATE KEY-----\nredacted",
    });

    expect(result).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [
        { category: "authorization_header", path: "$.headers[0]" },
        { category: "private_key", path: "$.material" },
      ],
    });
  });

  test("fails closed on cyclic in-process input", () => {
    const args: Record<string, unknown> = {};
    args.self = args;

    expect(inspectToolArguments(args)).toEqual({
      safe: false,
      reason: "inspection_limit",
      findings: [],
    });
  });
});
