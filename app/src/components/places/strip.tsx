import { Toolbar } from "@base-ui/react/toolbar";
import { IconDots, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import {
  accountMenuClassName,
  UserAvatar,
  useAccountNames,
} from "@/components/app-sidebar/account-label";
import {
  AccountMenuItems,
  type useAccountMenu,
} from "@/components/app-sidebar/account-menu-items";
import {
  RecordingDot,
  recordingTooltip,
  useLiveRecording,
} from "@/components/browser/browser-nav-item";
import { BrandName } from "@/components/edition/brand-name";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isNavigationLink, useNavigationItems } from "@/lib/navigation";
import { PLACES, type PlaceId } from "@/lib/places/places";
import { setPlace, usePlaceId, usePlaceOrder } from "@/lib/places/store";
import { cn } from "@/lib/utils";
import { NewMenu } from "./new-menu";
import { PLACE_LISTS } from "./place-panel";
import type { PlaceEntry } from "./place-row";

/** Square, with the sidebar's hover rather than `muted`, which is nearly the sidebar's own colour. */
const stripButtonClassName = cn(
  buttonVariants({ variant: "ghost", size: "icon-lg" }),
  "relative hover:bg-foreground/5 aria-pressed:bg-foreground/5 dark:hover:bg-foreground/5",
);

/** A place's button: it changes the list beside the strip and leaves the page where it is. */
function PlaceButton({
  id,
  entry,
  current,
}: {
  id: PlaceId;
  entry: PlaceEntry;
  current: boolean;
}) {
  const { label, icon: PlaceIcon } = PLACES[id];
  const descId = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toolbar.Button
            aria-describedby={entry.Badge ? descId : undefined}
            aria-label={label}
            aria-pressed={current}
            className={stripButtonClassName}
            onClick={() => setPlace(id)}
          />
        }
      >
        <PlaceIcon className="size-5" />
        {entry.Badge ? (
          <span id={descId}>
            <entry.Badge />
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent side="right">
        <BrandName>{label}</BrandName>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A strip button that opens a menu (`children`, the menu's content). Its tooltip names it, and
 * never while the menu is open.
 */
function StripMenu({
  label,
  tooltip,
  trigger,
  children,
}: {
  label: string | undefined;
  tooltip: ReactNode;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
      <Tooltip disabled={menuOpen}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Toolbar.Button
                  aria-label={label}
                  className={stripButtonClassName}
                />
              }
            />
          }
        >
          {trigger}
        </TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
      {children}
    </DropdownMenu>
  );
}

/** The "+": the New menu, which offers a conversation, a Bot, a routine or a recorded task. */
function NewButton() {
  const { setOpenMobile } = useSidebar();
  return (
    <Tooltip>
      <NewMenu
        onNavigate={() => setOpenMobile(false)}
        trigger={
          <TooltipTrigger
            render={<Toolbar.Button className={stripButtonClassName} />}
          >
            <IconPlus className="size-5" />
          </TooltipTrigger>
        }
      />
      <TooltipContent side="right">New</TooltipContent>
    </Tooltip>
  );
}

/**
 * The main menu's destinations that are not places. Bots and Routines are places of their own, so
 * they are not repeated here. While a Recorder records, More and Skills carry its red dot: teaching
 * a Bot a task is how a skill is recorded.
 */
function MoreMenu() {
  const recording = useLiveRecording();
  const items = useNavigationItems()
    .filter(isNavigationLink)
    .filter((item) => item.section === "primary")
    .filter((item) => item.id !== "bots" && item.id !== "routines");
  return (
    <StripMenu
      label="More"
      tooltip={recordingTooltip(recording, "More").children}
      trigger={
        <>
          <IconDots className="size-5" />
          {recording ? (
            <span className="absolute top-0.5 right-0.5 flex">
              <RecordingDot {...recording} />
            </span>
          ) : null}
        </>
      }
    >
      <DropdownMenuContent align="end" side="right" sideOffset={8}>
        {items.map((item) => (
          <DropdownMenuItem key={item.id} render={<Link to={item.to} />}>
            <item.icon />
            {item.label}
            {item.id === "skills" && recording ? (
              <RecordingDot {...recording} />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </StripMenu>
  );
}

/** The person's avatar, opening the account menu. The tooltip names them and their organization. */
function AccountButton({
  accountMenu,
}: {
  accountMenu: ReturnType<typeof useAccountMenu>;
}) {
  const { person, organization } = useAccountNames();
  const { setOpenMobile } = useSidebar();
  return (
    <StripMenu
      label={person ?? "Account"}
      tooltip={
        <span className="grid min-w-0 *:break-words">
          <span>{person}</span>
          {organization ? (
            <span className="text-background/70">{organization}</span>
          ) : null}
        </span>
      }
      trigger={<UserAvatar />}
    >
      <DropdownMenuContent
        align="end"
        className={accountMenuClassName}
        side="right"
        sideOffset={8}
      >
        <AccountMenuItems
          menu={accountMenu}
          onNavigate={() => setOpenMobile(false)}
        />
      </DropdownMenuContent>
    </StripMenu>
  );
}

/**
 * The places down the sidebar's left edge, then New, More and the account menu at
 * the foot. One tab stop: the arrow keys move between its buttons.
 */
export function Strip({
  accountMenu,
}: {
  /** Read by the sidebar, which stays mounted while the menu's contents do not (see `useAccountMenu`). */
  accountMenu: ReturnType<typeof useAccountMenu>;
}) {
  const place = usePlaceId();
  const order = usePlaceOrder();
  return (
    <Toolbar.Root
      className="flex w-12 shrink-0 flex-col items-center gap-1 py-2"
      orientation="vertical"
    >
      {order.map((id) => {
        const entry = PLACE_LISTS[id];
        return entry ? (
          <PlaceButton current={id === place} entry={entry} id={id} key={id} />
        ) : null;
      })}
      <div className="flex-1" />
      <NewButton />
      <MoreMenu />
      <AccountButton accountMenu={accountMenu} />
    </Toolbar.Root>
  );
}
