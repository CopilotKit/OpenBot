import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { ApiError, everyPage, ORGANIZATION_ID } from "../src/api";
import {
  deleteBotGrant,
  listBotGrants,
  replaceBotGrant,
} from "../src/api/generated/bot-grants/bot-grants";
import { listSkills } from "../src/api/generated/skills/skills";
import { authClient } from "../src/auth";
import {
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { IconBook, IconPlug } from "../src/icons";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";

/** Apps: what a Bot can use. Its skills are switched on and off here; its connected tools are listed. */
export default function PluginsScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const loadGranted = useCallback(async () => {
    const grants = await everyPage(
      (page) => listBotGrants(ORGANIZATION_ID, botId, page),
      (page) => page.grants,
    );
    return {
      tools: grants.flatMap((grant) =>
        grant.kind === "action" && grant.action
          ? [{ ref: grant.ref, description: grant.action.description }]
          : [],
      ),
      skills: grants.flatMap((grant) =>
        grant.kind === "skill" && grant.skill ? [grant.skill] : [],
      ),
    };
  }, [botId]);
  const granted = useLoad(loadGranted, Boolean(session && botId));
  // Every skill this person can see, page after page.
  const loadCatalogue = useCallback(
    async () => ({
      skills: await everyPage(
        (page) => listSkills(ORGANIZATION_ID, page),
        (page) => page.skills,
      ),
    }),
    [],
  );
  const catalogue = useLoad(loadCatalogue, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  const on = new Set(granted.data?.skills.map((skill) => skill.slug));

  const setSkill = (slug: string, enabled: boolean) =>
    action.run(slug, async () => {
      const grantId = `skill:${slug}`;
      if (enabled) await replaceBotGrant(ORGANIZATION_ID, botId, grantId, {});
      else
        try {
          await deleteBotGrant(ORGANIZATION_ID, botId, grantId);
        } catch (error) {
          // A Bot that doesn't have the skill is already without it.
          if (
            !(error instanceof ApiError && error.code === "BOT_GRANT_NOT_FOUND")
          )
            throw error;
        }
      await granted.refresh();
    });

  const skills = catalogue.data?.skills;
  const tools = granted.data?.tools;
  return (
    <ScrollScreen
      refreshing={granted.pending || catalogue.pending}
      onRefresh={() => {
        void granted.refresh();
        void catalogue.refresh();
      }}
    >
      <Notice
        message={action.error || granted.error || catalogue.error || undefined}
      />
      <Section title="Skills">
        {skills?.length === 0 ? <Text tone="muted">No skills yet.</Text> : null}
        {skills?.length ? (
          <Rows>
            {skills.map((skill) => (
              <Row
                key={skill.slug}
                icon={IconBook}
                title={skill.title}
                description={skill.summary || `/${skill.slug}`}
                trailing={
                  <Toggle
                    label={`Use ${skill.title}`}
                    value={on.has(skill.slug)}
                    disabled={Boolean(action.busy) || !granted.data}
                    onValueChange={(enabled) => {
                      void setSkill(skill.slug, enabled);
                    }}
                  />
                }
              />
            ))}
          </Rows>
        ) : null}
      </Section>
      <Section title="Connected tools">
        <Text tone="muted">
          Connecting an app needs its sign-in, so add and remove tools in
          OpenBot on your computer.
        </Text>
        {tools?.length === 0 ? (
          <Text tone="muted">No connected tools.</Text>
        ) : null}
        {tools?.length ? (
          <Rows>
            {tools.map((tool) => (
              <Row
                key={tool.ref}
                icon={IconPlug}
                title={tool.ref}
                description={tool.description || undefined}
              />
            ))}
          </Rows>
        ) : null}
      </Section>
    </ScrollScreen>
  );
}
