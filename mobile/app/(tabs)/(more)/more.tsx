import { router } from "expo-router";
import { useCallback } from "react";
import { organizationChoices } from "../../../src/api";
import { authClient } from "../../../src/auth";
import { Row, Rows, ScrollScreen, Section } from "../../../src/components";
import {
  IconBook,
  IconBrain,
  IconChecks,
  IconPlug,
  IconSettings,
} from "../../../src/icons";
import { useLoad } from "../../../src/use-load";

/**
 * More: the parts of the app that don't have a tab. What every Bot remembers, knows and connects
 * to, the approval inbox, and the person's account.
 */
export default function More() {
  const { data: session } = authClient.useSession();
  const loadOrganizations = useCallback(() => organizationChoices(), []);
  const organizations = useLoad(loadOrganizations, Boolean(session));
  const workingIn = organizations.data?.organizations.find(
    (organization) => organization.id === organizations.data?.currentId,
  );
  const person = session?.user.name || session?.user.email || "";
  return (
    <ScrollScreen>
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
      <Rows>
        <Row
          icon={IconChecks}
          title="Approval inbox"
          description="What your Bots asked you to approve"
          onPress={() => router.push("/approvals")}
        />
      </Rows>
      <Rows>
        <Row
          icon={IconSettings}
          title="Your account"
          description={
            [person, workingIn?.name].filter(Boolean).join(" · ") || undefined
          }
          onPress={() => router.push("/account")}
        />
      </Rows>
    </ScrollScreen>
  );
}
