import { describe, expect, test } from "bun:test";
import { IDENTITY_ACTION } from "../src/plugins/plugin-store/model";

describe("IDENTITY_ACTION", () => {
  test("recognises a store's own details as an identity read", () => {
    // For a store, its own details are the identity: probing these needs no
    // extra scope, unlike e.g. SHOPIFY_COUNT_BLOGS which needs read_content
    // and 403s on a store app with only order and product scopes.
    expect(IDENTITY_ACTION.test("SHOPIFY_GET_SHOP_DETAILS")).toBe(true);
  });

  test("still recognises the existing identity reads", () => {
    for (const name of [
      "STRIPE_GET_ME",
      "SLACK_GET_PROFILE",
      "LINEAR_GET_CURRENT_USER",
      "GITHUB_GET_USER_INFO",
      "NOTION_WHOAMI",
    ]) {
      expect(IDENTITY_ACTION.test(name)).toBe(true);
    }
  });

  test("does not match non-identity actions", () => {
    for (const name of [
      "SHOPIFY_COUNT_BLOGS",
      "SHOPIFY_UPDATE_ORDER",
      "SLACK_PROFILE_SET",
      "GITHUB_WHOAMI_STATS",
    ]) {
      expect(IDENTITY_ACTION.test(name)).toBe(false);
    }
  });
});
