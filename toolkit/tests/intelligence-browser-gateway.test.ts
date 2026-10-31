import { describe, expect, test } from "bun:test";
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

    expect(client.ɵgetClientWsUrl()).toBe("ws://localhost:14401/client");
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
      expect(client.ɵgetClientWsUrl()).toBe("ws://localhost:14401/client");
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
