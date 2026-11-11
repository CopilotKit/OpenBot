import {
  type Icon,
  IconBolt,
  IconPlug,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  deploymentCapabilitiesQueryOptions,
  offersMemory,
} from "@/lib/deployment/queries";
import { primitive } from "@/lib/primitives";

/**
 * Where a person can go in OpenBot, in one list.
 *
 * OpenBot's own sidebar draws it, and so does every skin that replaces the sidebar, so a destination
 * added here reaches every frame at once. One left out of a frame's own copy would simply be
 * missing from that skin, with nothing failing to say so.
 *
 * `section` says where OpenBot's sidebar puts each entry: `primary` destinations sit in its footer,
 * `account` ones in the menu under the person's name. A skin may group them its own way.
 *
 * The primary entries are what a person makes and comes back to: their Bots, then the every-Bot
 * pages of Routines, Memory, Skills and Apps (Connections: the apps a Bot reaches as you), in the
 * order of `lib/primitives.ts`. Each is somebody's own, so none is inside Admin. What is set once
 * for every Bot (the computer, approvals, activity) is in Settings, and a Bot's own is on its page
 * (`docs/how-openbot-works.md`).
 */
export type NavigationItem =
  | {
      kind?: undefined;
      id:
        | "bots"
        | "routines"
        | "memory"
        | "skills"
        | "connections"
        | "admin"
        | "settings";
      label: string;
      to:
        | "/bots"
        | "/routines"
        | "/memory"
        | "/skills"
        | "/connections"
        | "/admin"
        | "/settings";
      icon: Icon;
      section: "primary" | "account";
      /** Admin routes are guarded on the server; the entry is hidden from people who cannot open them. */
      adminOnly?: boolean;
      /** Shown only where OpenBot offers memory (see `offersMemory`). */
      memoryOnly?: boolean;
    }
  | {
      /**
       * Not a page: the personal edition's list of team features, opened as a dialog where Admin
       * would be. See `components/edition/team-features-dialog.tsx`, which every frame draws it
       * through.
       */
      kind: "dialog";
      id: "team-features";
      label: string;
      icon: Icon;
      section: "account";
    };

/** An entry that is a page. All but the team features list are. */
export type NavigationLink = Extract<NavigationItem, { to: string }>;

export function isNavigationLink(item: NavigationItem): item is NavigationLink {
  return item.kind !== "dialog";
}

const TEAM_FEATURES_ITEM: NavigationItem = {
  kind: "dialog",
  id: "team-features",
  label: "OpenBot for Business",
  icon: OpenBotLogo,
  section: "account",
};

export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "bots",
    label: "Bots",
    to: "/bots",
    icon: IconBolt,
    section: "primary",
  },
  {
    id: "routines",
    label: primitive("routines").label,
    to: "/routines",
    icon: primitive("routines").icon,
    section: "primary",
  },
  {
    id: "memory",
    label: primitive("memory").label,
    to: "/memory",
    icon: primitive("memory").icon,
    section: "primary",
    memoryOnly: true,
  },
  {
    id: "skills",
    label: primitive("skills").label,
    to: "/skills",
    icon: primitive("skills").icon,
    section: "primary",
  },
  {
    id: "connections",
    label: "Connections",
    to: "/connections",
    icon: IconPlug,
    section: "primary",
  },
  {
    id: "admin",
    label: "Admin",
    to: "/admin",
    icon: IconShieldLock,
    section: "account",
    adminOnly: true,
  },
  {
    id: "settings",
    label: "Settings",
    to: "/settings",
    icon: IconSettings,
    section: "account",
  },
];

/**
 * The destinations this person may open, in order. The personal edition has no Admin: the team
 * features entry takes its place, for everybody, since nobody there administers anybody else. It
 * has no Memory either (see `offersMemory`).
 */
export function navigationFor(
  role: string | undefined,
  edition: "team" | "personal" = "team",
): readonly NavigationItem[] {
  const offered = NAVIGATION.filter(
    (item) =>
      item.kind === "dialog" || !item.memoryOnly || offersMemory({ edition }),
  );
  if (edition === "personal") {
    return offered.map((item) =>
      item.id === "admin" ? TEAM_FEATURES_ITEM : item,
    );
  }
  return offered.filter(
    (item) => item.kind === "dialog" || !item.adminOnly || role === "admin",
  );
}

/**
 * `navigationFor` the signed-in person, on this deployment's edition. Memory waits for the edition,
 * so the personal edition never shows it for a moment.
 */
export function useNavigationItems(): readonly NavigationItem[] {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const items = navigationFor(user?.role, capabilities?.edition ?? "team");
  return capabilities
    ? items
    : items.filter((item) => item.kind === "dialog" || !item.memoryOnly);
}
