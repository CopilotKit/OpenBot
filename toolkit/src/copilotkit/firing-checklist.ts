import type { Message } from "@ag-ui/client";
import { routineParts } from "@openbot/shared/routine-checklist";
import { readFiring } from "@openbot/shared/routine-firing";
import { checklistNotice } from "@openbot/shared/run-notices";

/**
 * The checklist a routine's run carries, read from the firing it is answering.
 *
 * A run is a firing when the person's latest message is one (`frameFiring`), which is how a
 * routine's turn reaches every Bot, including a run resumed after an approval. The parts are the
 * instruction's own list (`routineParts`). The model is shown them under the instruction, numbered
 * as it is asked to close them, in the copy of the conversation that goes to the model only: the
 * transcript keeps the firing as it was, and the next firing reads its own list again.
 */
export function firingChecklist(messages: Message[]): {
  parts: string[];
  toModel: (messages: Message[]) => Message[];
} {
  const index = messages.findLastIndex((message) => message.role === "user");
  const firing = index >= 0 ? messages[index] : undefined;
  const text = firing ? textOf(firing) : undefined;
  const instruction = text === undefined ? null : readFiring(text);
  const parts = instruction === null ? [] : routineParts(instruction);
  if (!firing || parts.length === 0)
    return { parts, toModel: (unchanged) => unchanged };
  const notice = checklistNotice(parts);
  return {
    parts,
    toModel: (sent) =>
      sent.map((message) =>
        message.id === firing.id && message.role === "user"
          ? withNotice(message, notice)
          : message,
      ),
  };
}

function textOf(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function withNotice(message: Message, notice: string): Message {
  if (message.role !== "user") return message;
  const { content } = message;
  if (typeof content === "string")
    return { ...message, content: `${content}\n\n${notice}` };
  return {
    ...message,
    content: [...content, { type: "text", text: notice }],
  } as Message;
}
