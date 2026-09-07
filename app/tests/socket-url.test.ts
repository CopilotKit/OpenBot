import { describe, expect, test } from "bun:test";
import { socketUrl } from "../src/lib/socket-url";

const at = (protocol: string, hostname: string, host: string) => ({
  protocol,
  hostname,
  host,
});

describe("where a socket is opened", () => {
  test("goes to the server's port rather than the page's, so no proxy carries it", () => {
    expect(
      socketUrl(
        "/api/channels/events",
        at("http:", "localhost", "localhost:3010"),
        "3001",
      ),
    ).toBe("ws://localhost:3001/api/channels/events");
  });

  test("keeps the host the person actually used, and changes only the port", () => {
    expect(
      socketUrl(
        "/api/channels/events",
        at("http:", "192.168.1.10", "192.168.1.10:3010"),
        "3001",
      ),
    ).toBe("ws://192.168.1.10:3001/api/channels/events");
  });

  test("stays on the page's own origin when no server port is configured", () => {
    expect(
      socketUrl(
        "/api/channels/events",
        at("https:", "openbot.example", "openbot.example"),
        "",
      ),
    ).toBe("wss://openbot.example/api/channels/events");
  });

  test("follows the page's scheme, so an https page never opens an insecure socket", () => {
    expect(
      socketUrl(
        "/api/computers/a/stream",
        at("https:", "openbot.example", "openbot.example:8443"),
        "3001",
      ),
    ).toBe("wss://openbot.example:3001/api/computers/a/stream");
  });
});
