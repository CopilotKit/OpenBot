import { describe, expect, test } from "bun:test";
import { vendorNameOf } from "@/lib/apps/vendor-name";
import { connectionRows } from "@/lib/connections/rows";
import type { PluginServer } from "@/lib/plugins/queries";

/**
 * An app added with its key instead of its sign-in is named "PostHog (key)", so it reads apart from
 * the sign-in beside it. A sentence about the person's account at the vendor, or where a key comes
 * from, still names the vendor: "Needs a key from PostHog", never "from PostHog (key)".
 */
describe("the vendor a key version's key comes from", () => {
  test("is the app's own name, for a key version and for any other app", () => {
    expect(vendorNameOf("PostHog (key)")).toBe("PostHog");
    expect(vendorNameOf("Fireflies (key)")).toBe("Fireflies");
    expect(vendorNameOf("PostHog")).toBe("PostHog");
    expect(vendorNameOf("1Password")).toBe("1Password");
    // Only the suffix the server writes, at the end.
    expect(vendorNameOf("Key (keyring)")).toBe("Key (keyring)");
  });

  test("a key version's Connections tile says where its key comes from by the vendor's name", () => {
    const server = {
      id: "composio-posthog",
      title: "PostHog (key)",
      summary: "",
      logo: null,
      authScheme: "API_KEY",
      connectsWith: "key",
    } as unknown as PluginServer;
    const [row] = connectionRows({
      catalogue: [],
      brokered: [server],
      shared: [],
      connected: new Set(),
      links: [],
      providers: undefined,
    });
    expect(row?.title).toBe("PostHog (key)");
    expect(row?.summary).toBe("Needs a key from PostHog");
  });
});
