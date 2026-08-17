import { describe, expect, test } from "bun:test";
import { canRead } from "../src/knowledge/acl";

describe("knowledge ACL evaluation", () => {
  test("allows a matching user principal", () => {
    expect(
      canRead({ userId: "u1", groups: [] }, [
        { principal: "user:u1", effect: "allow" },
      ]),
    ).toBe(true);
  });

  test("fails closed for an unmatched or empty ACL", () => {
    expect(
      canRead({ userId: "u1", groups: ["finance"] }, [
        { principal: "group:engineering", effect: "allow" },
      ]),
    ).toBe(false);
    expect(canRead({ userId: "u1", groups: [] }, [])).toBe(false);
  });

  test("makes a matching deny override a matching allow", () => {
    expect(
      canRead({ userId: "u1", groups: ["finance"] }, [
        { principal: "group:finance", effect: "allow" },
        { principal: "user:u1", effect: "deny" },
      ]),
    ).toBe(false);
  });
});
