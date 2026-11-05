import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { exportFilename, transcriptMarkdown } from "./transcript-export";

/*
 * The export as a file: every kind of turn the transcript can hold, in the order it holds them.
 *
 * The fixtures are messages as the history store hands them back, not prettier than that — a tool
 * call whose arguments are a JSON string, a result in its own message, a file part with a url
 * source — because `toVisibleChatItems` reads exactly those shapes and the export is only as good
 * as what it is handed.
 */

const when = new Date(2026, 10, 5, 20, 45);

function textMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
): Message {
  return { id, role, content } as Message;
}

/** A tool call and, optionally, the message that answered it — the pair the transcript draws together. */
function toolTurn(
  id: string,
  callId: string,
  name: string,
  arguments_: string,
  result?: string,
): Message[] {
  return [
    {
      id,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: callId,
          type: "function",
          function: { name, arguments: arguments_ },
        },
      ],
    } as unknown as Message,
    ...(result === undefined
      ? []
      : [
          {
            id: `${id}:result`,
            role: "tool",
            toolCallId: callId,
            content: result,
          } as unknown as Message,
        ]),
  ];
}

test("a person's question and a Bot's answer keep their order and their words", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: [
      textMessage("m1", "user", "Fix the login bug when the token expires"),
      textMessage("m2", "assistant", "I found the cause in `session.ts`."),
    ],
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("# Ava");
  expect(markdown).toContain("*Exported from OpenBot on ");
  expect(markdown.indexOf("**You:**")).toBeLessThan(
    markdown.indexOf("Fix the login bug"),
  );
  expect(markdown.indexOf("Fix the login bug")).toBeLessThan(
    markdown.indexOf("**Assistant:**"),
  );
  // A Bot's prose is markdown already; the file keeps it as it was written.
  expect(markdown).toContain("I found the cause in `session.ts`.");
});

test("a tool call is named with its arguments and the result that answered it", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: toolTurn(
      "m1",
      "call-1",
      "read_file",
      '{"path":"src/login.ts"}',
      "export function login() {}",
    ),
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("**Assistant used `read_file`:**");
  expect(markdown).toContain('{"path":"src/login.ts"}');
  expect(markdown).toContain("**Result:**");
  expect(markdown).toContain("export function login() {}");
});

test("a tool call still in flight is exported without a result section", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: toolTurn("m1", "call-1", "read_file", "{}"),
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("**Assistant used `read_file`:**");
  expect(markdown).not.toContain("**Result:**");
});

test("files a person attached are listed with their names", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: [
      {
        id: "m1",
        role: "user",
        content: [
          { type: "text", text: "What is in these?" },
          {
            type: "image",
            source: { type: "url", value: "/api/attachments/a1" },
            metadata: { attachmentId: "a1", filename: "screenshot.png" },
          },
          {
            type: "document",
            source: { type: "url", value: "/api/attachments/a2" },
            metadata: { attachmentId: "a2", filename: "report.pdf" },
          },
        ],
      } as unknown as Message,
    ],
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("**You attached:**");
  expect(markdown).toContain("- screenshot.png *(image)*");
  expect(markdown).toContain("- report.pdf");
});

test("turns the history holds but cannot read are counted at the head of the file", () => {
  const singular = transcriptMarkdown({
    name: "Ava",
    messages: [],
    unreadable: 1,
    now: when,
  });
  const plural = transcriptMarkdown({
    name: "Ava",
    messages: [],
    unreadable: 3,
    now: when,
  });

  expect(singular).toContain(
    "> 1 turn in this conversation could not be read and is left out of this file.",
  );
  expect(plural).toContain(
    "> 3 turns in this conversation could not be read and are left out of this file.",
  );
});

test("a conversation with nothing said says so rather than exporting silence", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: [],
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("Nothing has been said in this conversation yet.");
});

test("a result containing a fence cannot close the fence around it", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: toolTurn(
      "m1",
      "call-1",
      "read_file",
      "{}",
      "```js\nconsole.log('inside a fence');\n```",
    ),
    unreadable: 0,
    now: when,
  });

  // The fence around the result must be longer than the three backticks the result carries.
  expect(markdown).toContain(
    "````\n```js\nconsole.log('inside a fence');\n```\n````",
  );
});

test("a result longer than the file's budget says it was cut", () => {
  const long = "x".repeat(5_000);
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: toolTurn("m1", "call-1", "read_file", "{}", long),
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("x".repeat(4_000));
  expect(markdown).not.toContain(long);
  expect(markdown).toContain("*(The rest of this result is not in the file.)*");
});

test("malformed rows are skipped rather than losing the conversation", () => {
  const markdown = transcriptMarkdown({
    name: "Ava",
    messages: [null as unknown as Message, textMessage("m1", "user", "hello")],
    unreadable: 0,
    now: when,
  });

  expect(markdown).toContain("hello");
});

test("a conversation name that names a path becomes a safe file name", () => {
  expect(exportFilename("fix src/app.ts")).toBe("fix src app.ts.md");
  expect(exportFilename("  spaced   out  ")).toBe("spaced out.md");
  expect(exportFilename("")).toBe("conversation.md");
  expect(exportFilename("   ")).toBe("conversation.md");
  expect(exportFilename("a".repeat(200))).toHaveLength(80 + ".md".length);
  expect(exportFilename("a".repeat(200)).endsWith(".md")).toBe(true);
  // A control character in a title is whitespace to a file system that cannot hold it.
  expect(exportFilename("line\nbreak")).toBe("line break.md");
});
