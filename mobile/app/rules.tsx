import { Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  Button,
  Pressable,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  type ApprovalRule,
  type ApprovalSettings,
  api,
  BEHAVIOUR_LABELS,
  type RuleBehaviour,
} from "../src/api";
import { authClient } from "../src/auth";
import {
  card,
  colors,
  heading,
  input,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

const BEHAVIOURS = Object.keys(BEHAVIOUR_LABELS) as RuleBehaviour[];

function BehaviourPicker({
  value,
  disabled,
  onChange,
}: {
  value: RuleBehaviour;
  disabled?: boolean;
  onChange: (value: RuleBehaviour) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" style={{ gap: 6 }}>
      {BEHAVIOURS.map((behaviour) => (
        <Pressable
          key={behaviour}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === behaviour, disabled }}
          disabled={disabled}
          onPress={() => onChange(behaviour)}
          style={{
            borderWidth: value === behaviour ? 2 : 1,
            borderColor: value === behaviour ? colors.link : colors.border,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <Text>{BEHAVIOUR_LABELS[behaviour]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const describe = (rule: ApprovalRule) =>
  [
    rule.toolRef === "*" ? "Any tool" : rule.toolRef,
    rule.effect === "*" ? null : rule.effect,
    rule.scope === "*" ? null : rule.scope,
  ]
    .filter(Boolean)
    .join(" · ");

/** Custom rules: what a Bot may do without asking, and the ask-first switches. */
export default function RulesScreen() {
  const { botId = "*" } = useLocalSearchParams<{ botId?: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [toolRef, setToolRef] = useState("");
  const [behaviour, setBehaviour] = useState<RuleBehaviour>("ask");
  const load = useCallback(() => api<ApprovalSettings>("/api/approvals"), []);
  const settings = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  const data = settings.data;
  const rules = data?.rules.filter(
    (rule) => rule.botId === botId || rule.botId === "*",
  );
  const teamRules = data?.teamRules.filter(
    (rule) => rule.botId === botId || rule.botId === "*",
  );
  const editable = data?.team?.customRulesEnabled !== false;

  const setPreference = (body: Record<string, boolean>) =>
    action.run("preferences", async () => {
      await api("/api/approvals/preferences", { method: "PATCH", body });
      await settings.refresh();
    });
  /** A rule's behaviour is edited in place, so it keeps its id and its audit history. */
  const changeRule = (rule: ApprovalRule, next: RuleBehaviour) =>
    action.run(rule.id, async () => {
      await api(`/api/approvals/rules/${encodeURIComponent(rule.id)}`, {
        method: "PATCH",
        body: { behaviour: next },
      });
      await settings.refresh();
    });

  return (
    <Screen
      refreshing={settings.pending}
      onRefresh={() => void settings.refresh()}
    >
      <Text style={heading}>Custom rules</Text>
      <Problem message={action.error || settings.error} />
      {data?.preferences && (
        <View style={card}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text style={{ flex: 1 }}>Ask before acting on my behalf</Text>
            <Switch
              accessibilityLabel="Ask before acting on my behalf"
              value={data.preferences.enabled}
              disabled={Boolean(action.busy)}
              onValueChange={(enabled) => {
                void setPreference({ enabled });
              }}
            />
          </View>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text style={{ flex: 1 }}>
              Auto-review low-risk actions
              {data.team?.enforceAutoReview ? " (required by your team)" : ""}
            </Text>
            <Switch
              accessibilityLabel="Auto-review low-risk actions"
              value={data.preferences.autoReview}
              disabled={
                Boolean(action.busy) || Boolean(data.team?.enforceAutoReview)
              }
              onValueChange={(autoReview) => {
                void setPreference({ autoReview });
              }}
            />
          </View>
        </View>
      )}
      {teamRules && teamRules.length > 0 && (
        <Section title="Team rules">
          {teamRules.map((rule) => (
            <View key={rule.id} style={card}>
              <Text style={{ fontWeight: "600" }}>{describe(rule)}</Text>
              <Text style={muted}>
                {BEHAVIOUR_LABELS[rule.behaviour]} · set by your team
              </Text>
            </View>
          ))}
        </Section>
      )}
      <Section title="Your rules">
        {!editable && (
          <Text style={muted}>
            Your workspace has switched custom rules off.
          </Text>
        )}
        {rules?.length === 0 && <Text style={muted}>No rules yet.</Text>}
        {rules?.map((rule) => (
          <View key={rule.id} style={card}>
            <Text style={{ fontWeight: "600" }}>{describe(rule)}</Text>
            {rule.botId === "*" && <Text style={muted}>Every Bot</Text>}
            <BehaviourPicker
              value={rule.behaviour}
              disabled={!editable || Boolean(action.busy)}
              onChange={(next) => {
                if (next !== rule.behaviour) void changeRule(rule, next);
              }}
            />
            <Button
              title="Remove rule"
              color={colors.error}
              disabled={Boolean(action.busy)}
              onPress={() =>
                Alert.alert("Remove this rule?", describe(rule), [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => {
                      void action.run(rule.id, async () => {
                        await api(
                          `/api/approvals/rules/${encodeURIComponent(rule.id)}`,
                          { method: "DELETE" },
                        );
                        await settings.refresh();
                      });
                    },
                  },
                ])
              }
            />
          </View>
        ))}
      </Section>
      {editable && (
        <Section title="Add a rule">
          <View style={card}>
            <TextInput
              accessibilityLabel="Tool or app"
              placeholder="Tool or app, such as gmail/send_email or *"
              autoCapitalize="none"
              autoCorrect={false}
              value={toolRef}
              onChangeText={setToolRef}
              maxLength={300}
              style={input}
            />
            <BehaviourPicker value={behaviour} onChange={setBehaviour} />
            <Button
              title="Add rule"
              disabled={Boolean(action.busy) || !toolRef.trim()}
              onPress={() => {
                void action.run("add", async () => {
                  await api("/api/approvals/rules", {
                    method: "POST",
                    body: { botId, toolRef: toolRef.trim(), behaviour },
                  });
                  setToolRef("");
                  await settings.refresh();
                });
              }}
            />
          </View>
        </Section>
      )}
    </Screen>
  );
}
