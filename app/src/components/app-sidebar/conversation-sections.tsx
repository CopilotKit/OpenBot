import {
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type {
  SidebarSectionId,
  SidebarSections,
} from "@openbot/shared/user-preferences";
import { pinnedFirst } from "@/lib/channels/order";
import type { ChannelSummary } from "@/lib/channels/queries";
import {
  collapsedSections,
  conversationSections,
  type ProjectFolder as Folder,
  SECTION_EMPTY,
  SECTION_EMPTY_HINT,
  SECTION_TITLES,
  sectionVisible,
} from "@/lib/channels/sections";
import { isUnread } from "@/lib/channels/unread";
import { untitledLine } from "@/lib/channels/label";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { createProjectMutationOptions, renameProjectMutationOptions } from "@/lib/projects/mutations";
import type { Project } from "@/lib/projects/queries";
import { relativeTimeShort } from "@/lib/relative-time";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";
import { Channel } from "./channel";
import { DeleteProjectDialog } from "./delete-project-dialog";
import { ProjectNameInput } from "./project-name-input";
import { SectionEmpty, SectionHeader } from "./section-header";

/**
 * The sidebar's conversations, in three collapsible sections.
 *
 * One component for all of them because the sections differ in what fills them, not in how they are
 * drawn: the same header, the same rows, the same fold. The Projects section is the one that also
 * owns folders — making one, renaming it, deleting it — and each folder folds on its own without
 * being remembered, since the section above it already is.
 *
 * Every list arrives from the same two reads the sidebar already made: the roster carries each
 * channel's `memberCount` and `projectId`, so classification costs no request per row.
 */

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  projects,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  /** This person's folders, for the row's "Move to project ▸" submenu. */
  projects: Project[];
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        untitled={untitledLine(channel)}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTimeShort(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        canRename={channel.canRename ?? false}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
        projectId={channel.projectId ?? null}
        projects={projects}
      />
    </motion.div>
  );
}

/** The rows of one section, or the line that stands in for them while it holds none. */
function SectionRows({
  channels,
  projects,
  emphasis,
  animateOrder,
  emptyText,
  emptyHint,
}: {
  channels: ChannelSummary[];
  projects: Project[];
  emphasis: MessageListEmphasis;
  animateOrder: boolean;
  emptyText: string;
  emptyHint?: string;
}) {
  if (channels.length === 0) {
    return <SectionEmpty hint={emptyHint} text={emptyText} />;
  }
  return (
    <AnimatePresence initial={false}>
      {pinnedFirst(channels).map((channel) => (
        <ChannelRow
          animateOrder={animateOrder}
          channel={channel}
          emphasis={emphasis}
          key={channel.id}
          projects={projects}
        />
      ))}
    </AnimatePresence>
  );
}

/** One of Group and Direct: a header, and the conversations membership puts there. */
function MembershipSection({
  id,
  channels,
  collapsed,
  onToggle,
  searching,
  projects,
  emphasis,
  animateOrder,
}: {
  id: "group" | "direct";
  channels: ChannelSummary[];
  collapsed: boolean;
  onToggle: () => void;
  searching: boolean;
  projects: Project[];
  emphasis: MessageListEmphasis;
  animateOrder: boolean;
}) {
  if (!sectionVisible(channels.length, searching)) return null;
  const bodyId = `sidebar-section-${id}`;
  return (
    <div>
      <SectionHeader
        bodyId={bodyId}
        collapsed={collapsed}
        count={channels.length}
        onToggle={onToggle}
        title={SECTION_TITLES[id]}
      />
      <div hidden={collapsed} id={bodyId}>
        <SectionRows
          animateOrder={animateOrder}
          channels={channels}
          emphasis={emphasis}
          emptyText={SECTION_EMPTY[id]}
          projects={projects}
        />
      </div>
    </div>
  );
}

/**
 * One folder's header, and what is filed in it.
 *
 * Folded on its own, without being remembered: the section's fold is the one a person asked to keep
 * across devices, and a folder inside it is a detail of the moment they are looking at it. Rename is
 * inline — the name is all a folder has — and Delete is confirmed by a dialog that says the
 * conversations stay.
 */
function FolderBlock({
  folder,
  projects,
  emphasis,
  animateOrder,
}: {
  folder: Folder;
  projects: Project[];
  emphasis: MessageListEmphasis;
  animateOrder: boolean;
}) {
  const queryClient = useQueryClient();
  const rename = useMutation(renameProjectMutationOptions(queryClient));
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const bodyId = `sidebar-project-${folder.project.id}`;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
          <div className="flex items-center gap-1 px-1.5">
            {renaming ? (
              <div className="min-w-0 flex-1">
                <ProjectNameInput
                  initialName={folder.project.name}
                  onCancel={() => {
                    setRenaming(false);
                    rename.reset();
                  }}
                  onSubmit={(name) => {
                    rename.mutate(
                      { projectId: folder.project.id, name },
                      { onSuccess: () => setRenaming(false) },
                    );
                  }}
                  pending={rename.isPending}
                  placeholder="Project name"
                  problem={rename.error?.message}
                  submitLabel="Rename project"
                />
              </div>
            ) : (
              <button
                aria-controls={bodyId}
                aria-expanded={!collapsed}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                onClick={() => setCollapsed((folded) => !folded)}
                type="button"
              >
                <IconChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    !collapsed && "rotate-90",
                  )}
                />
                <span className="truncate text-sidebar-foreground text-sm">
                  {folder.project.name}
                </span>
                <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                  {folder.channels.length}
                </span>
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setRenaming(true)}>
            <IconPencil />
            Rename project…
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => setConfirming(true)}
            variant="destructive"
          >
            <IconTrash />
            Delete project…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div hidden={collapsed} id={bodyId}>
        <SectionRows
          animateOrder={animateOrder}
          channels={folder.channels}
          emphasis={emphasis}
          emptyText="No conversations in this project yet"
          projects={projects}
        />
      </div>
      <DeleteProjectDialog
        onOpenChange={setConfirming}
        open={confirming}
        project={folder.project}
      />
    </div>
  );
}

/**
 * The Projects section: the "+" that makes a folder, each folder, and the hint while there are none.
 *
 * The new folder is named where it will be drawn — an inline box under the header — rather than in
 * a dialog, so the person types the name in the place the row appears. Escape leaves nothing behind.
 */
function ProjectsSection({
  folders,
  projects,
  collapsed,
  onToggle,
  searching,
  emphasis,
  animateOrder,
}: {
  folders: Folder[];
  projects: Project[];
  collapsed: boolean;
  onToggle: () => void;
  searching: boolean;
  emphasis: MessageListEmphasis;
  animateOrder: boolean;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(createProjectMutationOptions(queryClient));
  const [creating, setCreating] = useState(false);
  const bodyId = "sidebar-section-projects";
  const conversationCount = folders.reduce(
    (total, folder) => total + folder.channels.length,
    0,
  );
  /*
   * While searching, a folder is drawn only if what is filed in it matched: an empty folder beside
   * the box would be a heading for results that do not exist, and the ones that do are the answer.
   */
  const shown = searching
    ? folders.filter((folder) => folder.channels.length > 0)
    : folders;

  if (!sectionVisible(conversationCount, searching) && !creating) return null;

  return (
    <div>
      <SectionHeader
        action={
          <button
            aria-label="New project"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onClick={() => setCreating(true)}
            type="button"
          >
            <IconPlus className="size-3.5" />
          </button>
        }
        bodyId={bodyId}
        collapsed={collapsed}
        count={conversationCount}
        onToggle={onToggle}
        title={SECTION_TITLES.projects}
      />
      <div hidden={collapsed} id={bodyId}>
        {creating ? (
          <ProjectNameInput
            onCancel={() => {
              setCreating(false);
              create.reset();
            }}
            onSubmit={(name) =>
              create.mutate(name, {
                onSuccess: () => setCreating(false),
              })
            }
            pending={create.isPending}
            placeholder="Project name"
            problem={create.error?.message}
            submitLabel="Create project"
          />
        ) : null}
        {shown.length === 0 ? (
          <SectionEmpty
            hint={SECTION_EMPTY_HINT.projects}
            text={SECTION_EMPTY.projects}
          />
        ) : (
          shown.map((folder) => (
            <FolderBlock
              animateOrder={animateOrder}
              emphasis={emphasis}
              folder={folder}
              key={folder.project.id}
              projects={projects}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function ConversationSections({
  channels,
  projects,
  collapsed,
  onToggle,
  searching,
  emphasis,
  animateOrder,
}: {
  /** The roster, already narrowed by the search box. */
  channels: ChannelSummary[];
  projects: Project[];
  /** Which sections this person folded, as their account has it. */
  collapsed: SidebarSections;
  onToggle: (id: SidebarSectionId) => void;
  searching: boolean;
  emphasis: MessageListEmphasis;
  animateOrder: boolean;
}) {
  const sections = conversationSections(channels, projects);
  // A search opens what it matched: a result inside a folded section is an answer the person was
  // told about and not shown. The fold they chose is drawn over again as soon as the box is empty.
  const folded = collapsedSections(collapsed, searching);

  return (
    <>
      <MembershipSection
        animateOrder={animateOrder}
        channels={sections.group}
        collapsed={folded.group}
        emphasis={emphasis}
        id="group"
        onToggle={() => onToggle("group")}
        projects={projects}
        searching={searching}
      />
      <MembershipSection
        animateOrder={animateOrder}
        channels={sections.direct}
        collapsed={folded.direct}
        emphasis={emphasis}
        id="direct"
        onToggle={() => onToggle("direct")}
        projects={projects}
        searching={searching}
      />
      <ProjectsSection
        animateOrder={animateOrder}
        collapsed={folded.projects}
        emphasis={emphasis}
        folders={sections.projects}
        onToggle={() => onToggle("projects")}
        projects={projects}
        searching={searching}
      />
    </>
  );
}