import { afterEach, expect, test } from "bun:test";
import { connectionOf } from "../src/plugins/composio-vendor";
import { deploymentClientOf } from "../src/plugins/deployment-clients";

/**
 * A server-to-server grant is offered only on the deployment's own client, and Shopify is the app
 * that publishes nothing else: an OAuth2 that needs a client registered here, and S2S_OAUTH2, with
 * no scheme Composio manages for it. That is the row Composio publishes for it today.
 */
const shopify = {
  slug: "shopify",
  auth_schemes: ["OAUTH2", "S2S_OAUTH2"],
  composio_managed_auth_schemes: [],
};

afterEach(() => {
  delete process.env.COMPOSIO_SHOPIFY_CLIENT_ID;
  delete process.env.COMPOSIO_SHOPIFY_CLIENT_SECRET;
});

test("without the deployment's client, a server-to-server app is unsupported and names the variables", () => {
  const connection = connectionOf(shopify);
  expect(connection.kind).toBe("unsupported");
  // The operator is the one person who can fix this, and the sentence says how.
  expect(connection.kind === "unsupported" && connection.reason).toMatch(
    /COMPOSIO_SHOPIFY_CLIENT_ID and COMPOSIO_SHOPIFY_CLIENT_SECRET/,
  );
});

test("with the deployment's client, a server-to-server app asks for its connection fields", () => {
  process.env.COMPOSIO_SHOPIFY_CLIENT_ID = "id";
  process.env.COMPOSIO_SHOPIFY_CLIENT_SECRET = "secret";
  expect(connectionOf(shopify)).toEqual({
    kind: "fields",
    authScheme: "S2S_OAUTH2",
  });
});

test("half a client is still unsupported, rather than offered at an enable that fails", () => {
  process.env.COMPOSIO_SHOPIFY_CLIENT_ID = "id";
  expect(connectionOf(shopify).kind).toBe("unsupported");
});

test("a plain key is still preferred over a server-to-server grant", () => {
  process.env.COMPOSIO_SHOPIFY_CLIENT_ID = "id";
  process.env.COMPOSIO_SHOPIFY_CLIENT_SECRET = "secret";
  expect(
    connectionOf({ ...shopify, auth_schemes: ["S2S_OAUTH2", "API_KEY"] }),
  ).toEqual({ kind: "fields", authScheme: "API_KEY" });
});

test("managed consent still wins over a server-to-server grant", () => {
  process.env.COMPOSIO_SHOPIFY_CLIENT_ID = "id";
  process.env.COMPOSIO_SHOPIFY_CLIENT_SECRET = "secret";
  expect(
    connectionOf({ ...shopify, composio_managed_auth_schemes: ["OAUTH2"] }),
  ).toEqual({ kind: "consent" });
});

test("half a client is no client, and a padded one is trimmed", () => {
  expect(
    deploymentClientOf("shopify", { COMPOSIO_SHOPIFY_CLIENT_ID: "id" }),
  ).toBeNull();
  expect(
    deploymentClientOf("shopify", {
      COMPOSIO_SHOPIFY_CLIENT_ID: "id",
      COMPOSIO_SHOPIFY_CLIENT_SECRET: "   ",
    }),
  ).toBeNull();
  expect(
    deploymentClientOf("shopify", {
      COMPOSIO_SHOPIFY_CLIENT_ID: " id ",
      COMPOSIO_SHOPIFY_CLIENT_SECRET: "secret",
    }),
  ).toEqual({ client_id: "id", client_secret: "secret" });
});

test("a slug with a dash reads an underscored variable", () => {
  expect(
    deploymentClientOf("my-app", {
      COMPOSIO_MY_APP_CLIENT_ID: "id",
      COMPOSIO_MY_APP_CLIENT_SECRET: "secret",
    }),
  ).toEqual({ client_id: "id", client_secret: "secret" });
});
