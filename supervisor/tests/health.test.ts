import { describe, expect, test } from "bun:test";
import { healthOf } from "../src/health";

describe("reading a container's healthcheck from its status line", () => {
  test.each([
    ["Up 3 seconds (health: starting)", "starting"],
    ["Up 5 minutes (healthy)", "healthy"],
    ["Up 1 minute (unhealthy)", "unhealthy"],
    ["Up 2 hours", undefined],
    ["Exited (0) 3 minutes ago", undefined],
    [undefined, undefined],
  ] as const)("%s", (status, expected) => {
    expect(healthOf(status)).toBe(expected);
  });
});
