import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback } from "react";
import { Share } from "react-native";
import { ORGANIZATION_ID } from "../src/api";
import { getBot, updateBot } from "../src/api/generated/bots/bots";
import { getAppsSetting } from "../src/api/generated/organization-settings/organization-settings";
import {
  createSharedUseRequest,
  getBotSharedUse,
} from "../src/api/generated/shared-use/shared-use";
import {
  assignTeamBot,
  unassignTeamBot,
  unpublishTeamBot,
} from "../src/api/generated/team-bots/team-bots";
import { authClient, serverUrl } from "../src/auth";
import { everyTeam, loadPublished, useBotContext } from "../src/bot-context";
import {
  assignChoices,
  assignmentName,
  audienceSummary,
  botUpdate,
  mayChangeVisibility,
  mayPublish,
  publishedTo,
  visibilityChoices,
  visibilitySentence,
} from "../src/bot-settings";
import {
  ChoiceList,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../src/components";
import { IconLink, IconPlus, IconUsersGroup } from "../src/icons";
import { MenuRow } from "../src/menu-row";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";

/** Where somebody it is published to starts a private conversation with it. */
const botLink = (botId: string) =>
  `${serverUrl}/channel/new?agent=${encodeURIComponent(botId)}`;

/**
 * Who can use a Bot, as the web app's Sharing page: who it is published to (everyone in the
 * organization, or named people and teams), its link, and, for an admin, whose Bots list it is pinned
 * to. Each person's conversations with it are private. Then its visibility, and, where the
 * organization's apps are locked down, what that means for the shared app accounts it uses.
 */
export default function BotSharingScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session && botId);
  const context = useBotContext(signedIn);
  const action = useAction();
  const loadBot = useCallback(() => getBot(ORGANIZATION_ID, botId), [botId]);
  const bot = useLoad(loadBot, signedIn);
  const value = bot.data?.bot;
  const loadPublication = useCallback(() => loadPublished(botId), [botId]);
  const published = useLoad(loadPublication, signedIn);
  const loadTeams = useCallback(() => everyTeam(), []);
  const teams = useLoad(loadTeams, signedIn);
  // Only the Bot's owner or an admin may read its shared accounts: whoever may manage it.
  const loadShared = useCallback(async () => {
    const setting = await getAppsSetting(ORGANIZATION_ID);
    if (!setting.lockedDown) return null;
    return getBotSharedUse(ORGANIZATION_ID, botId);
  }, [botId]);
  const shared = useLoad(
    loadShared,
    signedIn && Boolean(value?.canManage) && !context.personal,
  );
  const pull = usePull(
    bot.refresh,
    published.refresh,
    teams.refresh,
    shared.refresh,
  );
  if (!session && !isPending) return <Redirect href="/" />;
  if (!value || published.data === undefined)
    return (
      <ScrollScreen>
        <Notice message={bot.error || published.error} />
      </ScrollScreen>
    );

  const teamBot = published.data ?? undefined;
  const teamList = teams.data;
  const choices = visibilityChoices(context.organizationName);
  // "Everyone in Acme", as the visibility choice says it.
  const everyone = choices[1]?.label ?? "";
  const setVisibility = (visibility: "private" | "public") => {
    if (visibility === value.visibility) return;
    void action.run("visibility", async () => {
      await updateBot(ORGANIZATION_ID, botId, botUpdate(value, { visibility }));
      await Promise.all([bot.refresh(), shared.refresh()]);
    });
  };
  const unpublish = () =>
    void action.run("unpublish", async () => {
      await unpublishTeamBot(ORGANIZATION_ID, botId);
      await published.refresh();
    });
  const assign = (group: string, remove = false) =>
    void action.run(`assign:${group}`, async () => {
      await (remove ? unassignTeamBot : assignTeamBot)(
        ORGANIZATION_ID,
        botId,
        group,
      );
      await Promise.all([published.refresh(), shared.refresh()]);
    });
  const ask = (serverId: string) =>
    void action.run(`ask:${serverId}`, async () => {
      await createSharedUseRequest(ORGANIZATION_ID, {
        botId,
        serverId,
        reason: "publish",
      });
      await shared.refresh();
    });
  const apps = shared.data?.apps ?? [];
  const waiting = new Set(
    (shared.data?.pending ?? []).map((request) => request.serverId),
  );
  const assigned = teamBot?.assignedGroups ?? [];

  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Text tone="muted" className="px-1 text-sm">
        Choose who can use this Bot. Each person's conversations with it are
        private.
      </Text>
      <Notice
        message={
          action.error ||
          bot.error ||
          published.error ||
          teams.error ||
          shared.error
        }
      />
      <Section title="Published">
        {teamBot ? (
          <Rows>
            <Row
              icon={IconUsersGroup}
              title={publishedTo(teamBot, teamList)}
              description={
                teamBot.visibleToTeam
                  ? "Each person's conversations with it are private."
                  : "Other people can't see it until it has a real name and a description."
              }
              trailing={
                value.mine ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={Boolean(action.busy)}
                    onPress={unpublish}
                  >
                    Unpublish
                  </Button>
                ) : undefined
              }
            />
            <Row
              icon={IconLink}
              title="Link"
              description="Opens a private conversation with it."
              trailing={
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => void Share.share({ message: botLink(botId) })}
                >
                  Share link
                </Button>
              }
            />
          </Rows>
        ) : (
          <Rows iconless>
            {value.visibility === "public" ? (
              // Public: who can use it, said once. Never "not published" beside "public".
              <Row
                title={`${everyone} can use it`}
                description="It's public."
              />
            ) : (
              <Row
                title="Not published"
                description={value.mine ? "Only you can use it." : undefined}
              />
            )}
          </Rows>
        )}
      </Section>
      {mayPublish(value) ? (
        <Section title={teamBot ? "Who it is published to" : "Publish"}>
          <Text tone="muted" className="px-1 text-sm">
            {value.visibility === "public"
              ? "It's public already. Publish it to get a link to share."
              : "Only the people and teams you publish it to can use it. You can unpublish at any time."}
          </Text>
          <Rows>
            <Row
              icon={IconUsersGroup}
              title="Audience"
              description={audienceSummary(
                teamBot,
                value.visibility === "public",
              )}
              onPress={() =>
                router.push({ pathname: "/bot-publish", params: { botId } })
              }
            />
          </Rows>
        </Section>
      ) : null}
      {context.admin && teamBot ? (
        <Section title="Assigned to">
          <Text tone="muted" className="px-1 text-sm">
            Pins this Bot at the top of the Bots list for everyone in a team, or
            for everyone in the organization.
          </Text>
          <Rows>
            {assigned.map((group) => {
              const name = assignmentName(group, teamList);
              return (
                <Row
                  key={group}
                  icon={IconUsersGroup}
                  title={name}
                  trailing={
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={Boolean(action.busy)}
                      accessibilityLabel={`Remove ${name}`}
                      onPress={() => assign(group, true)}
                    >
                      Remove
                    </Button>
                  }
                />
              );
            })}
            <MenuRow
              icon={IconPlus}
              title="Assign to a team or everyone"
              description={
                assigned.length === 0 ? "Not assigned to anyone." : undefined
              }
              menuTitle="It's pinned at the top of their Bots list, and they can't hide it."
              disabled={Boolean(action.busy)}
              groups={[
                {
                  choices: assignChoices(assigned, teamList ?? []).map(
                    (choice) => ({ id: choice.value, title: choice.label }),
                  ),
                },
              ]}
              onPick={(group) => assign(group)}
            />
          </Rows>
        </Section>
      ) : null}
      <Section title="Visibility">
        {mayChangeVisibility(value) ? (
          <ChoiceList
            label="Who can see it"
            options={choices}
            value={value.visibility}
            disabled={Boolean(action.busy)}
            onChange={setVisibility}
          />
        ) : (
          <Rows iconless>
            <Row
              title={
                choices.find((choice) => choice.value === value.visibility)
                  ?.label ?? ""
              }
            />
          </Rows>
        )}
        <Text tone="muted" className="px-1 text-sm">
          {visibilitySentence(value, context.organizationName)}
        </Text>
      </Section>
      {apps.length > 0 ? (
        <Section title="Shared accounts">
          {context.admin
            ? apps.map((app) => (
                <Text key={app.serverId} tone="muted" className="px-1 text-sm">
                  Everyone who can use this Bot can use the shared {app.title}{" "}
                  account.
                </Text>
              ))
            : apps.map((app) =>
                waiting.has(app.serverId) ? (
                  <Text
                    key={app.serverId}
                    tone="muted"
                    className="px-1 text-sm"
                  >
                    Waiting for an admin to approve the shared {app.title}{" "}
                    account.
                  </Text>
                ) : app.covered ? null : (
                  <Notice
                    key={app.serverId}
                    tone="warning"
                    message={`This Bot can't use the shared ${app.title} account until an admin approves who can use the Bot.`}
                    action={
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={Boolean(action.busy)}
                        onPress={() => ask(app.serverId)}
                      >
                        Request approval
                      </Button>
                    }
                  />
                ),
              )}
        </Section>
      ) : null}
    </ScrollScreen>
  );
}
