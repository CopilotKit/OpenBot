import { describe, expect, test } from "bun:test";
import { canOfferComputerTools } from "../src/lib/computers/access";

describe("computer tool offering", () => {
  const enabled = {
    id: "collector",
    computerAccess: "enabled" as const,
  };

  test("offers tools only after a current successful enabled-profile response", () => {
    expect(
      canOfferComputerTools("collector", {
        data: enabled,
        isError: false,
        isFetching: false,
        isSuccess: true,
      }),
    ).toBe(true);
  });

  test("withdraws tools while an enabled profile is being refreshed or after its refresh fails", () => {
    expect(
      canOfferComputerTools("collector", {
        data: enabled,
        isError: false,
        isFetching: true,
        isSuccess: true,
      }),
    ).toBe(false);
    expect(
      canOfferComputerTools("collector", {
        data: enabled,
        isError: true,
        isFetching: false,
        isSuccess: false,
      }),
    ).toBe(false);
  });

  test("does not retain an enabled cached profile when the active Bot changes or is revoked", () => {
    expect(
      canOfferComputerTools("jefe", {
        data: enabled,
        isError: false,
        isFetching: false,
        isSuccess: true,
      }),
    ).toBe(false);
    expect(
      canOfferComputerTools("collector", {
        data: { id: "collector", computerAccess: "disabled" },
        isError: false,
        isFetching: false,
        isSuccess: true,
      }),
    ).toBe(false);
  });
});
