import { IconLogout, IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { useRef, useState } from "react";
import { BrandName } from "@/components/edition/brand-name";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { matchingChannels } from "@/lib/channels/order";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { isNavigationLink, useNavigationItems } from "@/lib/navigation";
import { projectsQueryOptions } from "@/lib/projects/queries";
import { useMessageListEmphasis } from "@/lib/settings/message-list";
import { useSidebarSections } from "@/lib/settings/sidebar-sections";
import { BotsNavBadge } from "../bot-profile/attention";
import { BrowserNavItem } from "../browser/browser-nav-item";
import { navigationRender } from "../edition/team-features-dialog";
import { OpenBotVersion } from "../layout/openbot-version";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ChannelPagination } from "./channel-pagination";
import { ConversationSections } from "./conversation-sections";
import { useSignOut } from "./use-sign-out";

/*
 * The roster's two reading rules live in `lib/channels/order.ts` now: the sidebar applies them per
 * section, and the skins' sheets still import them from here. Re-exported rather than moved out of
 * sight, because these are what other surfaces already reach for.
 */
export { hasUnseenActivity, isUnread } from "@/lib/channels/unread";
export { matchingChannels, pinnedFirst } from "@/lib/channels/order";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-[28px] shrink-0 bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // The folders, in the same breath as the roster: the Projects section is drawn from this read and
  // each channel's own `projectId`, so no row is asked about separately.
  const projects = useQuery(projectsQueryOptions());
  const sidebar = useSidebarSections();
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const visibleChannels = matchingChannels(channels.data, search);
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
  const navigation = useNavigationItems();
  const { setOpenMobile } = useSidebar();
  const projectsCache = projects.data ?? [];
  /*
   * Whether there is anything to section at all. Nothing is drawn until the roster has answered, so
   * a slow read shows a quiet sidebar rather than three sections announcing they are empty; and a
   * person with no conversations and no folders keeps the one card that tells them how to start.
   */
  const empty =
    channels.data?.length === 0 && projectsCache.length === 0 && !searching;

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            {/* The same hover as every other row in the sidebar, not the menu button's accent tint. */}
            <SidebarMenuButton
              className="font-semibold text-[14px] tracking-tighter h-full leading-tight hover:bg-foreground/5 hover:text-sidebar-foreground active:bg-foreground/5 active:text-sidebar-foreground"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <BrandName>{appConfig.brand.productName}</BrandName>
                </Link>
              )}
            />
            {/* Square, as tall as the name beside it, with the sidebar's hover rather than `muted`, which
                is nearly the sidebar's own colour. */}
            <Button
              aria-label="New conversation"
              className="aspect-square h-full w-auto hover:bg-foreground/5 dark:hover:bg-foreground/5"
              size="icon"
              variant="ghost"
              render={(props) => (
                <Link
                  {...props}
                  to="/channel/new"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <IconPlus />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px">
            <SidebarMenuItem>
              <InputGroup className="bg-background text-sm rounded-lg h-9">
                <InputGroupInput
                  aria-label="Search conversations"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search…"
                  value={search}
                />
                <InputGroupAddon>
                  <IconSearch />
                </InputGroupAddon>
              </InputGroup>
            </SidebarMenuItem>
            <div className="w-full h-2" />
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {searching && visibleChannels.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>
                      {channels.hasNextPage
                        ? "No loaded conversations match your search"
                        : "No conversations match your search"}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {channels.hasNextPage
                        ? "Load older conversations to search more of your history."
                        : `No conversation has “${search.trim()}” in its name or latest message.`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {empty ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>No conversations yet</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Start a conversation with a Bot and it shows up here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!empty && channels.data !== undefined ? (
              <ConversationSections
                animateOrder={animateOrder}
                channels={visibleChannels}
                collapsed={sidebar.sections}
                emphasis={emphasis}
                onToggle={sidebar.toggle}
                projects={projectsCache}
                searching={searching}
              />
            ) : null}
            <ChannelPagination
              query={channels}
              scrollRoot={scrollRoot}
              searching={searching}
            />
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          {navigation
            .filter(isNavigationLink)
            .filter((item) => item.section === "primary")
            .map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  className="hover:bg-foreground/5 h-10"
                  render={(props) => (
                    <Link
                      {...props}
                      to={item.to}
                      activeProps={{ className: "bg-foreground/5" }}
                    />
                  )}
                >
                  <div className="size-[28px] flex items-center justify-center">
                    <item.icon />
                  </div>
                  <span className="text-sm">{item.label}</span>
                  {/* What waits on you across every Bot; Bots lists them first. */}
                  {item.id === "bots" ? <BotsNavBadge /> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          {/* Your own browser, with the Recorder in it. Drawn only where OpenBot can run one for you. */}
          <BrowserNavItem />
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                {/* The name and the release the server runs, side by side: 80/20 of the row. */}
                <span className="grid min-w-0 flex-1 grid-cols-[4fr_1fr] items-center gap-2">
                  <span className="truncate text-sm trackint-tight">
                    {currentUser?.name || currentUser?.email}
                  </span>
                  <OpenBotVersion className="text-right text-[10px] leading-3 text-muted-foreground" />
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {navigation
                  .filter((item) => item.section === "account")
                  .map((item) => (
                    <DropdownMenuItem
                      className={userMenuItemClassName}
                      key={item.id}
                      nativeButton={item.kind === "dialog"}
                      // A link closes a narrow window's sheet as it is followed; a dialog has to
                      // close it itself, or the sheet waits behind the dialog.
                      render={navigationRender(
                        item,
                        item.kind === "dialog"
                          ? { onClick: () => setOpenMobile(false) }
                          : {},
                      )}
                    >
                      <item.icon />
                      <BrandName>{item.label}</BrandName>
                    </DropdownMenuItem>
                  ))}
                {signOutOffered ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    disabled={signOut.pending}
                    onClick={signOut.run}
                    variant="destructive"
                  >
                    <IconLogout />
                    Sign out
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}