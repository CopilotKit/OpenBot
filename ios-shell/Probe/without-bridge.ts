// A signed-in landing page without the native bridge, backed by the normal workbench ticket exchange.
const server = new URL(
  `http://127.0.0.1:${process.env.SERVER_PORT ?? "3001"}/`,
);

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.APP_PORT ?? 3013),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      url.host = server.host;
      return fetch(new Request(url, request), { redirect: "manual" });
    }
    if (url.pathname === "/sign") return new Response("Sign in");
    if (url.pathname !== "/") return new Response(null, { status: 404 });

    const person = await fetch(
      new URL("/api/v2/organizations/default/people/me", server),
      {
        headers: { cookie: request.headers.get("cookie") ?? "" },
      },
    );
    if (!person.ok)
      return new Response(null, {
        status: 303,
        headers: { location: "/sign" },
      });
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Start a conversation</h1><p>Conversations</p><p>Bots</p>',
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  },
});
