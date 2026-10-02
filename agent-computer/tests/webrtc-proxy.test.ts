import { describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressFilter, stopEgressFilter } from "../src/egress";

/**
 * A Bot's browser must not send WebRTC traffic around the egress filter.
 *
 * Chromium sends STUN over UDP straight past an HTTP proxy unless it is told not to, so a page in a
 * `deny_all` Bot's browser could still talk to the network through `RTCPeerConnection`. Launched
 * through the real profile path, with the filter running as it does on a computer, a STUN server on
 * this machine's network address counts the packets that arrive.
 *
 * Asked for by name, like `follows-popup.test.ts`: it launches a real Chromium.
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/webrtc-proxy.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const lan = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) => entry && entry.family === "IPv4" && !entry.internal,
  )?.address;

describe.skipIf(!asked || !lan)("WebRTC from a Bot's browser", () => {
  test("sends no UDP around the proxy", async () => {
    const udp = createSocket("udp4");
    let packets = 0;
    udp.on("message", () => {
      packets += 1;
    });
    await new Promise<void>((resolve) => udp.bind(0, "0.0.0.0", resolve));
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<p>page</p>", {
          headers: { "content-type": "text/html" },
        }),
    });
    await startEgressFilter({ env: {} });
    const { createProfiles } = await import("../src/profiles");
    const root = await mkdtemp(join(tmpdir(), "openbot-webrtc-"));
    const profiles = createProfiles(root);
    const bot = "webrtc-test";
    try {
      const page = await profiles.page(bot);
      await page.goto(`http://127.0.0.1:${site.port}/`);
      await page.evaluate(
        async ({ host, port }) => {
          const connection = new RTCPeerConnection({
            iceServers: [{ urls: `stun:${host}:${port}` }],
          });
          connection.createDataChannel("probe");
          await connection.setLocalDescription(await connection.createOffer());
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          connection.close();
        },
        { host: lan, port: udp.address().port },
      );
      expect(packets).toBe(0);
    } finally {
      await profiles.stop(bot).catch(() => undefined);
      await stopEgressFilter();
      site.stop(true);
      udp.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});
