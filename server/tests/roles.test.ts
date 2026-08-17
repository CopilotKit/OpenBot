import { describe, expect, test } from "bun:test";
import { roleForEmail } from "../src/auth/roles";

describe("roleForEmail", () => {
  test("assigns an admin role to allowlisted addresses without case sensitivity", () => {
    expect(roleForEmail("Admin@OpenBot.test", ["admin@openbot.test"])).toBe(
      "admin",
    );
  });

  test("assigns the user role to addresses outside the initial admin allowlist", () => {
    expect(roleForEmail("member@openbot.test", ["admin@openbot.test"])).toBe(
      "user",
    );
  });
});
