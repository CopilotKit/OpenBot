import { type Href, router, usePathname } from "expo-router";
import { useCallback } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { organizationChoices } from "./api";
import { authClient } from "./auth";
import { BotOrb, cn, Icon, IconButton, PersonAvatar, Text } from "./components";
import { useDrawer } from "./drawer";
import {
  IconBell,
  IconBook,
  IconBrain,
  IconChecks,
  IconClock,
  IconMessages,
  IconPlug,
  IconRobot,
  IconSelector,
  IconX,
  type TablerIcon,
} from "./icons";
import { useLoad } from "./use-load";

/** The app's sections, in the order the web app lists a Bot's parts (openbot-copy, "The eight"). */
export const SECTIONS: {
  href: Href & string;
  label: string;
  icon: TablerIcon;
}[] = [
  { href: "/", label: "Conversations", icon: IconMessages },
  { href: "/bots", label: "Bots", icon: IconRobot },
  { href: "/routines", label: "Routines", icon: IconClock },
  { href: "/memory", label: "Memory", icon: IconBrain },
  { href: "/skills", label: "Skills", icon: IconBook },
  { href: "/connections", label: "Connections", icon: IconPlug },
];

/** What waits on the person, opened over the section they are in. */
const WAITING: { href: Href & string; label: string; icon: TablerIcon }[] = [
  { href: "/needs-you", label: "Needs you", icon: IconBell },
  { href: "/approvals", label: "Approvals", icon: IconChecks },
];

/** Opens a section as the bottom of the stack, the way a sidebar link replaces the page. */
export function openSection(href: Href & string) {
  if (router.canDismiss()) router.dismissAll();
  router.replace(href);
}

/**
 * The menu that slides in from the left: OpenBot, the app's sections, and who is signed in and
 * where, which opens their account.
 */
export function AppMenu() {
  const { setOpen } = useDrawer();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const loadOrganizations = useCallback(() => organizationChoices(), []);
  const organizations = useLoad(loadOrganizations, Boolean(session));
  const current = organizations.data?.organizations.find(
    (organization) => organization.id === organizations.data?.currentId,
  );
  const person = session?.user.name || session?.user.email || "";
  return (
    <View
      className="flex-1 bg-sidebar"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="flex-row items-center gap-2.5 px-4 py-3">
        <BotOrb seed="openbot" name="OpenBot" size={24} />
        <Text variant="label" className="flex-1 font-semibold">
          OpenBot
        </Text>
        <IconButton
          icon={IconX}
          label="Close menu"
          size="sm"
          onPress={() => setOpen(false)}
        />
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-0.5 px-2 py-2"
      >
        {SECTIONS.map((section) => {
          const selected = pathname === section.href;
          return (
            <Pressable
              key={section.href}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                setOpen(false);
                if (!selected) openSection(section.href);
              }}
              className={cn(
                "flex-row items-center gap-3 rounded-md px-2 py-2",
                selected ? "bg-sidebar-accent" : "active:bg-fill",
              )}
            >
              <View className="size-8 items-center justify-center rounded-md border border-sidebar-border bg-background">
                <Icon icon={section.icon} size={16} color="accent-muted" />
              </View>
              <Text
                variant="label"
                className={cn(
                  "text-sidebar-foreground",
                  selected && "text-sidebar-accent-foreground font-semibold",
                )}
              >
                {section.label}
              </Text>
            </Pressable>
          );
        })}
        <View className="mx-2 my-2 h-px bg-sidebar-border" />
        {WAITING.map((item) => (
          <Pressable
            key={item.href}
            accessibilityRole="button"
            onPress={() => {
              setOpen(false);
              router.push(item.href);
            }}
            className="flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-fill"
          >
            <View className="size-8 items-center justify-center rounded-md border border-sidebar-border bg-background">
              <Icon icon={item.icon} size={16} color="accent-muted" />
            </View>
            <Text variant="label" className="text-sidebar-foreground">
              {item.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {session ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Your account: ${person}${current?.name ? `, ${current.name}` : ""}`}
          onPress={() => {
            setOpen(false);
            router.push("/account");
          }}
          className="mx-2 mb-2 flex-row items-center gap-3 rounded-lg border border-sidebar-border bg-surface px-3 py-2.5 active:bg-fill"
        >
          <PersonAvatar name={person} size={32} />
          <View className="flex-1">
            <Text variant="label" numberOfLines={1} className="text-sm">
              {person}
            </Text>
            {current?.name ? (
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {current.name}
              </Text>
            ) : null}
          </View>
          <Icon icon={IconSelector} size={16} color="accent-muted" />
        </Pressable>
      ) : null}
    </View>
  );
}
