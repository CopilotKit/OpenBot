import {
  type AttachmentPart,
  attachmentUrl,
  classifyAttachment,
} from "@openbot/shared/attachments";
import type { TaskReplyContext } from "@openbot/shared/task-reply";
import {
  newInlineBudget,
  resolveAttachmentParts,
  type StoredAttachment,
} from "../channels/attachment-parts";
import { TaskRefusedError } from "./store";
import type { TaskScope } from "./turn";

/**
 * The files and skills a reply in a task's conversation names, checked the way an ordinary
 * conversation checks them: each file the person's own in that conversation, each skill granted to
 * the task's Bot.
 *
 * Only references are kept with the reply on the queue. The file's bytes and the skill's
 * instructions are read when the turn runs, and checked again then, so a grant taken away while
 * the reply waited is not used.
 */
export function createTaskReplyContext(deps: {
  load(scope: TaskScope, id: string): Promise<StoredAttachment | null>;
  markSent(scope: TaskScope, ids: readonly string[]): Promise<void>;
  skillsFor(
    agentId: string,
  ): Promise<{ skills: { slug: string; instructions: string }[] }>;
}) {
  async function resolve(scope: TaskScope, input: TaskReplyContext) {
    const skillIds = [...new Set(input.skillIds ?? [])];
    const granted = skillIds.length
      ? (await deps.skillsFor(scope.agentId)).skills
      : [];
    const skillInstructions = skillIds.map((id) => {
      const skill = granted.find((entry) => entry.slug === id);
      if (!skill)
        throw new TaskRefusedError(
          "A selected skill is no longer available to this Bot. Remove it and send again.",
        );
      return skill.instructions;
    });
    const attachments: AttachmentPart[] = [];
    // Through the same checks a conversation's own files take, the per-run inline budget included.
    const ids = [...new Set(input.attachmentIds ?? [])];
    await resolveAttachmentParts(
      ids.map((id) => ({
        type: "document",
        source: { type: "url", value: attachmentUrl(id) },
      })),
      async (id) => {
        const stored = await deps.load(scope, id);
        if (!stored)
          throw new TaskRefusedError(
            "An attachment is no longer available in this conversation. Attach it again.",
          );
        attachments.push({
          type:
            classifyAttachment(stored.mimeType) === "image"
              ? "image"
              : "document",
          source: {
            type: "url",
            value: attachmentUrl(id),
            mimeType: stored.mimeType,
          },
          metadata: { attachmentId: id, filename: stored.name },
        });
        return stored;
      },
      "fail",
      newInlineBudget(),
    );
    return { attachments, skillInstructions };
  }
  return {
    resolve,
    /** Checked before the reply is taken, and its files kept, since it may wait across a restart. */
    async accept(scope: TaskScope, input: TaskReplyContext) {
      await resolve(scope, input);
      if (input.attachmentIds?.length)
        await deps.markSent(scope, input.attachmentIds);
    },
  };
}
export type TaskReplyContextReader = ReturnType<typeof createTaskReplyContext>;
