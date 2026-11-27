import { useRouterState } from "@tanstack/react-router";
import type { JSX } from "react";
import { SectionPanel } from "@/components/layout/section-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Strip } from "@/components/layout/strip";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { wasSignedIn } from "@/lib/auth/was-signed-in";
import {
  beforeCapabilities,
  isNavigationLink,
  navigationFor,
} from "@/lib/navigation";
import {
  CONVERSATIONS,
  type SectionId,
  type SectionRoute,
  sectionForPath,
  sectionHasPanel,
} from "@/lib/sections";
import { cn } from "@/lib/utils";
import { useSkinId } from "@/skins/store";
import { skinDrawsOwnFrame } from "@/skins/types";

/*
 * The pages `_authed` draws without `_app`'s frame. Admin and Settings have a frame of their own,
 * with a different sidebar, so the app's frame drawn there would change shape when the page came.
 */
const FRAMELESS = ["/onboarding", "/terms", "/sign-in", "/admin", "/settings"];

/*
 * The sections as the real strip draws them on its first render, before the edition and the role
 * are known (`useNavigationItems`): without Memory, which the personal edition never has, so a
 * `/memory` that is no section yet opens on Conversations here as it does there. No question is
 * asked of the server. A skeleton is drawn while those questions run.
 */
const SECTION_ROUTES: readonly SectionRoute[] = beforeCapabilities(
  navigationFor(undefined),
)
  .filter(isNavigationLink)
  .filter((item) => item.section === "primary")
  .map((item) => ({ id: item.id, to: item.to }));

const PANEL_TITLES: Partial<Record<SectionId, string>> = {
  [CONVERSATIONS]: "Conversations",
  bots: "Bots",
};

const WIDTHS = ["w-3/5", "w-4/5", "w-1/2", "w-2/3", "w-3/4"] as const;
const PANEL_ROWS = 8;

// The pulse stands still when less motion is asked for, as `LoadingRows`' does.
const BAR = "motion-reduce:animate-none";

function outsideTheFrame(pathname: string): boolean {
  return FRAMELESS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** A circle where the orb or the person's avatar will be: 28px in a 36px square, as theirs are. */
function RoundMark() {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center">
      <Skeleton className={cn("size-7 rounded-full", BAR)} />
    </div>
  );
}

/**
 * One section on the strip with neither icon nor name yet. The classes are `StripItem`'s (strip.tsx),
 * whose icon and name are the person's menu, so each placeholder is as tall as the section it holds.
 */
function StripRow() {
  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-1 px-0.5 py-1">
      <Skeleton className={cn("size-9 rounded-lg", BAR)} />
      <Skeleton className={cn("h-3 w-8", BAR)} />
    </div>
  );
}

/**
 * One conversation that hasn't loaded. The classes are `ChannelRow`'s (conversations-panel.tsx) and
 * `ChannelItemContent`'s, which need the conversation itself: a 32px avatar beside two lines.
 */
function ConversationRow({ index }: { index: number }) {
  return (
    <div className="flex w-full flex-row items-center gap-2 rounded-lg px-2.5 py-2">
      <Skeleton className={cn("size-8 shrink-0 rounded-full", BAR)} />
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-center">
          <Skeleton
            className={cn("h-3.5", WIDTHS[index % WIDTHS.length], BAR)}
          />
        </div>
        <div className="mt-px flex h-4 items-center">
          <Skeleton className={cn("h-3 w-2/5", BAR)} />
        </div>
      </div>
    </div>
  );
}

/**
 * The app's frame with nothing in it, for somebody who was signed in last time, while the sign-in
 * checks run: the strip, the panel where the open page has one, and the page's empty panel. Drawn
 * from the same shell, strip and panel as `AppFrame` (routes/_authed/_app.tsx), so when the real
 * frame takes its place nothing moves.
 *
 * Nothing for somebody who may not be signed in (they may be on their way to the sign-in screen),
 * under a skin that draws its own frame, or on a page `_app` doesn't frame.
 */
export function AppFrameSkeleton(): JSX.Element | null {
  const ownFrame = skinDrawsOwnFrame(useSkinId());
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  if (!wasSignedIn() || ownFrame || outsideTheFrame(pathname)) return null;

  // A page no section owns opens on Conversations, as `SectionProvider` does on a first page.
  const section = sectionForPath(pathname, SECTION_ROUTES) ?? CONVERSATIONS;
  const panel = sectionHasPanel(section);

  return (
    <SidebarShell
      className="h-svh overflow-hidden"
      panel={{ available: panel, reveal: () => {} }}
    >
      {/* The classes are `AppSidebar`'s (app-sidebar.tsx), which needs the person's sections. */}
      <Sidebar
        aria-hidden="true"
        className="overflow-hidden"
        collapsible="icon"
        variant="inset"
      >
        <div className="flex h-full min-h-0 flex-row" data-desktop-drag="">
          <Strip footer={<RoundMark />} header={<RoundMark />}>
            {[CONVERSATIONS, ...SECTION_ROUTES.map(({ id }) => id)].map(
              (id) => (
                <StripRow key={id} />
              ),
            )}
          </Strip>
          {panel ? (
            <SectionPanel
              className="group-data-[collapsible=icon]:hidden"
              title={PANEL_TITLES[section]}
            >
              <SidebarContent className="overflow-hidden">
                <SidebarMenu>
                  {/* The classes are `ConversationsPanel`'s, with its search box's height. */}
                  <SidebarGroup className="gap-px pt-0">
                    <Skeleton className={cn("h-9 rounded-lg", BAR)} />
                    <div className="h-2 w-full" />
                    {Array.from({ length: PANEL_ROWS }, (_, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity of their own.
                      <ConversationRow index={index} key={index} />
                    ))}
                  </SidebarGroup>
                </SidebarMenu>
              </SidebarContent>
            </SectionPanel>
          ) : null}
        </div>
      </Sidebar>
      <SidebarInset aria-busy="true" className="min-h-0 overflow-hidden" />
    </SidebarShell>
  );
}
