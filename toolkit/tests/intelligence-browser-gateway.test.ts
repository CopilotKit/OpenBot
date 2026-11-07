import { describe, expect, test } from "bun:test";
import { isAllowedGatewayUrl } from "@openbot/shared/recorder-api";
import { IntelligenceKnowingANewThread } from "../src/copilotkit/agents";

/**
 * Two addresses for one gateway: the server's, and the browser's.
 *
 * The runtime sends the browser a websocket address in `/info` and the browser opens it itself. A
 * server in a container reaches local Intelligence at `host.docker.internal`, a name the browser on
 * the host cannot resolve; the browser reaches it at `localhost`, which inside the container is the
 * container. One setting could not be right for both.
 */
describe("the gateway address a browser is given", () => {
  const base = {
    apiUrl: "http://host.docker.internal:18082",
    wsUrl: "ws://host.docker.internal:14401",
    apiKey: "synthetic-runtime-key",
  };

  test("is the server's own when no browser address is set", () => {
    const client = new IntelligenceKnowingANewThread(base);

    expect(client.ɵgetClientWsUrl()).toBe(
      "ws://host.docker.internal:14401/client",
    );
  });

  test("is the browser's when one is set, and the server keeps its own", () => {
    const client = new IntelligenceKnowingANewThread({
      ...base,
      browserWsUrl: "ws://localhost:14401",
    });

    expect(client.ɵgetClientWsUrl()).toBe("ws://127.0.0.1:14401/client");
    // Everything the server opens itself stays on the server's address.
    expect(client.ɵgetRunnerWsUrl()).toBe(
      "ws://host.docker.internal:14401/runner",
    );
    expect(client.ɵgetChannelsWsUrl()).toBe(
      "ws://host.docker.internal:14401/channels",
    );
  });

  test("names the client socket however the browser address was written", () => {
    for (const browserWsUrl of [
      "ws://localhost:14401/",
      "ws://localhost:14401/client",
      "ws://localhost:14401/runner",
      "ws://localhost:14401/channels",
    ]) {
      const client = new IntelligenceKnowingANewThread({
        ...base,
        browserWsUrl,
      });
      expect(client.ɵgetClientWsUrl()).toBe("ws://127.0.0.1:14401/client");
    }
  });

  test("ignores a blank browser address", () => {
    const client = new IntelligenceKnowingANewThread({
      ...base,
      browserWsUrl: "   ",
    });

    expect(client.ɵgetClientWsUrl()).toBe(
      "ws://host.docker.internal:14401/client",
    );
  });
});

/**
 * The same address is the Recorder's: the runtime's capture pass (`trajectory/connect`) names it as the socket a
 * recording streams on, and the Recorder opens a plain ws:// gateway only at 127.0.0.1 or [::1], never at the name
 * localhost (Decision 21). OpenBot Desktop is told its local gateway as `ws://localhost:<port>`, so every recording was
 * refused at the socket after Intelligence had minted its join token, and was kept in the browser as never saved.
 */
describe("the gateway address the Recorder is given", () => {
  const desktop = {
    apiUrl: "http://host.docker.internal:51796",
    wsUrl: "ws://host.docker.internal:51798",
    apiKey: "synthetic-runtime-key",
  };

  test("is one the Recorder opens, when the browser's address names localhost", () => {
    // OpenBot Desktop's server container, as it runs.
    const client = new IntelligenceKnowingANewThread({
      ...desktop,
      browserWsUrl: "ws://localhost:51798",
    });

    expect(client.ɵgetClientWsUrl()).toBe("ws://127.0.0.1:51798/client");
    expect(isAllowedGatewayUrl(client.ɵgetClientWsUrl(), null)).toBe(true);
  });

  test("is one the Recorder opens, when the server's own address names localhost", () => {
    // A server on the host (scripts/start.sh) with local Intelligence, and no second address.
    const client = new IntelligenceKnowingANewThread({
      apiUrl: "http://localhost:18082",
      wsUrl: "ws://localhost:14401",
      apiKey: "synthetic-runtime-key",
    });

    expect(client.ɵgetClientWsUrl()).toBe("ws://127.0.0.1:14401/client");
    expect(isAllowedGatewayUrl(client.ɵgetClientWsUrl(), null)).toBe(true);
    // The server still dials its own sockets where it was told.
    expect(client.ɵgetRunnerWsUrl()).toBe("ws://localhost:14401/runner");
  });

  test("is one the Recorder opens, when OpenBot carries the socket and was reached at localhost", () => {
    const client = new IntelligenceKnowingANewThread({
      ...desktop,
      browserWsUrl: "/api/intelligence/client",
      ownOrigin: () => "http://localhost:3001",
    });

    expect(client.ɵgetClientWsUrl()).toBe(
      "ws://127.0.0.1:3001/api/intelligence/client",
    );
    expect(isAllowedGatewayUrl(client.ɵgetClientWsUrl(), null)).toBe(true);
  });

  test("keeps every other address as it was written", () => {
    for (const [browserWsUrl, expected] of [
      ["wss://gateway.example.com", "wss://gateway.example.com/client"],
      ["ws://127.0.0.1:51798", "ws://127.0.0.1:51798/client"],
      ["ws://[::1]:51798", "ws://[::1]:51798/client"],
      ["ws://app.localhost:51798", "ws://app.localhost:51798/client"],
    ] as const) {
      const client = new IntelligenceKnowingANewThread({
        ...desktop,
        browserWsUrl,
      });
      expect(client.ɵgetClientWsUrl()).toBe(expected);
    }
  });
});
