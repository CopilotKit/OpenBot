/**
 * Which sidebar section a conversation belongs to, and how the three sections fold.
 *
 * Pure, and apart from the components that draw them, because the rule is the feature: a channel
 * filed in one of this person's projects is drawn there and nowhere else, everything else is Group
 * or Direct by its own shape, and a search reaches all three at once. The sidebar reads the answer
 * and renders it; nothing here fetches, and nothing here asks the server a question per row — every
 * input is a field the roster and the projects read already carry.
 */
import type {
  SidebarSectionId,
  SidebarSections,
} from "@openbot/shared/user-preferences";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { Project } from "@/lib/projects/queries";

/** The three sections, in the order the sidebar draws them. */
/**
 * The mime type a dragged conversation row carries, so a folder accepts only our rows and not
 * whatever else a browser might drop on it. A private handshake between the two halves of this
 * feature, not a contract anyone else reads.
 */
export const DRAGGED_CHANNEL_MIME = "application/x-openbot-channel";

export const CONVERSATION_SECTION_IDS = [
  "group",
  "direct",
  "projects",
] as const satisfies readonly SidebarSectionId[];

export const SECTION_TITLES: Record<SidebarSectionId, string> = {
  group: "Group chats",
  direct: "Direct chats",
  projects: "Projects",
};

/** What an empty section says, in the row the section would otherwise hold conversations in. */
export const SECTION_EMPTY: Record<SidebarSectionId, string> = {
  group: "No group chats yet",
  direct: "No direct chats yet",
  projects: "No projects yet",
};

/**
 * What an empty section means, for the person looking at it.
 *
 * Short on purpose: the section header already says which conversations are missing, so this line
 * only has to say how one gets there. The Projects one carries the feature's whole idea, because a
 * person who has never made a folder is the one who needs to read it.
 */
export const SECTION_EMPTY_HINT: Record<SidebarSectionId, string> = {
  group:
    "A conversation with more than one Bot, or with somebody else in it, appears here.",
  direct: "Your one-to-one conversations appear here.",
  projects:
    "Folders of your own: make one with +, then file a conversation into it from its menu.",
};

/**
 * A group chat, by the only two shapes the sidebar can see.
 *
 * More than one person (the caller included, which is what `memberCount` counts) or more than one
 * Bot. Either one alone is a group: two people and one Bot is shared work, one person and two Bots
 * is a room. Absent fields read as a 1:1, which is what they were before the server sent them.
 */
export function isGroupChat(channel: ChannelSummary): boolean {
  return (channel.memberCount ?? 1) > 1 || channel.agentIds.length > 1;
}

export type ProjectFolder = {
  project: Project;
  /** The conversations filed here, in the order they arrived. */
  channels: ChannelSummary[];
};

export type ConversationSections = {
  group: ChannelSummary[];
  direct: ChannelSummary[];
  /** The person's folders, in their own order, each with what is filed in it. */
  projects: ProjectFolder[];
};

/**
 * Every conversation, placed once.
 *
 * A channel whose `projectId` names a folder this person no longer has — a folder deleted in another
 * tab, a roster read that outran the projects read — falls back to Group or Direct rather than
 * disappearing: a conversation nobody can find is worse than one in the section it used to be in.
 * Order is preserved inside each section, because the roster arrives in the order the sidebar draws
 * (pinned first, then most recent activity) and re-sorting here would fight it.
 */
export function conversationSections(
  channels: ChannelSummary[] | undefined,
  projects: Project[] | undefined,
): ConversationSections {
  const folders = new Map<string, ProjectFolder>();
  for (const project of projects ?? []) {
    folders.set(project.id, { project, channels: [] });
  }

  const sections: ConversationSections = {
    group: [],
    direct: [],
    projects: [...folders.values()],
  };

  for (const channel of channels ?? []) {
    const folder = channel.projectId
      ? folders.get(channel.projectId)
      : undefined;
    if (folder) {
      folder.channels.push(channel);
    } else if (isGroupChat(channel)) {
      sections.group.push(channel);
    } else {
      sections.direct.push(channel);
    }
  }

  return sections;
}

/** How many conversations a section header counts. Projects counts what is filed in all of them. */
export function sectionConversationCount(
  sections: ConversationSections,
  id: SidebarSectionId,
): number {
  switch (id) {
    case "group":
      return sections.group.length;
    case "direct":
      return sections.direct.length;
    case "projects":
      return sections.projects.reduce(
        (total, folder) => total + folder.channels.length,
        0,
      );
  }
}

/**
 * The stored flags, as a complete set of booleans.
 *
 * A missing flag is open, which is what a person sees before they fold anything and what a row
 * written by a build that knew fewer sections has to mean for the one it does not carry.
 */
export function mergeSidebarSections(
  stored: Partial<Record<SidebarSectionId, boolean>> | undefined,
): SidebarSections {
  return {
    group: stored?.group === true,
    direct: stored?.direct === true,
    projects: stored?.projects === true,
  };
}

/** One header click. The whole object is sent on save, so this returns the whole object. */
export function toggledSidebarSection(
  current: SidebarSections,
  id: SidebarSectionId,
): SidebarSections {
  return { ...current, [id]: !current[id] };
}

/**
 * What is folded, given what the person asked for and what they are typing.
 *
 * A search opens every section: a match inside a section somebody had folded is a result they would
 * otherwise be told about and not shown. Search is temporary, so this is drawn over the stored
 * flags rather than written into them — the fold they chose is still there when the box is cleared.
 */
export function collapsedSections(
  stored: SidebarSections,
  searching: boolean,
): SidebarSections {
  if (!searching) return stored;
  return { group: false, direct: false, projects: false };
}

/**
 * Whether a section is drawn at all under the current search.
 *
 * Folded sections are still drawn — the header is how they are opened again. A section with nothing
 * in it is only dropped while searching, where "No group chats yet" beside a box full of a
 * colleague's name would be the wrong sentence about the wrong thing.
 */
export function sectionVisible(count: number, searching: boolean): boolean {
  return count > 0 || !searching;
}

/** One row of a conversation's "Move to project ▸" submenu. */
export type MoveOffer =
  | { kind: "project"; projectId: string; name: string }
  | { kind: "new" };

/**
 * What the submenu offers: every folder but the one the conversation is already in, then the way to
 * make another.
 *
 * The current folder is left out rather than drawn as a disabled row — moving something to where it
 * already is is not an action, and the menu already has "Remove from project" for the way back out.
 * All of these are this person's own folders, and the row was drawn from a roster only a member can
 * see, so ownership and membership are what got the row here in the first place.
 */
export function moveToProjectOffers(
  projects: Project[] | undefined,
  currentProjectId: string | null | undefined,
): MoveOffer[] {
  const offers: MoveOffer[] = (projects ?? [])
    .filter((project) => project.id !== currentProjectId)
    .map((project) => ({
      kind: "project" as const,
      projectId: project.id,
      name: project.name,
    }));
  offers.push({ kind: "new" });
  return offers;
}
