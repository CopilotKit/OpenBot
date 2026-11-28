import { asText, withoutUntrustedEnvelope } from "@/lib/plugins/tool-result";
import {
  type SlackNames,
  slackMentionsAsNames,
  slackNamesFrom,
} from "@openbot/shared/slack-mentions";

/*
 * Slack's mention markup in a Bot's text, shown as names. What a mention is, how a name is found for
 * it and what it is shown as are in `shared/slack-mentions.ts`, read by the server too; this file is
 * the transcript's side: which steps it reads the names from, and the markdown plugin that draws them.
 */

export {
  NO_SLACK_NAMES,
  type SlackNames,
  slackMentionsAsNames,
} from "@openbot/shared/slack-mentions";

/** Every id this conversation's Slack steps named. Steps of any other app are not read. */
export function slackNamesIn(
  steps: readonly {
    toolCall: { function: { name: string } };
    result?: string;
  }[],
): Map<string, string> {
  return slackNamesFrom(
    steps.map((step) => ({
      name: step.toolCall.function.name,
      ...(step.result
        ? { answer: withoutUntrustedEnvelope(asText(step.result)) }
        : {}),
    })),
  );
}

/** The part of a markdown tree this reads. */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * `<!here>` looks like raw HTML to markdown (a declaration): inside a sentence it arrives as an
 * inline `html` node, and at the start of a line it opens an HTML block that runs to the end of it.
 */
const BROADCAST_FIRST =
  /^<!(?:here|channel|everyone|subteam\^S[A-Z0-9]{2,})(?:\|[^>\n]*)?>/;

/** Containers whose children are blocks, where an HTML block stands in for a paragraph. */
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);

/**
 * A remark plugin that shows Slack mentions as names in text and inline code. Code blocks are left
 * exactly as written.
 *
 * THE NAMES ARE ITS OPTIONS, NOT SOMETHING IT CLOSES OVER. Streamdown keeps one processor per set of
 * plugins and keys it by each plugin's function name and the JSON of its options. A plugin that held
 * the names in a closure has the same key for every conversation, so the first processor built, often
 * one with no names at all, was reused and every mention became "@someone". As an option, the names
 * are part of the key.
 */
export function remarkSlackMentions(options?: {
  names?: readonly (readonly [string, string])[];
}) {
  const names: SlackNames = new Map(options?.names ?? []);
  const walk = (node: MarkdownNode, parent?: MarkdownNode) => {
    if (
      (node.type === "text" || node.type === "inlineCode") &&
      node.value !== undefined
    ) {
      node.value = slackMentionsAsNames(node.value, names);
      return;
    }
    if (
      node.type === "html" &&
      node.value !== undefined &&
      BROADCAST_FIRST.test(node.value.trim())
    ) {
      const shown = slackMentionsAsNames(node.value.trim(), names);
      if (parent && BLOCK_PARENTS.has(parent.type)) {
        node.type = "paragraph";
        node.children = [{ type: "text", value: shown }];
        delete node.value;
      } else {
        node.type = "text";
        node.value = shown;
      }
      return;
    }
    if (node.type === "code") return;
    for (const child of node.children ?? []) walk(child, node);
  };
  return (tree: MarkdownNode) => walk(tree);
}
