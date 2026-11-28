/**
 * Every request this app makes to its OpenBot names the app: `OpenBot-Client: web/<release>`.
 *
 * The server reads the header to refuse an app older than it serves (CLIENT_UPDATE_REQUIRED) and to
 * count which apps still call what. These requests leave through the app's real transport
 * (`lib/client.ts`, and the generated client's mutator on top of it) and reach a real HTTP server on
 * this computer, which records what arrived. The page is addressed at that server, as a page is at
 * the OpenBot that served it.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  CLIENT_HEADER,
  clientToken,
  RELEASE,
} from "@openbot/shared/client-version";
import { getDeployment } from "@/lib/api/generated/organization-settings/organization-settings";
import { listOrganizations } from "@/lib/api/generated/organizations/organizations";
import { client, tryClient } from "@/lib/client";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

type Seen = { path: string; headers: Headers };
let seen: Seen[] = [];
let openbot: ReturnType<typeof Bun.serve>;
// The server answers in the runtime's own Response, not the page's.
const NativeResponse = globalThis.Response;

beforeAll(() => {
  openbot = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push({ path, headers: request.headers });
      if (path.endsWith("/deployment"))
        return NativeResponse.json({ edition: "team", api: ["v2"] });
      if (path === "/api/v2/people/me/organizations")
        return NativeResponse.json({ organizations: [], nextCursor: null });
      return NativeResponse.json({ thing: { id: "one" } });
    },
  });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
  // The page is at the server.
  globalThis.fetch = pageFetch();
});
beforeEach(() => {
  seen = [];
});
afterAll(async () => {
  globalThis.fetch = nativeFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
});

const NAMED = clientToken("web", RELEASE);

function headerAt(path: string): string | null {
  const request = seen.find((one) => one.path === path);
  if (!request) throw new Error(`nothing reached ${path}`);
  return request.headers.get(CLIENT_HEADER);
}

test(`a request through the client says ${NAMED}`, async () => {
  expect(NAMED).toBe(`web/${RELEASE}`);
  await client("/api/things/one", "thing");
  expect(headerAt("/api/things/one")).toBe(NAMED);
});

test("a generated operation says it too", async () => {
  await getDeployment("default", { fallback: "Couldn't load OpenBot." });
  expect(headerAt("/api/v2/organizations/default/deployment")).toBe(NAMED);
});

test("beside the headers a caller gives, as a record or as Headers", async () => {
  await tryClient("/api/things/record", {
    method: "POST",
    body: { a: 1 },
    headers: { "OpenBot-Organization": "default" },
  });
  const record = seen.find((one) => one.path === "/api/things/record");
  expect(record?.headers.get(CLIENT_HEADER)).toBe(NAMED);
  expect(record?.headers.get("OpenBot-Organization")).toBe("default");
  expect(record?.headers.get("content-type")).toBe("application/json");

  // getDeployment hands its options' headers to the transport as they were given: here, Headers.
  await getDeployment("given", {
    headers: new Headers({ "OpenBot-Organization": "default" }),
  });
  const given = seen.find(
    (one) => one.path === "/api/v2/organizations/given/deployment",
  );
  expect(given?.headers.get(CLIENT_HEADER)).toBe(NAMED);
  expect(given?.headers.get("OpenBot-Organization")).toBe("default");

  await listOrganizations({ limit: 1 });
  expect(headerAt("/api/v2/people/me/organizations")).toBe(NAMED);
});
