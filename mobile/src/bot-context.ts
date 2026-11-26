import { useEffect, useState } from "react";
import {
  ApiError,
  everyPage,
  ME,
  ORGANIZATION_ID,
  organizationChoices,
  readDeployment,
} from "./api";
import { getBotActivity } from "./api/generated/bots/bots";
import { listDestinations } from "./api/generated/destinations/destinations";
import type { TeamBot } from "./api/generated/model";
import { getPerson } from "./api/generated/people/people";
import { listTasks } from "./api/generated/tasks/tasks";
import { getTeamBot } from "./api/generated/team-bots/team-bots";
import { listTeams } from "./api/generated/teams/teams";
import { isAdmin, type Offers } from "./bot-settings";

/**
 * A Bot as it is published, or null while it isn't published (or isn't published to the person): the
 * API answers not found for both.
 */
export async function loadPublished(botId: string): Promise<TeamBot | null> {
  try {
    return (await getTeamBot(ORGANIZATION_ID, botId)).teamBot;
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return null;
    throw failure;
  }
}

/** Every team in the organization, page by page. */
export function everyTeam() {
  return everyPage(
    (page) => listTeams(ORGANIZATION_ID, page),
    (page) => page.teams,
  );
}

/** The places outside OpenBot the person continues conversations with one Bot. */
export async function loadDestinations(botId: string) {
  const all = await everyPage(
    (page) => listDestinations(ORGANIZATION_ID, ME, page),
    (page) => page.destinations,
  );
  return all.filter((destination) => destination.botId === botId);
}

/** What a Bot is doing for the person and has done: its own activity, and the person's tasks with it. */
export async function loadBotActivity(botId: string) {
  const [activity, tasks] = await Promise.all([
    getBotActivity(ORGANIZATION_ID, botId),
    everyPage(
      (page) => listTasks(ORGANIZATION_ID, page),
      (page) => page.tasks,
    ),
  ]);
  return { activity, tasks: tasks.filter((task) => task.botId === botId) };
}

/** What a Bot's screens need to know besides the Bot, which doesn't change while they are open. */
export type BotContext = {
  /** The personal edition: one person, nobody to share with. */
  personal: boolean;
  /** Whether the person runs their organization. */
  admin: boolean;
  /** What this OpenBot offers a Bot. Undefined until it has answered. */
  offers?: Offers;
  /** The organization's name, where it is known. */
  organizationName?: string;
};

/**
 * What this OpenBot offers, who the person is in their organization, and its name, each read once
 * while the screen is open. A read that fails leaves its part unknown: the screen offers the least it
 * can, and the server decides every change either way.
 */
export function useBotContext(enabled: boolean): BotContext {
  const [context, setContext] = useState<BotContext>({
    personal: false,
    admin: false,
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const update = (part: Partial<BotContext>) => {
      if (live) setContext((now) => ({ ...now, ...part }));
    };
    readDeployment(true)
      .then((deployment) =>
        update({
          personal: deployment.edition === "personal",
          offers: {
            isolatedBots: deployment.isolatedBots,
            hostedSignIn: deployment.hostedSignIn,
          },
        }),
      )
      .catch(() => {});
    getPerson(ORGANIZATION_ID, ME)
      .then(({ person }) => update({ admin: isAdmin(person.role) }))
      .catch(() => {});
    organizationChoices()
      .then(({ organizations, currentId }) =>
        update({
          organizationName: organizations.find((one) => one.id === currentId)
            ?.name,
        }),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return context;
}
