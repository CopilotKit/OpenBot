import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { ORGANIZATION_ID } from "../src/api";
import type { OrganizationMember } from "../src/api/generated/model";
import { listOrganizationMembers } from "../src/api/generated/organizations/organizations";
import { publishTeamBot } from "../src/api/generated/team-bots/team-bots";
import { authClient } from "../src/auth";
import { everyTeam, loadPublished } from "../src/bot-context";
import { AUDIENCE_CHOICES, publication } from "../src/bot-settings";
import {
  ChoiceList,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  SearchField,
  Section,
  Text,
  Toggle,
} from "../src/components";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";

/** How many members a search offers. */
const OFFERED = 8;

/** How long typing pauses before the search is sent. */
const DEBOUNCE_MS = 250;

/**
 * Who a Bot is published to, as the web app's Publish dialog: everyone in the organization, or named
 * teams and people. People are found among the organization's members as their name or address is
 * typed, never typed in whole, so nobody outside it can be chosen. Directory groups it was published
 * to before there were teams are kept as they are.
 */
export default function BotPublishScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session && botId);
  const action = useAction();
  const loadPublication = useCallback(() => loadPublished(botId), [botId]);
  const published = useLoad(loadPublication, signedIn);
  const loadTeams = useCallback(() => everyTeam(), []);
  const teams = useLoad(loadTeams, signedIn);
  const [loaded, setLoaded] = useState(false);
  const [audience, setAudience] = useState<"team" | "people">("team");
  const [emails, setEmails] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<OrganizationMember[]>([]);
  const [searchError, setSearchError] = useState("");
  // Each opening starts from the current answer.
  useEffect(() => {
    if (loaded || published.data === undefined) return;
    setLoaded(true);
    const current = published.data;
    if (!current) return;
    setAudience(current.audience === "people" ? "people" : "team");
    setEmails(current.people ?? []);
    setChosen(current.teams ?? []);
    setGroups(current.groups ?? []);
  }, [loaded, published.data]);
  useEffect(() => {
    const search = typed.trim().toLowerCase();
    if (!search || !signedIn) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      listOrganizationMembers(ORGANIZATION_ID, { search, limit: OFFERED })
        .then((page) => {
          if (!live) return;
          setFound(page.members);
          setSearchError("");
        })
        .catch((failure) => {
          if (live)
            setSearchError(
              failure instanceof Error
                ? failure.message
                : "Couldn't search the organization. Try again.",
            );
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed, signedIn]);
  if (!session && !isPending) return <Redirect href="/" />;

  const current = published.data ?? undefined;
  const chosenEmails = new Set(emails.map((email) => email.toLowerCase()));
  const toggleTeam = (teamId: string, on: boolean) =>
    setChosen((now) =>
      on ? [...now, teamId] : now.filter((one) => one !== teamId),
    );
  const save = () =>
    void action.run("publish", async () => {
      await publishTeamBot(
        ORGANIZATION_ID,
        botId,
        publication({ audience, emails, teams: chosen, groups }),
      );
      router.back();
    });

  return (
    <ScrollScreen>
      <Text tone="muted" className="px-1 text-sm">
        Only the people and teams you publish it to can use it. You can
        unpublish at any time.
      </Text>
      <Notice message={action.error || published.error || teams.error} />
      <Section title="Published to">
        <ChoiceList
          label="Published to"
          options={AUDIENCE_CHOICES}
          value={audience}
          onChange={setAudience}
        />
      </Section>
      {audience === "people" ? (
        <>
          <Section title="Teams">
            {teams.data && teams.data.length === 0 ? (
              <Text tone="muted" className="px-1 text-sm">
                There are no teams yet. An admin creates them on the Teams page.
              </Text>
            ) : null}
            {teams.data?.length ? (
              <Rows iconless>
                {teams.data.map((team) => (
                  <Row
                    key={team.id}
                    title={team.name}
                    trailing={
                      <Toggle
                        label={`Publish it to ${team.name}`}
                        value={chosen.includes(team.id)}
                        onValueChange={(on) => toggleTeam(team.id, on)}
                      />
                    }
                  />
                ))}
              </Rows>
            ) : null}
          </Section>
          <Section title="People">
            {emails.length > 0 ? (
              <Rows iconless>
                {emails.map((email) => (
                  <Row
                    key={email}
                    title={email}
                    trailing={
                      <Button
                        size="sm"
                        variant="secondary"
                        accessibilityLabel={`Remove ${email}`}
                        onPress={() =>
                          setEmails((now) => now.filter((one) => one !== email))
                        }
                      >
                        Remove
                      </Button>
                    }
                  />
                ))}
              </Rows>
            ) : null}
            <View className="gap-2">
              <SearchField
                value={typed}
                onChangeText={setTyped}
                placeholder="Find people by name or address"
              />
              <Notice message={searchError} />
              {found.length > 0 ? (
                <Rows iconless>
                  {found.map((person) => {
                    const taken = chosenEmails.has(person.email.toLowerCase());
                    const unavailable = taken
                      ? "Chosen"
                      : person.email.trim()
                        ? undefined
                        : "Hasn't signed in yet";
                    return (
                      <Row
                        key={person.id}
                        title={person.name || person.email}
                        description={unavailable ?? person.email}
                        chevron={false}
                        onPress={
                          unavailable
                            ? undefined
                            : () => {
                                setEmails((now) => [...now, person.email]);
                                setTyped("");
                              }
                        }
                      />
                    );
                  })}
                </Rows>
              ) : null}
            </View>
          </Section>
          {groups.length > 0 ? (
            <Text tone="muted" className="px-1 text-sm">
              It stays published to {groups.join(", ")}. To reach more people,
              choose a team.
            </Text>
          ) : null}
        </>
      ) : null}
      <Button isDisabled={!loaded || Boolean(action.busy)} onPress={save}>
        {action.busy === "publish"
          ? current
            ? "Updating…"
            : "Publishing…"
          : current
            ? "Update"
            : "Publish"}
      </Button>
    </ScrollScreen>
  );
}
