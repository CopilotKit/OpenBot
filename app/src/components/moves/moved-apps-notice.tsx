import { IconPlugConnected } from "@tabler/icons-react";
import { Link, useLocation } from "@tanstack/react-router";
import { PageRows } from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { stillToReconnect } from "@/lib/moves/moved-apps";
import { useMovedApps } from "@/lib/moves/use-moved-apps";

/**
 * On Connections: how many apps from the person's move still need connecting, and the way to the
 * list that works through them. One row, never a second copy of the list. Nothing once every app is
 * connected or dismissed, and nothing on an OpenBot nobody moved to.
 */
export function MovedAppsNotice() {
  const { remaining } = useMovedApps();
  if (remaining.length === 0) return null;
  return (
    <PageRows>
      <Item data-moved-apps-notice="" size="sm">
        <RowMark>
          <IconPlugConnected className="size-4" />
        </RowMark>
        <ItemContent className="min-w-0">
          <ItemTitle>{stillToReconnect(remaining.length)}</ItemTitle>
          <ItemDescription>
            {remaining.length === 1 ? "It was" : "They were"} connected in
            OpenBot on your computer.
          </ItemDescription>
        </ItemContent>
        <ItemActions className="shrink-0">
          <Button render={<Link to="/reconnect" />} size="sm">
            Reconnect
          </Button>
        </ItemActions>
      </Item>
    </PageRows>
  );
}

/** Where the bar would only repeat what the page already says. */
const SAID_ON_THE_PAGE = ["/reconnect", "/connections"];

/**
 * The same, as a slim bar over every other page (beside the plan and update bars), so somebody who
 * goes straight to their conversations still sees there is something to do. Not on the reconnect
 * list or Connections, which say it themselves.
 */
export function MovedAppsBanner() {
  const { pathname } = useLocation();
  const { remaining } = useMovedApps();
  const here = SAID_ON_THE_PAGE.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (here || remaining.length === 0) return null;
  return (
    <aside
      aria-label="Apps to reconnect"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      <p className="text-foreground">{stillToReconnect(remaining.length)}.</p>
      <Button
        // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
        className="px-0 text-foreground underline"
        render={<Link to="/reconnect" />}
        size="sm"
        variant="link"
      >
        Reconnect
      </Button>
    </aside>
  );
}
