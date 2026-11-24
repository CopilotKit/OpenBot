import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DecisionSession } from "./decision.ts";
import { collectExpress, expressFixture } from "./express.ts";
import { application, cases, mockDecisions } from "./fixtures.ts";
import { errorSummary } from "./live.ts";
import { createProcessor, spikeCatalog } from "./sdk.ts";

const demos = { settings: 0, results: 2, confirmation: 4 } as const;

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json")
    throw new Error("Expected JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, value: object, status = 200) {
  response
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(value));
}

export async function demoServer(port = 0) {
  const [html, script] = await Promise.all([
    readFile(new URL("index.html", import.meta.url)),
    readFile(new URL(".dist/browser.js", import.meta.url)),
  ]);
  const processor = createProcessor(spikeCatalog());
  const sessions = new Map<string, (action: unknown) => Promise<object>>();
  const server = createServer(async (request, response) => {
    try {
      const path = request.url ?? "";
      if (request.method === "GET" && path === "/") {
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(html);
      } else if (request.method === "GET" && path === "/browser.js") {
        response
          .writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
          .end(script);
      } else if (request.method === "POST" && path === "/show") {
        const body = (await readJson(request)) as {
          mode?: string;
          family?: string;
        };
        const { mode, family } = body;
        if (
          (mode !== "decision" && mode !== "express") ||
          !family ||
          !Object.hasOwn(demos, family)
        ) {
          json(response, { error: "Unknown fixture" }, 400);
          return;
        }
        const key = family as keyof typeof demos;
        const sessionId = randomUUID();
        const fixture = cases[demos[key]];
        if (mode === "decision") {
          const api = mockDecisions(fixture.answers, {
            detailMode: key === "results" ? "summary" : "acknowledged",
          });
          const session = new DecisionSession(processor, api.submit);
          const { messages } = await session.show(fixture.request, application);
          sessions.set(sessionId, (action) => session.follow(action));
          json(response, { messages, sessionId });
        } else {
          const state = processor.createState();
          const { messages } = await collectExpress(
            processor,
            state,
            expressFixture(key),
          );
          sessions.set(sessionId, async (action) => {
            if (
              key !== "results" ||
              !action ||
              typeof action !== "object" ||
              !("action" in action) ||
              !action.action ||
              typeof action.action !== "object" ||
              !("sourceComponentId" in action.action) ||
              action.action.sourceComponentId !== "result_birch"
            ) {
              throw new Error(
                "The Express fixture includes only the Birch follow-up",
              );
            }
            return {
              messages: (
                await collectExpress(processor, state, expressFixture("follow"))
              ).messages,
            };
          });
          json(response, { messages, sessionId });
        }
        if (sessions.size > 32) {
          const oldest = sessions.keys().next();
          if (!oldest.done) sessions.delete(oldest.value);
        }
      } else if (request.method === "POST" && path.startsWith("/action/")) {
        const follow = sessions.get(path.slice("/action/".length));
        if (!follow) {
          json(response, { error: "Missing fixture session" }, 404);
          return;
        }
        const result = (await follow(await readJson(request))) as {
          messages: unknown[];
        };
        json(response, { messages: result.messages });
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      json(response, { error: errorSummary(error).kind }, 400);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await demoServer(Number(process.env.PORT ?? 4173));
  console.log(server.url);
}
