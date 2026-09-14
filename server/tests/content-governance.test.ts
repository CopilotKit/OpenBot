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

  test("blocks a credential field carrying the conventional non-standard header prefix", () => {
    const secret = "do-not-copy-this-value";
    const result = inspectToolArguments({
      headers: { "x-api-key": secret },
    });

    expect(result).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [{ category: "credential_field", path: "$.headers.x-api-key" }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test.each([
    "X-API-Key",
    "x-auth-token",
    "authToken",
    "auth_token",
    "api_secret",
    "bearer_token",
    "passwd",
    "pwd",
    "secret_key",
    "session_token",
    "signing_key",
    "ssh_key",
  ])("blocks %s as a spelling of a name already listed", (field) => {
    const result = inspectToolArguments({ [field]: "do-not-copy-this-value" });

    expect(result).toMatchObject({ safe: false, reason: "sensitive_content" });
    expect(result).toMatchObject({
      findings: [{ category: "credential_field" }],
    });
  });

  test.each([
    "query",
    "url",
    "path",
    "token_count",
    "max_tokens",
    "tokenizer",
    "x_axis",
    "x_offset",
    "xml",
    "secretary",
  ])("allows %s, which only resembles a credential name", (field) => {
    expect(inspectToolArguments({ [field]: "ordinary value" })).toEqual({
      safe: true,
    });
  });

  test.each([
    "Basic onboarding checklist",
    "basic setup guide",
    "Basic auth broken on staging",
    "  basic training for new hires",
    "Bearer of bad news: the launch slips a week",
    "Bearer responsibilities",
  ])(
    "allows %s, which only starts with an authorization scheme name",
    (text) => {
      expect(inspectToolArguments({ title: text })).toEqual({ safe: true });
    },
  );

  test.each([
    ["a Basic credential", `Basic ${btoa("aladdin:open sesame")}`],
    ["a lowercase basic credential", `basic ${btoa("user:pass")}`],
    [
      "a Bearer token followed by text",
      "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature is the one to use",
    ],
    ["an opaque bearer token", `bearer ${"a1".repeat(12)}`],
    ["a bearer token with no digits", "Bearer QmFzZVRva2VuV2l0aE5vRGlnaXRz"],
  ])("still refuses %s", (_label, value) => {
    expect(inspectToolArguments({ value })).toEqual({
      safe: false,
      reason: "sensitive_content",
      findings: [{ category: "authorization_header", path: "$.value" }],
    });
  });
});
