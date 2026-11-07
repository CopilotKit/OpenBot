import { describe, expect, test } from "bun:test";
import { openbotAddress } from "../src/browser/address";

/**
 * OpenBot Desktop writes its app's 127.0.0.1 address as `OPENBOT_PUBLIC_URL`, so an app connected
 * over its own OAuth has somewhere to come back to. That address now comes first for the Recorder
 * too. The Recorder runs in the one computer's browser, whose relay always listens on 127.0.0.1 and
 * on [::1] only where the container has IPv6, so a window on [::1] still hands it the address that
 * always answers there.
 */
describe("where the Recorder reaches OpenBot Desktop", () => {
  const desktop = openbotAddress({
    publicUrl: "http://127.0.0.1:3010",
    appUrl: "http://localhost:3010",
  });

  test("the app's own 127.0.0.1 address, whichever loopback name the window used", () => {
    expect(desktop("http://[::1]:3010")).toBe("http://127.0.0.1:3010");
    expect(desktop("http://127.0.0.1:3010")).toBe("http://127.0.0.1:3010");
    expect(desktop(undefined)).toBe("http://127.0.0.1:3010");
  });

  test("never another site's address", () => {
    expect(desktop("https://evil.example")).toBe("http://127.0.0.1:3010");
  });
});
