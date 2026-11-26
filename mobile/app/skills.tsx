import { Redirect, router, Stack, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { everyPage, ORGANIZATION_ID } from "../src/api";
import { listSkills } from "../src/api/generated/skills/skills";
import { authClient } from "../src/auth";
import {
  EmptyState,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
} from "../src/components";
import { headerActions } from "../src/header";
import { IconBook, IconPlus } from "../src/icons";
import { mayChange } from "../src/skill-form";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";
import { whoChangesSkills } from "../src/your-skills";

/**
 * Skills: what your Bots know how to do. Your own skills first, which you read, write, change and delete here, then
 * the organization's, which you read here and an admin changes. New skill writes one.
 */
export default function Skills() {
  const { data: session, isPending } = authClient.useSession();
  const sessionId = session?.user.id;
  const load = useCallback(async () => {
    const [skills, who] = await Promise.all([
      everyPage(
        (page) => listSkills(ORGANIZATION_ID, page),
        (page) => page.skills,
      ),
      whoChangesSkills(sessionId),
    ]);
    return { skills, who };
  }, [sessionId]);
  const skills = useLoad(load, Boolean(session));
  // Back from writing or deleting a skill: the list shows it.
  const { refresh } = skills;
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const pull = usePull(refresh);
  if (!session && !isPending) return <Redirect href="/" />;
  const all = skills.data?.skills ?? [];
  const who = skills.data?.who ?? {
    personId: undefined,
    edition: undefined,
  };
  const yours = all.filter((skill) => mayChange(skill, who));
  // The organization's: another person's own skill, which an admin can see, isn't listed, as on the web app.
  const organization = all.filter(
    (skill) => skill.ownerId === null && !mayChange(skill, who),
  );
  const open = (slug: string) =>
    router.push({ pathname: "/skill", params: { slug } });
  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Stack.Screen
        options={headerActions([
          {
            label: "New skill",
            sf: "plus",
            icon: IconPlus,
            onPress: () => router.push("/skill-form"),
          },
        ])}
      />
      <Notice message={skills.error} />
      {yours.length ? (
        <Section title="Your skills">
          <Rows>
            {yours.map((skill) => (
              <Row
                key={skill.slug}
                icon={IconBook}
                title={skill.title}
                description={skill.summary || `/${skill.slug}`}
                onPress={() => open(skill.slug)}
              />
            ))}
          </Rows>
        </Section>
      ) : null}
      {organization.length ? (
        <Section title="Organization skills">
          <Rows>
            {organization.map((skill) => (
              <Row
                key={skill.slug}
                icon={IconBook}
                title={skill.title}
                description={skill.summary || `/${skill.slug}`}
                onPress={() => open(skill.slug)}
              />
            ))}
          </Rows>
        </Section>
      ) : null}
      {skills.data && !yours.length && !organization.length ? (
        <EmptyState
          icon={IconBook}
          title="No skills yet"
          description="Write one with New skill, and your Bots can use it."
        />
      ) : null}
    </ScrollScreen>
  );
}
