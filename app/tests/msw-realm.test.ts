import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { getResponse, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

// tests/preload.ts puts msw's responses back on the platform's Response before each test. Without
// that, a server that listened while happy-dom was registered leaves them on that DOM's Response
// for every file after it, and their bodies read empty.
test("a server listens and closes while happy-dom is registered", async () => {
  GlobalRegistrator.register();
  try {
    const server = setupServer();
    server.listen({ onUnhandledRequest: "bypass" });
    server.close();
  } finally {
    await GlobalRegistrator.unregister();
  }
});

test("after it, msw still answers with the platform's Response", async () => {
  const response = await getResponse(
    [http.get("http://127.0.0.1/a", () => HttpResponse.json({ a: 1 }))],
    new Request("http://127.0.0.1/a"),
  );
  expect(response).toBeInstanceOf(Response);
  expect(response?.headers.get("content-type")).toBe("application/json");
  expect(await response?.json()).toEqual({ a: 1 });
});
