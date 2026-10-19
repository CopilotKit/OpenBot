import { afterEach, describe, expect, test } from "bun:test";
import {
  callTool,
  listNeedsCredential,
  listTools,
  useLinearTools,
} from "../src/plugins/builtin-linear";

const CONNECTION = { url: "builtin://agentforce-linear/" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  useLinearTools(null);
  globalThis.fetch = originalFetch;
});

describe("AgentForce Linear transport", () => {
  test("advertises chat Linear tools without per-user credentials", async () => {
    expect(listNeedsCredential).toBe(false);
    const names = (await listTools()).map((tool) => tool.name);
    expect(names).toEqual([
      "get_linear_viewer",
      "get_linear_issue",
      "list_linear_issues",
      "create_linear_issue",
      "assign_linear_issue_to_me",
    ]);
  });

  test("refuses calls when Linear is not installed on the server", async () => {
    useLinearTools(null);
    const result = await callTool(CONNECTION, "get_linear_viewer", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("LINEAR_API_KEY");
  });

  test("get_linear_viewer returns the API key owner", async () => {
    useLinearTools({ apiKey: "lin_api_test" });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            viewer: { id: "u1", name: "API User", email: "api@example.com" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await callTool(CONNECTION, "get_linear_viewer", {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain("API User");
    expect(result.text).toContain("api@example.com");
  });
});
