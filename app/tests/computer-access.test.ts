import { describe, expect, test } from "bun:test";
import { canOfferComputerTools } from "../src/lib/computers/access";

describe("computer tool offering", () => {
  test("does not offer globally mounted computer tools until an enabled Bot is the active profile", () => {
    expect(canOfferComputerTools(undefined)).toBe(false);
    expect(canOfferComputerTools({ computerAccess: "disabled" })).toBe(false);
    expect(canOfferComputerTools({ computerAccess: "enabled" })).toBe(true);
  });
});
