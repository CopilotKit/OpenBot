import { describe, expect, test } from "bun:test";
import {
  frameUrl,
  MAC_USER_AGENT,
  readFrameConfig,
  WINDOWS_ANSWERS,
  WINDOWS_USER_AGENT,
} from "./frameConfig";

describe("frameConfig", () => {
  test("frameUrl joins the search and the hash", () => {
    expect(
      frameUrl({
        hash: "#licence",
        search: "?offer",
        os: "mac",
        env: {},
        answers: {},
      }),
    ).toBe("/workbench/frame.html?offer#licence");
  });

  test("readFrameConfig has a default with no parent config", () => {
    expect(readFrameConfig()).toEqual({
      hash: "",
      search: "",
      os: "mac",
      env: {},
      answers: {},
    });
  });

  test("WINDOWS_ANSWERS covers the Windows checks", () => {
    expect(WINDOWS_ANSWERS).toHaveProperty("windows_blocker");
    expect(WINDOWS_ANSWERS).toHaveProperty("windows_restart_pending");
  });

  test("the user agents name their OS", () => {
    expect(/Macintosh|Mac OS X/.test(MAC_USER_AGENT)).toBe(true);
    expect(/Macintosh|Mac OS X/.test(WINDOWS_USER_AGENT)).toBe(false);
    expect(WINDOWS_USER_AGENT).toContain("Windows");
  });
});
