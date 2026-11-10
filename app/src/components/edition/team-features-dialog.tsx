import {
  type Icon,
  IconAdjustments,
  IconArrowUpRight,
  IconChecks,
  IconDeviceDesktop,
  IconHistory,
  IconListCheck,
  IconLogin2,
  IconMessages,
  IconSchool,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useSyncExternalStore } from "react";
import { BrandName } from "@/components/edition/brand-name";
import { BusinessOrb } from "@/components/edition/business-orb";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NavigationItem } from "@/lib/navigation";
import { BUSINESS_URL } from "@/lib/openbot-for-business";
import { cn } from "@/lib/utils";

/**
 * What the team edition has and the personal edition does not, one short line each, in the three
 * things a team gets: its people, where its Bots work, and control over both.
 *
 * Shown where Admin would be: the list, and one way to ask about it.
 */
export const TEAM_FEATURE_GROUPS: readonly {
  title: string;
  features: readonly { title: string; icon: Icon }[];
}[] = [
  {
    title: "For your whole team",
    features: [
      { title: "Sign-in with Google, Microsoft or Okta", icon: IconLogin2 },
      { title: "People, roles and admins", icon: IconUsers },
      { title: "Bots shared with your whole team", icon: IconUsersGroup },
      { title: "Learning shared across the team", icon: IconSchool },
    ],
  },
  {
    title: "Where your Bots work",
    features: [
      { title: "Bots in Slack and Microsoft Teams", icon: IconMessages },
      { title: "A computer for each Bot", icon: IconDeviceDesktop },
    ],
  },
  {
    title: "In control",
    features: [
      {
        title: "Controls over models, apps and networks",
        icon: IconAdjustments,
      },
      { title: "Rules every Bot follows", icon: IconListCheck },
      { title: "Governance for everyone", icon: IconChecks },
      { title: "A full audit trail, with export", icon: IconHistory },
    ],
  },
];

export const TEAM_FEATURES = TEAM_FEATURE_GROUPS.flatMap(
  (group) => group.features,
);

/*
 * Open or closed, for the one dialog the signed-in layout mounts. Module state so any navigation
 * entry in any skin can open it without a provider of its own.
 */
let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  open = next;
  for (const listener of listeners) listener();
}

export function openTeamFeatures() {
  setOpen(true);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function TeamFeaturesDialog() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  // Closed when the layout holding it goes (signing out), so it never reopens by itself later.
  useEffect(() => () => setOpen(false), []);
  return (
    <Dialog onOpenChange={setOpen} open={isOpen}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <div className="grid min-h-0 sm:grid-cols-[2fr_3fr]">
          {/*
           * OpenBot's mark over the orb and its field, which fill the panel. Only where there is room
           * beside the list.
           */}
          <div className="relative hidden min-h-96 border-border border-r bg-muted/50 p-6 sm:block">
            <BusinessOrb />
            <div className="relative flex items-center gap-2 font-medium">
              <OpenBotLogo className="size-7" />
              <BrandName>OpenBot</BrandName>
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6 sm:p-8">
            <DialogHeader>
              <DialogTitle className="text-xl">
                <BrandName>OpenBot for Business</BrandName>
              </DialogTitle>
              <DialogDescription>
                Everything you have here, on prem and for a whole team.
              </DialogDescription>
            </DialogHeader>
            {TEAM_FEATURE_GROUPS.map((group) => (
              <section className="flex flex-col gap-3" key={group.title}>
                <h3 className="font-medium text-muted-foreground text-xs">
                  {group.title}
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {group.features.map((feature) => (
                    <li className="flex items-center gap-3" key={feature.title}>
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
                        <feature.icon aria-hidden="true" className="size-4" />
                      </span>
                      {feature.title}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="text-muted-foreground text-sm">And tons more…</p>
            {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
            <a
              className={cn(buttonVariants(), "mt-2 w-full")}
              href={BUSINESS_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Talk to us
              <IconArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The element a navigation entry is drawn as, for a `render` prop: a link to its page, or for the
 * team features entry a button that opens the dialog. Every frame that draws the navigation list
 * goes through here, so a skin cannot draw that entry as a link to nowhere.
 */
export function navigationRender(
  item: NavigationItem,
  props: NavigationTargetProps = {},
): React.ReactElement {
  if (item.kind === "dialog") {
    /*
     * A real button. A Base UI menu item drawing it has to be told (`nativeButton`), or it treats
     * the element as a non-button and drops the click event its own handler reads. Full width,
     * because a button shrinks to its text where the links beside it fill their row.
     */
    return (
      <button
        {...props}
        className={cn("w-full text-left", props.className)}
        onClick={(event) => {
          props.onClick?.(event);
          openTeamFeatures();
        }}
        type="button"
      />
    );
  }
  return <Link {...props} to={item.to} />;
}

type NavigationTargetProps = {
  /** For a page only: how the link looks while it is the current page. */
  activeProps?: LinkProps["activeProps"];
  "aria-current"?: "page";
  "aria-label"?: string;
  children?: React.ReactNode;
  className?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
};

/** The same, as a component, for a frame that draws an entry with children of its own. */
export function NavigationTarget({
  activeProps,
  item,
  onClick,
  ...props
}: NavigationTargetProps & { item: NavigationItem }) {
  if (item.kind === "dialog") {
    return (
      <button
        {...props}
        className={cn("w-full text-left", props.className)}
        onClick={(event) => {
          onClick?.(event);
          openTeamFeatures();
        }}
        type="button"
      />
    );
  }
  return (
    <Link {...props} activeProps={activeProps} onClick={onClick} to={item.to} />
  );
}

/** The personal edition's way to learn about a computer for each Bot. */
export function BusinessComputerLink() {
  return (
    <a
      className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      href={BUSINESS_URL}
      rel="noopener noreferrer"
      target="_blank"
    >
      Give each Bot its own computer with OpenBot for Business.
    </a>
  );
}
