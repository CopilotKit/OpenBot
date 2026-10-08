import { describe, expect, test } from "bun:test";
import { providersFromResponse } from "./queries";

describe("providersFromResponse", () => {
  test("reads the provider flags", async () => {
    const response = Response.json({
      providers: { slack: true, github: false },
    });
    expect(await providersFromResponse(response)).toEqual({
      slack: true,
      github: false,
    });
  });

  test("treats the tagged 503 as nothing linkable", async () => {
    const response = Response.json(
      { error: "No identity store", code: "identity_unavailable" },
      { status: 503 },
    );
    expect(await providersFromResponse(response)).toEqual({
      slack: false,
      github: false,
    });
  });

  test("throws the server's message for any other 503", async () => {
    const response = Response.json({ error: "Bad gateway" }, { status: 503 });
    await expect(providersFromResponse(response)).rejects.toThrow(
      "Bad gateway",
    );
  });

  test("throws when providers is missing or not boolean-shaped", async () => {
    const message = "Could not load the account types you can link";
    await expect(providersFromResponse(Response.json({}))).rejects.toThrow(
      message,
    );
    await expect(
      providersFromResponse(Response.json({ providers: { slack: "yes" } })),
    ).rejects.toThrow(message);
  });
});
