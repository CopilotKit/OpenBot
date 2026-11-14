import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Switch, Text, View } from "react-native";
import {
  ApiError,
  api,
  type BotGrant,
  type BotGrantPage,
  type SkillSummary,
} from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  heading,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

/** The organization every request is in: an install has one, addressed as `default`. */
const ORGANIZATION = "/api/v2/organizations/default";

/** What a Bot can use: skills switched on and off here, connected tools listed. */
export default function PluginsScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const grantsPath = `${ORGANIZATION}/bots/${encodeURIComponent(botId)}/grants`;
  const loadGranted = useCallback(async () => {
    // Every page of what the Bot holds.
    const grants: BotGrant[] = [];
    let cursor: string | null = null;
    do {
      const page: BotGrantPage = await api<BotGrantPage>(
        `${grantsPath}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      grants.push(...page.grants);
      cursor = page.nextCursor;
    } while (cursor);
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
  }, [grantsPath]);
  const granted = useLoad(loadGranted, Boolean(session && botId));
  const loadCatalogue = useCallback(
    () => api<{ skills: SkillSummary[] }>("/api/plugins"),
    [],
  );
  const catalogue = useLoad(loadCatalogue, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  const on = new Set(granted.data?.skills.map((skill) => skill.slug));

  const setSkill = (slug: string, enabled: boolean) =>
    action.run(slug, async () => {
      const grant = `${grantsPath}/${encodeURIComponent(`skill:${slug}`)}`;
      if (enabled) await api(grant, { method: "PUT", body: {} });
      else
        try {
          await api(grant, { method: "DELETE" });
        } catch (error) {
          // A Bot that doesn't have the skill is already without it.
          if (
            !(error instanceof ApiError && error.code === "BOT_GRANT_NOT_FOUND")
          )
            throw error;
        }
      await granted.refresh();
    });

  return (
    <Screen
      refreshing={granted.pending || catalogue.pending}
      onRefresh={() => {
        void granted.refresh();
        void catalogue.refresh();
      }}
    >
      <Text style={heading}>Plugins</Text>
      <Problem message={action.error || granted.error || catalogue.error} />
      <Section title="Skills">
        {catalogue.data?.skills.length === 0 && (
          <Text style={muted}>No skills yet.</Text>
        )}
        {catalogue.data?.skills.map((skill) => (
          <View
            key={skill.slug}
            style={[
              card,
              { flexDirection: "row", alignItems: "center", gap: 12 },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ fontWeight: "600" }}>
                {skill.title} (/{skill.slug})
              </Text>
              <Text style={muted}>{skill.summary}</Text>
            </View>
            <Switch
              accessibilityLabel={`Use ${skill.title}`}
              value={on.has(skill.slug)}
              disabled={Boolean(action.busy) || !granted.data}
              onValueChange={(enabled) => {
                void setSkill(skill.slug, enabled);
              }}
            />
          </View>
        ))}
      </Section>
      <Section title="Connected tools">
        <Text style={muted}>
          Connecting an app needs its sign-in, so add and remove tools in
          OpenBot on your computer.
        </Text>
        {granted.data?.tools.length === 0 && (
          <Text style={muted}>No connected tools.</Text>
        )}
        {granted.data?.tools.map((tool) => (
          <View key={tool.ref} style={card}>
            <Text style={{ fontWeight: "600" }}>{tool.ref}</Text>
            {tool.description ? (
              <Text numberOfLines={3} style={muted}>
                {tool.description}
              </Text>
            ) : null}
          </View>
        ))}
      </Section>
    </Screen>
  );
}
