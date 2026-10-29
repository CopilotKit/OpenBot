import { describe, expect, test } from "bun:test";
import { guardDeliveryStore } from "../src/admin/controls";
import type { AuditEventInput } from "../src/audit";

/**
 * Which chat account a link bound, on the `delivery.linked` row.
 *
 * A Slack or Teams link code is redeemed by whoever sends it, and that account then runs the Bot as
 * its owner. The row is filed under the owner, so it has to say which account, or a binding someone
 * else redeemed reads as the owner connecting their own. For SMS and push the identity is a phone
 * number or a device token, which does not belong on a trail every administrator can read.
 */
function linkRow(transport: string, identity: string) {
  const written: AuditEventInput[] = [];
  const store = guardDeliveryStore(
    {
      bind: async (_input: {
        ownerUserId: string;
        transport: string;
        realm: string;
        identity: string;
      }) => ({ id: "binding-1" }),
      removeBinding: async () => undefined,
    },
    {
      insert: async (event: AuditEventInput) => {
        written.push(event);
      },
    } as never,
    (message) => new Error(message),
  );
  return {
    written,
    store,
    input: { ownerUserId: "owner-1", transport, realm: "T1", identity },
  };
}

describe("the delivery.linked row", () => {
  test.each(["slack", "teams"])(
    "names the %s account that was bound",
    async (transport) => {
      const { written, store, input } = linkRow(
        transport,
        `${transport}:T1:U9`,
      );
      await store.bind(input);

      expect(written[0]?.eventType).toBe("delivery.linked");
      expect(written[0]?.payload).toMatchObject({
        identity: `${transport}:T1:U9`,
      });
    },
  );

  test.each([
    ["sms", "+15555550123"],
    ["push", "device-token-abc"],
  ])("leaves the %s identity off the trail", async (transport, identity) => {
    const { written, store, input } = linkRow(transport, identity);
    await store.bind(input);

    expect(written[0]?.eventType).toBe("delivery.linked");
    expect(written[0]?.payload).not.toHaveProperty("identity");
    expect(JSON.stringify(written[0]?.payload)).not.toContain(identity);
  });
});
