import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useSyncExternalStore } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NavigationItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * What the team edition has and the personal edition does not, one short line each.
 *
 * Shown where Admin would be. A list and nothing else: no links, no buttons beyond closing it, so
 * the place Admin used to be says what there is without sending anybody anywhere.
 */
export const TEAM_FEATURES: readonly { title: string }[] = [
  { title: "Sign-in with Google, Microsoft or Okta" },
  { title: "People, roles and admins" },
  { title: "Controls over models, apps and networks" },
  { title: "Rules every Bot follows" },
  { title: "Approval rules for everyone" },
  { title: "Bots shared with your whole team" },
  { title: "Bots in Slack and Microsoft Teams" },
  { title: "A computer for each Bot" },
  { title: "Learning shared across the team" },
  { title: "A full audit trail, with export" },
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
      <DialogContent className="max-w-2xl p-6">
        <div className="grid gap-6 sm:grid-cols-[minmax(0,15rem)_1fr]">
          {/* The illustration's place, until there is one. Beside the list only where there is room. */}
          <div
            aria-hidden="true"
            className="hidden aspect-square w-full rounded-lg bg-muted sm:block"
            data-testid="business-illustration"
          />
          <div className="flex min-w-0 flex-col gap-3">
            <DialogHeader>
              <DialogTitle>OpenBot for Business</DialogTitle>
              <DialogDescription className="sr-only">
                These features come with OpenBot for Business.
              </DialogDescription>
            </DialogHeader>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
              {TEAM_FEATURES.map((feature) => (
                <li key={feature.title}>{feature.title}</li>
              ))}
            </ul>
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
