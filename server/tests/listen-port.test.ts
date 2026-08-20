import { describe, expect, test } from "bun:test";
import { resolveListenPort } from "../src/listen-port";

describe("API listen port", () => {
  test("defaults to 3001", () => {
    expect(resolveListenPort({})).toBe(3001);
  });

  test("honours PORT, which existing .env files already set", () => {
    expect(resolveListenPort({ PORT: "4001" })).toBe(4001);
  });

  test("honours SERVER_PORT, which is the name the docs and start.sh use", () => {
    expect(resolveListenPort({ SERVER_PORT: "4002" })).toBe(4002);
  });

  test("prefers SERVER_PORT when both are set, so the documented name actually moves the listener", () => {
    expect(resolveListenPort({ SERVER_PORT: "4002", PORT: "3001" })).toBe(4002);
  });

  test("treats blank values as unset", () => {
    expect(resolveListenPort({ SERVER_PORT: "  ", PORT: "4001" })).toBe(4001);
    expect(resolveListenPort({ SERVER_PORT: "", PORT: "" })).toBe(3001);
  });
});
