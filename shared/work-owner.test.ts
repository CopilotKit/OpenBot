import { describe, expect, test } from "bun:test";
import { workOwner } from "./work-owner";

describe("who a process says it is when it takes a lease", () => {
  test("two processes on one host never share an owner", () => {
    const environment = { HOSTNAME: "laptop" };
    expect(workOwner("routines", environment)).not.toBe(
      workOwner("routines", environment),
    );
  });

  test("a blank HOSTNAME is not a name, and never becomes the whole owner", () => {
    for (const HOSTNAME of ["", "   ", undefined]) {
      const owner = workOwner("handoff", { HOSTNAME });
      expect(owner).not.toBe("handoff/");
      expect(owner.startsWith("handoff/")).toBe(true);
      expect(owner.length).toBeGreaterThan("handoff/".length);
    }
  });

  test("keeps the host in the name, so a stuck claim still traces back to it", () => {
    expect(workOwner("culler", { HOSTNAME: "pod-7" })).toMatch(
      /^culler\/pod-7-[0-9a-f]{8}$/,
    );
  });

  test("names the role it was asked for", () => {
    expect(workOwner("summariser", { HOSTNAME: "h" })).toStartWith(
      "summariser/",
    );
  });
});
