import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchLinearIssueByIdentifier,
  fetchLinearViewer,
  formatIssueSummary,
} from "../src/linear/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Linear GraphQL client", () => {
  test("fetchLinearViewer returns the viewer from GraphQL data", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              id: "u1",
              name: "Onifade Kehinde",
              email: "onifade@example.com",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const viewer = await fetchLinearViewer("lin_api_test");
    expect(viewer).toEqual({
      id: "u1",
      name: "Onifade Kehinde",
      email: "onifade@example.com",
    });
  });

  test("fetchLinearIssueByIdentifier rejects malformed identifiers", async () => {
    await expect(
      fetchLinearIssueByIdentifier("lin_api_test", "424"),
    ).rejects.toThrow("Expected a Linear identifier");
  });

  test("fetchLinearIssueByIdentifier maps issue fields", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "iss-1",
              identifier: "ORC-424",
              title: "Ship Linear tools",
              url: "https://linear.app/orc/issue/ORC-424",
              state: { name: "In Progress" },
              assignee: {
                name: "Onifade Kehinde",
                email: "onifade@example.com",
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const issue = await fetchLinearIssueByIdentifier("lin_api_test", "orc-424");
    expect(issue.identifier).toBe("ORC-424");
    expect(issue.state).toBe("In Progress");
    expect(formatIssueSummary(issue)).toContain("ORC-424");
    expect(formatIssueSummary(issue)).toContain("Onifade Kehinde");
  });
});
