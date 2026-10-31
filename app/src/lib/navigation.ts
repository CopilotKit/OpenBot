import {
  type Icon,
  IconBolt,
  IconBox,
  IconPlug,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";

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
 * Bots, Capabilities and Connections are each somebody's own, which is why they sit beside each
 * other and not inside Admin. Capabilities are your skills and what your Bots remember about you;
 * Connections are the apps a Bot reaches as you. Capabilities links to `/capabilities` rather than
 * a tab, so it stays lit on both of its tabs.
 */
export type NavigationItem = {
  id: "bots" | "capabilities" | "connections" | "admin" | "settings";
  label: string;
  to: "/bots" | "/capabilities" | "/connections" | "/admin" | "/settings";
  icon: Icon;
  section: "primary" | "account";
  /** Admin routes are guarded on the server; the entry is hidden from people who cannot open them. */
  adminOnly?: boolean;
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

/** The destinations this person may open, in order. */
export function navigationFor(
  role: string | undefined,
): readonly NavigationItem[] {
  return NAVIGATION.filter((item) => !item.adminOnly || role === "admin");
}

/** `navigationFor` the signed-in person. */
export function useNavigationItems(): readonly NavigationItem[] {
  const { data: user } = useQuery(currentUserQueryOptions());
  return navigationFor(user?.role);
}
