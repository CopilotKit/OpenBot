import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextField } from "heroui-native/text-field";
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import {
  type ApprovalRule,
  BEHAVIOUR_LABELS,
  loadApprovalSettings,
  ME,
  ORGANIZATION_ID,
  type RuleBehaviour,
} from "../src/api";
import {
  createPersonApprovalRule,
  deletePersonApprovalRule,
  updateApprovalPreferences,
  updatePersonApprovalRule,
} from "../src/api/generated/approvals/approvals";
import { authClient } from "../src/auth";
import {
  Card,
  ChoiceList,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";

const BEHAVIOURS = (Object.keys(BEHAVIOUR_LABELS) as RuleBehaviour[]).map(
  (value) => ({ value, label: BEHAVIOUR_LABELS[value] }),
);

const describe = (rule: ApprovalRule) =>
  [
    rule.toolRef === "*" ? "Any tool" : rule.toolRef,
    rule.effect === "*" ? null : rule.effect,
    rule.scope === "*" ? null : rule.scope,
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * Custom rules: what a Bot may do without asking, and the ask-first switches. The header says
 * "Custom rules"; the page opens on the switches, then the team's rules, yours, and adding one.
 */
export default function RulesScreen() {
  const { botId = "*" } = useLocalSearchParams<{ botId?: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const [toolRef, setToolRef] = useState("");
  const [behaviour, setBehaviour] = useState<RuleBehaviour>("ask");
  const load = useCallback(() => loadApprovalSettings(), []);
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

  const setPreference = (change: { enabled?: boolean; autoReview?: boolean }) =>
    action.run("preferences", async () => {
      await updateApprovalPreferences(ORGANIZATION_ID, ME, change);
      await settings.refresh();
    });
  /** A rule's behaviour is edited in place, so it keeps its id and its audit history. */
  const changeRule = (rule: ApprovalRule, next: RuleBehaviour) =>
    action.run(rule.id, async () => {
      await updatePersonApprovalRule(ORGANIZATION_ID, ME, rule.id, {
        behaviour: next,
      });
      await settings.refresh();
    });

  return (
    <ScrollScreen
      refreshing={settings.pending}
      onRefresh={() => void settings.refresh()}
    >
      <Notice message={action.error || settings.error || undefined} />
      {data?.preferences ? (
        <Rows iconless>
          <Row
            title="Ask before acting on my behalf"
            trailing={
              <Toggle
                label="Ask before acting on my behalf"
                value={data.preferences.enabled}
                disabled={Boolean(action.busy)}
                onValueChange={(enabled) => {
                  void setPreference({ enabled });
                }}
              />
            }
          />
          <Row
            title="Auto-review low-risk actions"
            description={
              data.team?.enforceAutoReview ? "Required by your team" : undefined
            }
            trailing={
              <Toggle
                label="Auto-review low-risk actions"
                value={data.preferences.autoReview}
                disabled={
                  Boolean(action.busy) || Boolean(data.team?.enforceAutoReview)
                }
                onValueChange={(autoReview) => {
                  void setPreference({ autoReview });
                }}
              />
            }
          />
        </Rows>
      ) : null}
      {teamRules && teamRules.length > 0 ? (
        <Section title="Team rules">
          <Rows iconless>
            {teamRules.map((rule) => (
              <Row
                key={rule.id}
                title={describe(rule)}
                description={`${BEHAVIOUR_LABELS[rule.behaviour]} · Set by your team`}
              />
            ))}
          </Rows>
        </Section>
      ) : null}
      <Section title="Your rules">
        {!editable ? (
          <Text tone="muted">
            Your workspace has switched custom rules off.
          </Text>
        ) : null}
        {rules?.length === 0 ? <Text tone="muted">No rules yet.</Text> : null}
        {rules?.map((rule) => (
          <Card key={rule.id} className="gap-3">
            <Text variant="label" className="font-semibold">
              {describe(rule)}
            </Text>
            {rule.botId === "*" ? (
              <Text variant="caption" tone="muted" className="-mt-2">
                Every Bot
              </Text>
            ) : null}
            <ChoiceList
              label={`What a Bot does with ${describe(rule)}`}
              options={BEHAVIOURS}
              value={rule.behaviour}
              disabled={!editable || Boolean(action.busy)}
              onChange={(next) => {
                void changeRule(rule, next);
              }}
            />
            <Button
              size="sm"
              variant="danger-soft"
              className="self-start"
              isDisabled={Boolean(action.busy)}
              onPress={() =>
                Alert.alert("Remove this rule?", describe(rule), [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => {
                      void action.run(rule.id, async () => {
                        await deletePersonApprovalRule(
                          ORGANIZATION_ID,
                          ME,
                          rule.id,
                        );
                        await settings.refresh();
                      });
                    },
                  },
                ])
              }
            >
              Remove rule
            </Button>
          </Card>
        ))}
      </Section>
      {editable ? (
        <Section title="Add a rule">
          <Card className="gap-3">
            <TextField>
              <Label>Tool or app</Label>
              <Input
                placeholder="gmail/send_email, or * for any"
                autoCapitalize="none"
                autoCorrect={false}
                value={toolRef}
                onChangeText={setToolRef}
                maxLength={300}
              />
            </TextField>
            <ChoiceList
              label="What a Bot does with it"
              options={BEHAVIOURS}
              value={behaviour}
              onChange={setBehaviour}
            />
            <Button
              isDisabled={Boolean(action.busy) || !toolRef.trim()}
              onPress={() => {
                void action.run("add", async () => {
                  await createPersonApprovalRule(ORGANIZATION_ID, ME, {
                    botId,
                    toolRef: toolRef.trim(),
                    behaviour,
                  });
                  setToolRef("");
                  await settings.refresh();
                });
              }}
            >
              {action.busy === "add" ? "Adding…" : "Add rule"}
            </Button>
          </Card>
        </Section>
      ) : null}
    </ScrollScreen>
  );
}
