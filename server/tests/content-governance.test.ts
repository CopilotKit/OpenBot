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

  test("detects credential material in a property name without recording it", () => {
    const secret = `ghp_${"a".repeat(32)}`;
    const result = inspectToolArguments({
      nested: { [secret]: "ordinary value" },
    });

    expect(result).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [
        {
          category: "provider_token",
          path: "$.nested.[property]",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("does not copy arbitrary property names into audit-safe paths", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nredacted";
    const result = inspectToolArguments({
      "customer@example.com": { material: privateKey },
    });

    expect(result).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [{ category: "private_key", path: "$.[property].material" }],
    });
    expect(JSON.stringify(result)).not.toContain("customer@example.com");
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

  test("fails closed before scanning oversized strings or property names", () => {
    const oversized = "a".repeat(64 * 1024 + 1);

    expect(inspectToolArguments({ text: oversized })).toEqual({
      safe: false,
      reason: "inspection_limit",
      findings: [],
    });
    expect(inspectToolArguments({ [oversized]: "value" })).toEqual({
      safe: false,
      reason: "inspection_limit",
      findings: [],
    });
  });
});
