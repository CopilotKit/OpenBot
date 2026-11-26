import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { FieldError } from "heroui-native/field-error";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextArea } from "heroui-native/text-area";
import { TextField } from "heroui-native/text-field";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { ApiError, everyBot, everyPage, ORGANIZATION_ID } from "../src/api";
import {
  deleteBotGrant,
  replaceBotGrant,
} from "../src/api/generated/bot-grants/bot-grants";
import {
  getBot,
  getBotHandoff,
  listBots,
  updateBot,
} from "../src/api/generated/bots/bots";
import { getModelCatalogue } from "../src/api/generated/models/models";
import { authClient } from "../src/auth";
import { useBotContext } from "../src/bot-context";
import {
  botUpdate,
  chosenModel,
  defaultModelSummary,
  handoffGrantId,
  handoffRoster,
  isolationRow,
  maySetUp,
  modelGroups,
  type SetupDraft,
  type SetupErrors,
  setupDraftOf,
  setupRequest,
} from "../src/bot-settings";
import {
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { IconCpu, IconDeviceDesktop, IconInfoCircle } from "../src/icons";
import { MenuRow } from "../src/menu-row";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";

const DEFAULT_MODEL = "default";

/** The text fields, in the order Setup lists them. */
const FIELDS: {
  field: keyof SetupDraft;
  label: string;
  multiline?: boolean;
  address?: boolean;
}[] = [
  { field: "name", label: "Name" },
  { field: "title", label: "Title" },
  { field: "roleDescription", label: "What it does", multiline: true },
  { field: "instructions", label: "Instructions", multiline: true },
  { field: "endpoint", label: "Agent URL", address: true },
];

/**
 * A Bot's Setup, as the web app's: its name, title, what it does (and the starter Bot's instructions),
 * the address of a Bot connected from outside OpenBot, whether it has a computer of its own, its
 * default model, and which other Bots it may hand work to. Whoever may manage it edits it; everyone
 * else reads it.
 */
export default function BotSetupScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session && botId);
  const context = useBotContext(signedIn);
  const action = useAction();
  const loadBot = useCallback(() => getBot(ORGANIZATION_ID, botId), [botId]);
  const bot = useLoad(loadBot, signedIn);
  const value = bot.data?.bot;
  const loadCatalogue = useCallback(
    () => getModelCatalogue(ORGANIZATION_ID),
    [],
  );
  const offersModel = Boolean(
    value?.runsOnOpenBotModel && value.defaultModel !== undefined,
  );
  const catalogue = useLoad(loadCatalogue, signedIn && offersModel);
  const loadHandoff = useCallback(async () => {
    const [handoff, roster, hidden] = await Promise.all([
      getBotHandoff(ORGANIZATION_ID, botId),
      everyBot(),
      everyPage(
        (page) => listBots(ORGANIZATION_ID, { ...page, hidden: true }),
        (page) => page.bots,
      ),
    ]);
    return { handoff, roster, hidden };
  }, [botId]);
  // Every Bot can ask every other in the personal edition, so there is nothing to switch there.
  const handoff = useLoad(loadHandoff, signedIn && !context.personal);
  const pull = usePull(bot.refresh, catalogue.refresh, handoff.refresh);
  const [draft, setDraft] = useState<SetupDraft>();
  const [errors, setErrors] = useState<SetupErrors>({});
  useEffect(() => {
    if (value && !draft) setDraft(setupDraftOf(value));
  }, [value, draft]);
  if (!session && !isPending) return <Redirect href="/" />;
  if (!value || !draft)
    return (
      <ScrollScreen>
        <Notice message={bot.error} />
      </ScrollScreen>
    );

  const editable = maySetUp(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(setupDraftOf(value));
  const isolation = isolationRow(value, context.offers);
  const fields = FIELDS.filter(({ field }) => draft[field] !== undefined);

  const save = () => {
    const { errors: found, request } = setupRequest(value, draft);
    setErrors(found);
    if (!request) return;
    void action.run("save", async () => {
      const saved = await updateBot(ORGANIZATION_ID, botId, request);
      setDraft(setupDraftOf(saved.bot));
      await bot.refresh();
    });
  };
  const setIsolated = (isolated: boolean) =>
    void action.run("isolated", async () => {
      await updateBot(ORGANIZATION_ID, botId, botUpdate(value, { isolated }));
      await bot.refresh();
    });

  const groups = modelGroups(catalogue.data);
  const chosen = chosenModel(value.defaultModel, catalogue.data);
  const pickModel = (id: string) => {
    if (id === DEFAULT_MODEL) {
      if (!value.defaultModel) return;
      void action.run("model", async () => {
        await updateBot(
          ORGANIZATION_ID,
          botId,
          botUpdate(value, { defaultModel: null }),
        );
        await bot.refresh();
      });
      return;
    }
    const picked = groups
      .flatMap((group) => group.choices)
      .find((choice) => choice.key === id);
    if (!picked || picked.key === chosen?.key) return;
    void action.run("model", async () => {
      await updateBot(
        ORGANIZATION_ID,
        botId,
        botUpdate(value, { defaultModel: picked.saved }),
      );
      await bot.refresh();
    });
  };

  const handoffData = handoff.data;
  const roster = handoffData
    ? handoffRoster({
        botId,
        roster: handoffData.roster,
        hidden: handoffData.hidden,
        handoff: handoffData.handoff,
      })
    : undefined;
  const setGrant = (otherBotId: string, granted: boolean) =>
    void action.run(`grant:${otherBotId}`, async () => {
      const grantId = handoffGrantId(otherBotId);
      if (granted) await replaceBotGrant(ORGANIZATION_ID, botId, grantId);
      else {
        try {
          await deleteBotGrant(ORGANIZATION_ID, botId, grantId);
        } catch (failure) {
          // A Bot that doesn't have it is already without it.
          if (
            !(
              failure instanceof ApiError &&
              failure.code === "BOT_GRANT_NOT_FOUND"
            )
          )
            throw failure;
        }
      }
      await handoff.refresh();
    });
  const showHandoff =
    handoffData &&
    (handoffData.handoff.canGrant || handoffData.handoff.reachable.length > 0);

  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Text tone="muted" className="px-1 text-sm">
        {editable
          ? "Edit this Bot's name, instructions and model."
          : "Only its owner or an admin can change these."}
      </Text>
      <Notice message={action.error || bot.error} />
      <Section title="Identity">
        {editable ? (
          <View className="gap-4">
            {fields.map(({ field, label, multiline, address }) => {
              const props = {
                accessibilityLabel: label,
                value: draft[field] ?? "",
                onChangeText: (text: string) =>
                  setDraft((now) => (now ? { ...now, [field]: text } : now)),
              };
              return (
                <TextField key={field} isInvalid={Boolean(errors[field])}>
                  <Label>{label}</Label>
                  {multiline ? (
                    <TextArea {...props} />
                  ) : (
                    <Input
                      {...props}
                      {...(address
                        ? {
                            autoCapitalize: "none" as const,
                            autoCorrect: false,
                            keyboardType: "url" as const,
                          }
                        : {})}
                    />
                  )}
                  <FieldError>{errors[field]}</FieldError>
                </TextField>
              );
            })}
            <Button
              size="sm"
              className="self-end"
              isDisabled={!dirty || Boolean(action.busy)}
              onPress={save}
            >
              {action.busy === "save" ? "Saving…" : "Save"}
            </Button>
          </View>
        ) : (
          <Rows iconless>
            {fields.map(({ field, label }) => (
              <Row
                key={field}
                title={label}
                description={draft[field] || undefined}
              />
            ))}
          </Rows>
        )}
      </Section>
      {value.systemOwned ? (
        <Rows>
          <Row
            icon={IconInfoCircle}
            title="System owned"
            description="Comes with OpenBot. It doesn't belong to a person."
          />
        </Rows>
      ) : null}
      {context.personal ? null : (
        <Section title="Computer">
          <Rows>
            <Row
              icon={IconDeviceDesktop}
              title="Isolated"
              description={isolation.summary}
              trailing={
                isolation.showSwitch ? (
                  <Toggle
                    label="Isolated"
                    value={value.isolated}
                    disabled={!isolation.editable || Boolean(action.busy)}
                    onValueChange={setIsolated}
                  />
                ) : (
                  <Text tone="muted" className="text-sm">
                    {value.isolated ? "On" : "Off"}
                  </Text>
                )
              }
            />
          </Rows>
        </Section>
      )}
      {offersModel ? (
        <Section title="Model">
          <Rows>
            <MenuRow
              icon={IconCpu}
              title="Default model"
              description={defaultModelSummary(
                value.defaultModel,
                catalogue.data,
              )}
              menuTitle="New conversations with this Bot start on this model."
              disabled={!editable || Boolean(action.busy)}
              groups={[
                {
                  choices: [
                    {
                      id: DEFAULT_MODEL,
                      title: "Use OpenBot's default",
                      on: !value.defaultModel,
                    },
                  ],
                },
                ...groups.map((group) => ({
                  title: group.title,
                  choices: group.choices.map((choice) => ({
                    id: choice.key,
                    title: choice.label,
                    on: choice.key === chosen?.key,
                  })),
                })),
              ]}
              onPick={pickModel}
            />
          </Rows>
          <Notice message={catalogue.error} />
        </Section>
      ) : null}
      {showHandoff && roster ? (
        <Section
          title="Bots it can ask"
          action={
            handoffData.handoff.grantable && roster.total > 0 ? (
              <Text variant="caption" tone="muted">
                {roster.granted} of {roster.total}
              </Text>
            ) : undefined
          }
        >
          <Text tone="muted" className="px-1 text-sm">
            Choose which Bots this Bot can ask for help. Their answers appear in
            the same conversation under their own names.
          </Text>
          {handoffData.handoff.enabled ? null : (
            <Text tone="muted" className="px-1 text-sm">
              An admin turned off handing work between Bots. These settings are
              kept, and they apply again once it's back on.
            </Text>
          )}
          {handoffData.handoff.grantable ? null : (
            <Text tone="muted" className="px-1 text-sm">
              This Bot can't hand work to other Bots. Other Bots can still hand
              work to it.
            </Text>
          )}
          {handoffData.handoff.grantable && roster.total === 0 ? (
            <Text tone="muted" className="px-1 text-sm">
              No other Bots yet. When there are more, you can let this Bot ask
              them here.
            </Text>
          ) : null}
          {roster.candidates.length > 0 ? (
            <Rows iconless>
              {roster.candidates.map((candidate) => (
                <Row
                  key={candidate.id}
                  title={candidate.name}
                  description={
                    candidate.hidden
                      ? [candidate.title, "Hidden from your Bots list"]
                          .filter(Boolean)
                          .join(" · ")
                      : candidate.title || undefined
                  }
                  trailing={
                    <Toggle
                      label={`Let this Bot ask ${candidate.name}`}
                      value={handoffData.handoff.reachable.includes(
                        candidate.id,
                      )}
                      disabled={
                        !handoffData.handoff.canGrant || Boolean(action.busy)
                      }
                      onValueChange={(granted) =>
                        setGrant(candidate.id, granted)
                      }
                    />
                  }
                />
              ))}
            </Rows>
          ) : null}
          {handoffData.handoff.canGrant ? null : (
            <Text tone="muted" className="px-1 text-sm">
              An admin decides which Bots this one can ask.
            </Text>
          )}
        </Section>
      ) : null}
      <Notice message={handoff.error} />
    </ScrollScreen>
  );
}
