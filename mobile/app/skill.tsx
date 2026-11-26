import {
  Redirect,
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import { useCallback } from "react";
import { Alert, View } from "react-native";
import { ApiError, ORGANIZATION_ID } from "../src/api";
import { deleteSkill, getSkill } from "../src/api/generated/skills/skills";
import { authClient } from "../src/auth";
import {
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../src/components";
import { headerActions } from "../src/header";
import { IconPencil } from "../src/icons";
import { mayChange } from "../src/skill-form";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { whoChangesSkills } from "../src/your-skills";

/**
 * One skill, to read: its name, its command, what it is for and the instructions a Bot follows. Your own skill is
 * changed with Edit in the header and deleted with the last row; the organization's is an admin's to change.
 */
export default function SkillScreen() {
  const { slug = "" } = useLocalSearchParams<{ slug: string }>();
  const { data: session, isPending } = authClient.useSession();
  const sessionId = session?.user.id;
  const action = useAction();
  const load = useCallback(async () => {
    const [skill, who] = await Promise.all([
      getSkill(ORGANIZATION_ID, slug).catch((error) => {
        // Deleted, or never one this person could see.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }),
      whoChangesSkills(sessionId),
    ]);
    return { skill, who };
  }, [slug, sessionId]);
  const read = useLoad(load, Boolean(session && slug));
  // Back from Edit skill: the page shows what was saved.
  const { refresh } = read;
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  if (!session && !isPending) return <Redirect href="/" />;
  const skill = read.data?.skill;
  const changes = skill && read.data ? mayChange(skill, read.data.who) : false;

  async function remove() {
    const removed = await action.run("delete", () =>
      deleteSkill(ORGANIZATION_ID, slug),
    );
    if (removed) router.back();
  }

  return (
    <ScrollScreen refreshing={read.pending} onRefresh={() => void refresh()}>
      <Stack.Screen
        options={{
          // The page names it at the top, as a routine's page does.
          title: "",
          ...headerActions(
            changes
              ? [
                  {
                    label: "Edit skill",
                    sf: "pencil",
                    icon: IconPencil,
                    onPress: () =>
                      router.push({
                        pathname: "/skill-form",
                        params: { slug },
                      }),
                  },
                ]
              : [],
          ),
        }}
      />
      <Notice message={action.error || read.error} />
      {read.data && !skill ? (
        <Text tone="muted">This skill no longer exists.</Text>
      ) : null}
      {skill ? (
        <>
          <View className="gap-1 px-1">
            <Text variant="title">{skill.title}</Text>
            <Text tone="muted" className="text-sm">{`/${skill.slug}`}</Text>
            {skill.summary ? (
              <Text className="pt-2">{skill.summary}</Text>
            ) : null}
          </View>
          {changes ? null : (
            <Notice
              tone="info"
              message="This is your organization's skill. Only an admin can change it."
            />
          )}
          <Section title="Instructions">
            <Rows iconless>
              <View className="px-3 py-3">
                <Text>{skill.instructions}</Text>
              </View>
            </Rows>
          </Section>
          {skill.tools.length ? (
            <Section title="Actions it needs">
              <Rows iconless>
                {skill.tools.map((tool) => (
                  <Row key={tool} title={tool} />
                ))}
              </Rows>
            </Section>
          ) : null}
          {changes ? (
            <Rows iconless>
              <Row
                title="Delete skill"
                tone="danger"
                chevron={false}
                onPress={
                  action.busy
                    ? undefined
                    : () =>
                        Alert.alert(
                          "Delete this skill?",
                          "Bots that offer it stop offering it.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Delete",
                              style: "destructive",
                              onPress: () => {
                                void remove();
                              },
                            },
                          ],
                        )
                }
              />
            </Rows>
          ) : null}
        </>
      ) : null}
    </ScrollScreen>
  );
}
