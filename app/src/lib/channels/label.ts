/**
 * How a conversation is named in a picker: its Bot and, once it has one, its title.
 *
 * The name alone is the Bot's for every one-Bot conversation, so a list of "General Assistant"
 * twelve times gave no way to choose. The title is what the sidebar shows: the summary once the
 * conversation has been named, its last message until then.
 */
export function conversationLabel(channel: {
  name: string;
  summary?: string | null;
  lastMessage?: string | null;
}): string {
  const title = (channel.summary || channel.lastMessage || "").trim();
  return title ? `${channel.name}: ${title.slice(0, 60)}` : channel.name;
}
