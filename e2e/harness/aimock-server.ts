import { mkdirSync } from "node:fs";
import {
  type ChatCompletionRequest,
  LLMock,
  MCPMock,
} from "@copilotkit/aimock";
import {
  BIND_HOST,
  dotenvValue,
  fixtureDirectories,
  MCP_SERVER_PATH,
  PORTS,
  RECORDING,
  RECORDING_DIR,
} from "./config";

/**
 * aimock for the end-to-end run, started by Playwright as a web server (see aimock.ts).
 *
 * Run with `bun --no-env-file`, so `.env` is not loaded into this process: in record mode the one
 * key it needs is read by name and handed to aimock as its provider key, and nothing else.
 *
 * EXACT MATCHING, THROUGH `requestTransform`. aimock matches `userMessage` as a substring unless a
 * request transform is set, when it matches exactly (aimock's documented guard against "false
 * positives from shortened keys"). OpenBot quotes the person's words in its own background calls:
 * the conversation's name is asked for with "Asked: <their message> Answered: <the reply>". By
 * substring, the Bot's own fixture for "<their message>" answers that call too, so the name it gets
 * is the Bot's reply and no name is ever recorded. Exact, each call has to have its own fixture.
 *
 * THE ONE NORMALISATION. Whether the naming call quotes the answer depends on timing: OpenBot names a
 * conversation on a 10 s loop and reads the transcript from Intelligence, so it can catch the
 * conversation before the reply is stored. The answer is cut from that call before matching and
 * recording, so its fixture is keyed on "Asked: <their message>" either way.
 */

const ASKED = "Asked: ";
const ANSWERED = " Answered: ";

function textOf(
  content: ChatCompletionRequest["messages"][number]["content"],
): string | null {
  if (typeof content === "string") return content;
  return null;
}

export function normalise(
  request: ChatCompletionRequest,
): ChatCompletionRequest {
  const messages = request.messages ?? [];
  const last = messages.length - 1;
  const text =
    last >= 0 && messages[last].role === "user"
      ? textOf(messages[last].content)
      : null;
  if (!text?.startsWith(ASKED)) return request;
  const answered = text.indexOf(ANSWERED);
  if (answered < 0) return request;
  return {
    ...request,
    messages: [
      ...messages.slice(0, last),
      { ...messages[last], content: text.slice(0, answered) },
    ],
  };
}

/** Text of a message whose content is a string or a list of parts. */
function partsText(
  content: ChatCompletionRequest["messages"][number]["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "(no text)";
  return content
    .map((part) => (part as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string")
    .join(" ");
}

/** What a request is matched on: model, turn, tool result, and the last user text. */
function describe(request: ChatCompletionRequest): string {
  const messages = request.messages ?? [];
  const turn = messages.filter(
    (message) => message.role === "assistant",
  ).length;
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const toolResult = messages.at(-1)?.role === "tool";
  const text = (lastUser ? partsText(lastUser.content) : "(none)")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return `model=${request.model ?? "-"} turn=${turn} toolResult=${toolResult} user="${text}"`;
}

async function main(): Promise<void> {
  const mock = new LLMock({
    // See BIND_HOST: where the server's container reaches this machine.
    host: BIND_HOST,
    port: PORTS.aimock,
    logLevel: "info",
    // Replay: a request no fixture answers is refused (503), never passed on.
    strict: !RECORDING,
    requestTransform: (request) => {
      const normalised = normalise(request);
      // One line per request with what it is matched on, so a miss in the log says what was
      // asked. aimock's journal drops bodies over 64 KB, which every Bot run's is.
      console.log(`[e2e] request ${describe(normalised)}`);
      return normalised;
    },
  });

  if (RECORDING) {
    const openai = dotenvValue("OPENAI_API_KEY");
    if (!openai) {
      throw new Error(
        "Record mode needs OPENAI_API_KEY in .env: aimock proxies to OpenAI with it.",
      );
    }
    const anthropic = dotenvValue("ANTHROPIC_API_KEY");
    mkdirSync(RECORDING_DIR, { recursive: true });
    mock.enableRecording({
      providers: {
        openai: "https://api.openai.com",
        anthropic: "https://api.anthropic.com",
      },
      // Used only when the caller's key is missing or an `sk-aimock-` dummy, which OpenBot's is.
      providerKeys: { openai, ...(anthropic ? { anthropic } : {}) },
      fixturePath: RECORDING_DIR,
      // Reasoning models can pause for longer than the 30 s default between chunks.
      upstreamTimeoutMs: 180_000,
      bodyTimeoutMs: 180_000,
    });
    console.log(
      "[e2e] aimock: RECORD mode, proxying unmatched requests to the real providers",
    );
  } else {
    const directories = fixtureDirectories();
    if (directories.length === 0) {
      throw new Error(
        "No fixtures in e2e/fixtures. Record them first: bun run test:e2e:record",
      );
    }
    for (const directory of directories) mock.loadFixtureDir(directory);
    console.log(
      `[e2e] aimock: strict replay of ${directories.length} journey fixture set(s)`,
    );
  }

  // An MCP server a person can add by its address (Connections, Add server), served by aimock at
  // `MCP_SERVER_PATH`. Its tools answer the same way in replay and in record mode: it is a server
  // OpenBot calls, not a model.
  const mcp = new MCPMock({
    serverInfo: { name: "openbot-e2e-field-notes", version: "1.0.0" },
  });
  mcp.addTool({
    name: "list_field_notes",
    description: "List the field notes saved in the notebook.",
    inputSchema: { type: "object", properties: {} },
  });
  mcp.onToolCall("list_field_notes", () => "No field notes yet.");
  mcp.addTool({
    name: "save_field_note",
    description: "Save a field note to the notebook.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The note." } },
      required: ["text"],
    },
  });
  mcp.onToolCall("save_field_note", () => "Saved.");
  mock.mount(MCP_SERVER_PATH, mcp);

  await mock.start();
  const stop = () => {
    mock.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
