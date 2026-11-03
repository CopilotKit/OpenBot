import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useSyncExternalStore } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NavigationItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * What the team edition has and the personal edition does not.
 *
 * Shown where Admin would be. A list and nothing else: no links, no buttons beyond closing it, so
 * the place Admin used to be says what there is without sending anybody anywhere.
 */
export const TEAM_FEATURES: readonly { title: string; description: string }[] =
  [
    {
      title: "Sign-in for your team",
      description:
        "People sign in with Google, Microsoft, Okta, or your company's own provider.",
    },
    {
      title: "People and roles",
      description:
        "See who has signed in, make someone an admin, or remove their access.",
    },
    {
      title: "Controls for everyone",
      description:
        "Choose what people may use, which models and apps are allowed, and where Bot computers can connect.",
    },
    {
      title: "Boundaries",
      description: "Write rules that every Bot follows before it acts.",
    },
    {
      title: "Team approvals",
      description:
        "Set approval rules for everyone, and approve the use of shared accounts.",
    },
    {
      title: "Team Bots",
      description: "Share a Bot with your whole team.",
    },
    {
      title: "Slack and Microsoft Teams",
      description: "Add Bots to your team's conversations in Slack and Teams.",
    },
    {
      title: "A computer for each Bot",
      description: "Give a Bot a computer of its own.",
    },
    {
      title: "Learning across the team",
      description:
        "Bots learn from everyone's recordings, and an admin decides what is shared.",
    },
    {
      title: "Full audit trail",
      description: "Review and export everything every Bot did for anyone.",
    },
  ];

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>OpenBot for Business</DialogTitle>
          <DialogDescription>
            These features come with OpenBot for Business.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <ul className="flex flex-col gap-3">
            {TEAM_FEATURES.map((feature) => (
              <li key={feature.title}>
                <p className="font-medium text-sm">{feature.title}</p>
                <p className="text-muted-foreground text-sm">
                  {feature.description}
                </p>
              </li>
            ))}
          </ul>
        </DialogBody>
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
