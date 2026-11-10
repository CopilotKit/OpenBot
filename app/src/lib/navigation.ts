import {
  type Icon,
  IconBolt,
  IconBox,
  IconClock,
  IconPlug,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

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
 * Bots, Routines, Capabilities and Connections are each somebody's own, which is why they sit beside
 * each other and not inside Admin. Routines are the work your Bots do on a schedule, every Bot's on
 * one page, where somebody who wants a Bot to do something every morning looks first. Capabilities
 * are your skills and what your Bots remember about you; Connections are the apps a Bot reaches as
 * you. Capabilities links to `/capabilities` rather than a tab, so it stays lit on both of its tabs.
 */
export type NavigationItem =
  | {
      kind?: undefined;
      id:
        | "bots"
        | "routines"
        | "capabilities"
        | "connections"
        | "admin"
        | "settings";
      label: string;
      to:
        | "/bots"
        | "/routines"
        | "/capabilities"
        | "/connections"
        | "/admin"
        | "/settings";
      icon: Icon;
      section: "primary" | "account";
      /** Admin routes are guarded on the server; the entry is hidden from people who cannot open them. */
      adminOnly?: boolean;
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

/** An entry that is a page. Bots, Capabilities, Connections and Settings always are. */
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
    label: "Routines",
    to: "/routines",
    icon: IconClock,
    section: "primary",
  },
  {
    id: "capabilities",
    label: "Capabilities",
    to: "/capabilities",
    icon: IconBox,
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
 * features entry takes its place, for everybody, since nobody there administers anybody else. It has
 * no Capabilities either: a person's skills and what their Bots remember are on the Bots page, so
 * there is one place fewer to go.
 */
export function navigationFor(
  role: string | undefined,
  edition: "team" | "personal" = "team",
): readonly NavigationItem[] {
  if (edition === "personal") {
    return NAVIGATION.filter((item) => item.id !== "capabilities").map(
      (item) => (item.id === "admin" ? TEAM_FEATURES_ITEM : item),
    );
  }
  return NAVIGATION.filter(
    (item) => item.kind === "dialog" || !item.adminOnly || role === "admin",
  );
}

/** `navigationFor` the signed-in person, on this deployment's edition. */
export function useNavigationItems(): readonly NavigationItem[] {
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  return navigationFor(user?.role, capabilities?.edition ?? "team");
}
