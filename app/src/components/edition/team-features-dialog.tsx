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
  IconSparkles,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BrandName } from "@/components/edition/brand-name";
import { BusinessOrb } from "@/components/edition/business-orb";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { BookingCalendar } from "@/components/onboarding/booking-calendar";
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

/** The dialog's first line, in big letters: where OpenBot for Business runs. */
export const DEPLOY_LINE =
  "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud.";

/**
 * What the team edition has and the personal edition does not, one short line each, in the three
 * things a team gets: its people, where its Bots work, and control over both.
 *
 * Shown where Admin would be: the list, beside the calendar to book a demo.
 */
export const TEAM_FEATURE_GROUPS: readonly {
  title: string;
  features: readonly { title: string; icon: Icon }[];
}[] = [
  {
    title: "For your whole team",
    features: [
      {
        title: "Sign-in with Google, Microsoft or custom SSO",
        icon: IconLogin2,
      },
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
      /*
       * Boundaries, team approval rules, auto-review guidance, permissions, the network allowlist
       * and one Bot's app actions are each described in words on their Admin screen, and each
       * replays the result over recorded activity before it is saved.
       */
      {
        title: "Policies in plain English, tested on past activity",
        icon: IconSparkles,
      },
      { title: "Governance for everyone", icon: IconChecks },
      { title: "A full audit trail, with export", icon: IconHistory },
    ],
  },
];

export const TEAM_FEATURES = TEAM_FEATURE_GROUPS.flatMap(
  (group) => group.features,
);

/*
 * Open or closed, for the one dialog the signed-in layout mounts. Module state so any entry in any
 * skin (the navigation, the home page's link, a Bot's computer line, the self-host banner) can open
 * it without a provider of its own.
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

/**
 * The OpenBot for Business page: where it runs, what it adds, and the calendar to book a demo, side
 * by side. Every OpenBot for Business entry in the app opens this, never the website.
 */
export function TeamFeaturesDialog() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  // Closed when the layout holding it goes (signing out), so it never reopens by itself later.
  useEffect(() => () => setOpen(false), []);
  /*
   * Focus starts on the list's own column, so the dialog opens at its title. Left to the default,
   * it lands on the first thing to tab to, and the column scrolls down to it.
   */
  const list = useRef<HTMLDivElement>(null);
  return (
    <Dialog onOpenChange={setOpen} open={isOpen}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-5xl"
        initialFocus={list}
      >
        {/*
         * What it is beside where to book it. Where there is room for both, each column scrolls on
         * its own; on a phone they stack and scroll as one, the calendar after the list.
         */}
        <div className="flex min-h-0 flex-col overflow-y-auto sm:grid sm:grid-cols-[3fr_2fr] sm:overflow-hidden">
          <div
            className="flex flex-col gap-6 p-6 outline-none sm:min-h-0 sm:overflow-y-auto sm:p-8"
            ref={list}
            tabIndex={-1}
          >
            <DialogHeader className="gap-3">
              <DialogTitle className="flex items-center gap-2">
                <OpenBotLogo className="size-6" />
                <BrandName>OpenBot for Business</BrandName>
              </DialogTitle>
              <DialogDescription className="font-semibold text-2xl text-balance text-foreground tracking-tight">
                {DEPLOY_LINE}
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
          </div>
          <BookDemo />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The booking calendar, in the dialog, so somebody picks a time without leaving OpenBot: the same
 * calendar as onboarding's Book a demo step, over the orb field the dialog has always shown.
 *
 * A calendar that can't load (offline, blocked, silent) gives way to Book a demo, which opens the
 * OpenBot for Business page in a new tab (on the Desktop, in the person's browser).
 */
function BookDemo() {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  // Calendly shows its own confirmation in the frame; there is nothing more to say here.
  const booked = useCallback(() => {}, []);
  return (
    <section
      aria-labelledby="book-a-demo-title"
      className="relative flex flex-col gap-4 border-border border-t bg-muted/50 p-6 sm:min-h-0 sm:overflow-y-auto sm:border-t-0 sm:border-l sm:pt-14"
    >
      <BusinessOrb orb={false} />
      <div className="relative flex flex-col gap-1">
        <h3 className="font-medium text-base" id="book-a-demo-title">
          Book a demo
        </h3>
        <p className="text-muted-foreground text-sm text-pretty">
          Pick a time to see a demo or scope a proof of concept with us.
        </p>
      </div>
      <div className="relative">
        {failed ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm" role="status">
              Couldn't load the calendar. Book a demo opens it in your browser.
            </p>
            {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
            <a
              className={cn(buttonVariants(), "w-full")}
              href={BUSINESS_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Book a demo
              <IconArrowUpRight aria-hidden="true" />
            </a>
          </div>
        ) : (
          <BookingCalendar onBooked={booked} onFailed={fail} />
        )}
      </div>
    </section>
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

/**
 * The personal edition's way to learn about a computer for each Bot. It opens the OpenBot for
 * Business dialog, over whatever it sits in.
 */
export function BusinessComputerLink() {
  return (
    <button
      className="w-fit text-left text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      onClick={openTeamFeatures}
      type="button"
    >
      Give each Bot its own computer with OpenBot for Business.
    </button>
  );
}
