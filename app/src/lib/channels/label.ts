import { untitledLine } from "@openbot/shared/conversation-title";
import { openingOf } from "@/lib/voice/cut";

export { untitledLine };

/**
 * How a conversation is named in a picker: its Bot and, once it has one, its title.
 *
 * The name alone is the Bot's for every one-Bot conversation, so a list of "General Assistant"
 * twelve times gave no way to choose. The title is what the sidebar shows: the summary once the
 * conversation has been named, its {@link untitledLine} until then.
 *
 * The cut drops a trailing half character rather than keeping it, because `slice` counts UTF-16 code
 * units and an emoji is two of them: a title cut between the halves renders a replacement character
 * where the character should be.
 */
export function conversationLabel(channel: {
  name: string;
  summary?: string | null;
  opening?: string | null;
  lastMessage?: string | null;
}): string {
  const title = (channel.summary || untitledLine(channel) || "").trim();
  return title ? `${channel.name}: ${openingOf(title, 60)}` : channel.name;
}
