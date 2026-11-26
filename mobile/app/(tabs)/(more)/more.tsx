import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";
import { loadApprovalInbox } from "../../../src/api";
import { authClient } from "../../../src/auth";
import {
  Icon,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../../../src/components";
import {
  IconBook,
  IconBrain,
  IconChecks,
  IconChevronRight,
  IconClock,
  IconPlug,
} from "../../../src/icons";
import { useLoad } from "../../../src/use-load";

/**
 * More: the parts of the app that don't have a tab. The routines Bots run, what every Bot
 * remembers, knows and connects to, and the approval inbox.
 */
export default function More() {
  const { data: session } = authClient.useSession();
  // How many approvals and questions wait on the person, read again each time More comes to the front.
  const loadInbox = useCallback(() => loadApprovalInbox(), []);
  const inbox = useLoad(loadInbox, Boolean(session));
  const { refresh: refreshInbox } = inbox;
  useFocusEffect(
    useCallback(() => {
      void refreshInbox();
    }, [refreshInbox]),
  );
  const waiting =
    (inbox.data?.requests.filter((request) => request.status === "pending")
      .length ?? 0) + (inbox.data?.questions.length ?? 0);
  return (
    <ScrollScreen>
      <Rows>
        <Row
          icon={IconClock}
          title="Routines"
          description="What your Bots do for you on a schedule"
          onPress={() => router.push("/routines")}
        />
        <Row
          icon={IconChecks}
          title="Approval inbox"
          description={
            waiting
              ? `${waiting} waiting for you`
              : "What your Bots asked you to approve"
          }
          accessibilityLabel={
            waiting ? `Approval inbox, ${waiting} waiting` : "Approval inbox"
          }
          trailing={waiting ? <WaitingCount count={waiting} /> : undefined}
          onPress={() => router.push("/approvals")}
        />
      </Rows>
      <Section title="Your Bots">
        <Rows>
          <Row
            icon={IconBrain}
            title="Memory"
            description="What your Bots remember about you"
            onPress={() => router.push("/memory")}
          />
          <Row
            icon={IconBook}
            title="Skills"
            description="What your Bots know how to do"
            onPress={() => router.push("/skills")}
          />
          <Row
            icon={IconPlug}
            title="Connections"
            description="The apps your Bots use as you"
            onPress={() => router.push("/connections")}
          />
        </Rows>
      </Section>
    </ScrollScreen>
  );
}

/** How many wait on the person, in the color of what waits on them, before the row's chevron. */
function WaitingCount({ count }: { count: number }) {
  return (
    <View className="flex-row items-center gap-2">
      <View className="h-5 min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5">
        <Text className="font-semibold text-warning text-xs">
          {count > 99 ? "99+" : count}
        </Text>
      </View>
      <Icon icon={IconChevronRight} size={16} color="accent-muted" />
    </View>
  );
}
