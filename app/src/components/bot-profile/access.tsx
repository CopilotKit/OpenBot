import {
  IconApps,
  IconBox,
  IconChevronRight,
  IconDots,
  IconPlug,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import {
  skillBotsSummary,
  useSkillBotRoster,
} from "@/components/skills/skill-bots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  giveBotAppMutationOptions,
  takeBackBotAppMutationOptions,
} from "@/lib/app-access/mutations";
import {
  type AppAccess,
  botAppsQueryOptions,
  type GiveableApp,
  giveableAppsQueryOptions,
} from "@/lib/app-access/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";
import { toolName } from "@/lib/plugins/tool-words";
import { putSkillsOnBot } from "@/lib/skills/import";
import {
  chooseSkillBotsMutationOptions,
  type SkillBots,
} from "@/lib/skills/mutations";
import { type Skill, skillListQueryOptions } from "@/lib/skills/queries";
import { queryClient } from "@/query-client";

/**
 * "google-drive" as "Google Drive": the connector key, said the way a person would.
 *
 * ONLY FOR A CONNECTOR THE APP-ACCESS READ DID NOT NAME. Every app it names is drawn by its own
 * display name — "Gmail", where this would have said "Composio Gmail".
 */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Connector key → the labels of the tools this Bot holds on it.
 *
 * Named as the app's own page lists them (`toolName`), each as a command: "Create goal", where
 * Activity says what was done, "Created a goal". A list that said some of each read as a list of
 * two kinds of thing.
 *
 * Vendors prefix every tool with their own name — "Notion create pages" — which next to a row
 * already titled Notion reads as a stutter. Stripped only as a leading word, and re-cased, so
 * "Notion search" becomes "Search" while "Search notion pages" is left alone.
 */
function connectorTools(plugins: GrantedPlugins): Map<string, string[]> {
  const connectors = new Map<string, string[]>();
  for (const tool of plugins.tools) {
    const key = tool.ref.split("/")[0] ?? tool.ref;
    let label = toolName(key, tool.ref.slice(key.length + 1) || tool.ref);
    const prefix = `${key.toLowerCase()} `;
    if (label.toLowerCase().startsWith(prefix)) {
      const rest = label.slice(prefix.length);
      label = rest ? rest[0]?.toUpperCase() + rest.slice(1) : label;
    }
    connectors.set(key, [...(connectors.get(key) ?? []), label]);
  }
  return connectors;
}

/** How many apps this Bot holds tools on. For the summary on the Bot's page. */
export function connectorCount(plugins: GrantedPlugins): number {
  return connectorTools(plugins).size;
}

/**
 * A Bot's Apps page: your own apps it may use, one switch each, and every app it holds. Which other
 * Bots it may hand work to is on its Setup page (`components/bot-profile/setup.tsx`).
 */
export function AppsSections({ agent }: { agent: AgentProfile }) {
  /*
   * Every Bot has every connected app in the personal edition, so there is no switch per app here.
   * Nothing until the edition is known, so the personal edition never draws Your apps for a moment.
   */
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const yourApps =
    agent.mine &&
    !capabilities.isPending &&
    capabilities.data?.edition !== "personal";
  return (
    <>
      {yourApps ? <YourApps agent={agent} /> : null}
      <Granted agentId={agent.id} kind="apps" mine={agent.mine} />
    </>
  );
}

/** A Bot's Skills page: your own skills on it, one switch each, and every skill it holds. */
export function SkillsSections({ agent }: { agent: AgentProfile }) {
  /*
   * In OpenBot Personal the one person runs every Bot, the ones OpenBot made for them included, and
   * may put any skill on any of them. Elsewhere only on a Bot of their own.
   */
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <>
      {agent.mine || (personal && agent.canManage) ? (
        <YourSkills agent={agent} />
      ) : null}
      <Granted agentId={agent.id} kind="skills" mine={agent.mine} />
    </>
  );
}

/**
 * Your own apps, one switch each: the ones you connected that an admin lets owners give, and any you
 * already gave this Bot. Only on your own Bot, for the reason the server gives — see
 * `server/src/plugins/owner-grants.ts`.
 *
 * WHAT A SWITCH GIVES is what an admin's one press gives: the app's read-only actions. Every call
 * runs on the asking person's own account, even after the Bot is published to the team, so the
 * description says "your" only about the person reading it.
 *
 * AN APP AN ADMIN GAVE THIS BOT is drawn switched on and locked. Taking it away is the admin's, and
 * the server would refuse it.
 */
function YourApps({ agent }: { agent: AgentProfile }) {
  const giveable = useQuery(giveableAppsQueryOptions());
  const held = useQuery(botAppsQueryOptions(agent.id));
  const give = useMutation(giveBotAppMutationOptions(queryClient));
  const takeBack = useMutation(takeBackBotAppMutationOptions(queryClient));
  const error = give.error ?? takeBack.error;
  const busy = give.isPending || takeBack.isPending;
  if (giveable.isPending || held.isPending) return null;
  const states = new Map((held.data ?? []).map((app) => [app.key, app]));
  /*
   * What you could give, and then anything you already gave that no longer is — an account you
   * disconnected since, an app an admin closed to owners — so it can still be switched off here.
   */
  const rows: (GiveableApp & { access?: AppAccess })[] = [
    ...(giveable.data ?? []).map((app) => ({
      ...app,
      access: states.get(app.key),
    })),
    ...(held.data ?? [])
      .filter(
        (app) =>
          app.givenByOwner &&
          !(giveable.data ?? []).some((given) => given.key === app.key),
      )
      .map((app) => ({ ...app, access: app })),
  ];
  return (
    <PageSection
      description={`Turn on an app to let ${agent.name} use it. It always uses the account of whoever is asking.`}
      title="Your apps"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {giveable.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your apps. Try again in a moment.
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/connections" />}
              size="sm"
              variant="outline"
            >
              <IconPlug />
              Connections
            </Button>
          }
          icon={IconApps}
          title="No apps to give yet"
        >
          Connect an app to let your Bots use it.
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((app, index) => {
            const granted = app.access?.granted ?? false;
            const locked = granted && !app.access?.givenByOwner;
            const yours =
              app.account === "personal"
                ? `your ${app.displayName}`
                : app.displayName;
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{app.displayName}</ItemTitle>
                    <ItemDescription>
                      {locked
                        ? "An admin gave it to this Bot."
                        : granted
                          ? `${agent.name} can use ${yours}.`
                          : `${agent.name} can't use ${yours}.`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={`Let ${agent.name} use ${app.displayName}`}
                      checked={granted}
                      disabled={busy || locked}
                      onCheckedChange={(next) => {
                        give.reset();
                        takeBack.reset();
                        const variables = { agentId: agent.id, app: app.key };
                        if (next) give.mutate(variables);
                        else takeBack.mutate(variables);
                      }}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * Your skills, one switch each. Only on your own Bot: the server lets a person put a skill on a Bot
 * they own when the skill is their own or granted to a team they are in, and neither half alone is
 * enough.
 *
 * WHICH SKILLS ARE YOURS COMES FROM THE SKILLS LIST (`listSkills`, its `usableOnYourBots`); WHETHER THIS BOT CARRIES ONE, FROM THE BOT'S OWN
 * GRANTS (listBotGrants, the read "What it can use" draws from too). That read is
 * where the personal edition gives a Bot every skill the first time it is listed, so it is what
 * gives a Bot made a moment ago its skills. The skills page, read alongside it or earlier, still said
 * the Bot had none, and every switch was drawn off until the page was opened again.
 *
 * The ones on this Bot come first. Add skills brings in several of the rest at once. In OpenBot
 * Personal each row also says which other Bots use it, and its menu makes it this Bot's alone, or
 * puts it back on every Bot.
 */
function YourSkills({ agent }: { agent: AgentProfile }) {
  const agentId = agent.id;
  const page = useQuery(skillListQueryOptions());
  const held = useQuery(agentPluginsQueryOptions(agentId));
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const roster = useSkillBotRoster();
  const grant = useMutation(setPluginGrantMutationOptions(queryClient));
  const choose = useMutation(chooseSkillBotsMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  const carried = new Set((held.data?.skills ?? []).map((skill) => skill.slug));
  const skills = (page.data ?? [])
    // In OpenBot Personal any skill, the ones OpenBot ships included: the person is its admin.
    .filter((skill) => personal || skill.usableOnYourBots)
    // On this Bot first, each half in the list's own order.
    .sort((a, b) => Number(carried.has(b.slug)) - Number(carried.has(a.slug)));
  const notHere = skills.filter((skill) => !carried.has(skill.slug));
  const error = grant.error ?? choose.error;
  const loaded = !page.isPending && !held.isPending;
  const failed = Boolean(page.error || held.error);
  return (
    <PageSection
      action={
        loaded && !failed && notHere.length > 0 ? (
          <Button
            onClick={() => setAdding(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <IconPlus />
            Add skills
          </Button>
        ) : null
      }
      description="Turn on a skill to use it with this Bot. Type / in a conversation to run it."
      title="Your skills"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {!loaded ? null : failed ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't load your skills. Try again in a moment.
        </p>
      ) : skills.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/skills" />}
              size="sm"
              variant="outline"
            >
              <IconPlus />
              Write a skill
            </Button>
          }
          icon={IconBox}
          title="No skills yet"
        >
          Skills you write, and skills an admin gives your team, show up here.
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.map((skill, index) => {
            const on = carried.has(skill.slug);
            return (
              <Fragment key={skill.slug}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBox />
                  </ItemMedia>
                  {/* By its title, as What it can use names it below; the section says how to run it. */}
                  <ItemContent>
                    <ItemTitle>{skill.title}</ItemTitle>
                    <ItemDescription>{skill.summary}</ItemDescription>
                    {personal ? (
                      <p className="text-muted-foreground text-xs">
                        {whereItIs(skill, agent, roster, on)}
                      </p>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    {personal ? (
                      <SkillMenu
                        agent={agent}
                        busy={choose.isPending}
                        onChoose={(bots) => {
                          grant.reset();
                          choose.mutate({ slug: skill.slug, bots });
                        }}
                        on={on}
                        skill={skill}
                      />
                    ) : null}
                    <Switch
                      aria-label={skill.title}
                      checked={on}
                      disabled={grant.isPending || choose.isPending}
                      onCheckedChange={(granted) => {
                        choose.reset();
                        grant.mutate({
                          agentId,
                          granted,
                          kind: "skill",
                          ref: skill.slug,
                        });
                      }}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
      {adding ? (
        <AddSkills
          agent={agent}
          onClose={() => setAdding(false)}
          roster={roster}
          showWhere={personal}
          skills={notHere}
        />
      ) : null}
    </PageSection>
  );
}

type RosterBot = { id: string; name: string };

/** Which Bots use a skill, said from this Bot's page: "Every Bot", "Only Coder", "Also on Writer". */
function whereItIs(
  skill: Skill,
  agent: AgentProfile,
  roster: readonly RosterBot[],
  on: boolean,
): string {
  if (skill.everyBot) return "Every Bot";
  const others = roster.filter(
    (bot) => bot.id !== agent.id && skill.grantedTo.includes(bot.id),
  );
  const names = skillBotsSummary(
    { everyBot: false, grantedTo: others.map((bot) => bot.id) },
    others,
  );
  if (on)
    return others.length === 0 ? `Only ${agent.name}` : `Also on ${names}`;
  return others.length === 0 ? "Not on any Bot" : `On ${names}`;
}

/**
 * A skill's menu on this Bot's page, OpenBot Personal's: make it this Bot's alone, or put it on every
 * Bot. Only what would change something is offered.
 */
function SkillMenu({
  skill,
  agent,
  on,
  busy,
  onChoose,
}: {
  skill: Skill;
  agent: AgentProfile;
  on: boolean;
  busy: boolean;
  onChoose: (bots: SkillBots) => void;
}) {
  const onlyHere =
    on && !skill.everyBot && skill.grantedTo.every((id) => id === agent.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`More for ${skill.title}`}
            disabled={busy}
            size="icon-sm"
            variant="ghost"
          >
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {onlyHere ? null : (
            <DropdownMenuItem
              onClick={() => onChoose({ everyBot: false, botIds: [agent.id] })}
            >
              Only on {agent.name}
            </DropdownMenuItem>
          )}
          {skill.everyBot ? null : (
            <DropdownMenuItem onClick={() => onChoose({ everyBot: true })}>
              On every Bot
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Put several of your skills on this Bot at once: the ones it hasn't got, to tick. */
function AddSkills({
  agent,
  skills,
  roster,
  showWhere,
  onClose,
}: {
  agent: AgentProfile;
  skills: readonly Skill[];
  roster: readonly RosterBot[];
  /** Say which Bots use each one now: OpenBot Personal's. */
  showWhere: boolean;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const add = useMutation({
    mutationFn: (slugs: string[]) =>
      putSkillsOnBot(queryClient, slugs, agent.id),
  });
  const problems = (add.data ?? []).filter((one) => one.problem);
  const shown = skills.filter((skill) =>
    `${skill.title} ${skill.slug} ${skill.summary}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add skills to {agent.name}</DialogTitle>
          <DialogDescription>
            Choose your skills for {agent.name} to use. Other Bots keep the ones
            they have.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-3">
          {skills.length > 6 ? (
            <Input
              aria-label="Find a skill"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a skill"
              value={filter}
            />
          ) : null}
          <ul className="grid max-h-80 gap-1 overflow-y-auto rounded-md border border-border p-1">
            {shown.map((skill) => (
              <li
                className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                key={skill.slug}
              >
                <Checkbox
                  aria-labelledby={`add-skill-${skill.slug}`}
                  checked={picked.has(skill.slug)}
                  className="mt-0.5"
                  disabled={add.isPending || add.isSuccess}
                  onCheckedChange={(checked) => {
                    const next = new Set(picked);
                    if (checked) next.add(skill.slug);
                    else next.delete(skill.slug);
                    setPicked(next);
                  }}
                />
                <span className="grid min-w-0 gap-0.5">
                  <span
                    className="font-medium text-sm"
                    id={`add-skill-${skill.slug}`}
                  >
                    {skill.title}
                  </span>
                  {skill.summary ? (
                    <span className="text-muted-foreground text-xs">
                      {skill.summary}
                    </span>
                  ) : null}
                  {showWhere ? (
                    <span className="text-muted-foreground text-xs">
                      {whereItIs(skill, agent, roster, false)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
            {shown.length === 0 ? (
              <li className="px-2 py-2 text-muted-foreground text-sm">
                No skill matches.
              </li>
            ) : null}
          </ul>
          {add.error ? (
            <p className="text-destructive text-sm" role="alert">
              {add.error.message}
            </p>
          ) : null}
          {problems.map((one) => (
            <p className="text-destructive text-sm" key={one.slug} role="alert">
              /{one.slug} isn't on {agent.name}: {one.problem}
            </p>
          ))}
        </DialogBody>
        <DialogFooter>
          {add.isSuccess ? (
            <Button onClick={onClose} size="sm" type="button">
              Done
            </Button>
          ) : (
            <>
              <Button
                disabled={add.isPending}
                onClick={onClose}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={add.isPending || picked.size === 0}
                onClick={() =>
                  add.mutate([...picked], {
                    onSuccess: (results) => {
                      if (results.every((one) => !one.problem)) onClose();
                    },
                  })
                }
                size="sm"
                type="button"
              >
                {add.isPending
                  ? "Adding…"
                  : `Add ${picked.size} skill${picked.size === 1 ? "" : "s"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything this Bot holds, read from the same snapshot a run is offered, and what each app is for
 * the person looking.
 *
 * READ-ONLY FOR GRANTS, NOT FOR THE PERSON'S OWN PART. Apps are granted by an administrator, who gets
 * a link to where that is decided — or, on a Bot you own, by you, under Your apps above. But a Bot that holds Gmail is no use to somebody who has not
 * connected their Gmail, and this list used to say "Gmail · 4 tools" to everybody alike — so each
 * app now says what it is for the person reading (listBotApps) with the one
 * thing they can do about it: Connect, Reconnect, Request access, or Requested. The state is the
 * server's and is drawn as it comes; see `AppAccessAction`.
 *
 * ADMINISTRATORS SEE THEIR OWN STATE HERE TOO, AND NOBODY ELSE'S. The app-access read answers for
 * whoever is asking, exactly as the connections read does, so this cannot become a list of who has
 * connected what.
 */
function Granted({
  agentId,
  kind,
  mine,
}: {
  agentId: string;
  /** Which half of what it holds: its apps (on its Apps page) or its skills (on its Skills page). */
  kind: "apps" | "skills";
  mine: boolean;
}) {
  const me = useQuery(currentUserQueryOptions()).data;
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const edition = capabilities.data?.edition ?? "team";
  const plugins = useQuery(agentPluginsQueryOptions(agentId));
  // Only on the Apps page: the Skills page draws no app, and this read can wait on the app
  // directory, so the skills waited for it for nothing. A query that is not enabled stays pending.
  const apps = useQuery({
    ...botAppsQueryOptions(agentId),
    enabled: kind === "apps",
  });
  /*
   * Both on the Apps page, so no row is drawn without its state and then redrawn with one a moment
   * later; and the edition, so the personal edition never shows the team edition's empty state first.
   */
  if (
    plugins.isPending ||
    (kind === "apps" && apps.isPending) ||
    capabilities.isPending
  )
    return null;
  if (!plugins.data) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load what this Bot can use. Try again in a moment.
      </p>
    );
  }
  const admin = isOrganizationAdmin(me?.role);
  const tools = connectorTools(plugins.data);
  const states = apps.data ?? [];
  /*
   * Every app the Bot holds a grant for, by the app's own name, and then any connector the grant
   * snapshot names that the app-access read did not — which is none on a healthy deployment, and
   * keeps a row from vanishing on one where the second read failed.
   */
  const described = new Set(states.map((app) => app.key));
  const rest =
    kind === "apps"
      ? [...tools.entries()].filter(([key]) => !described.has(key))
      : [];
  const shownStates = kind === "apps" ? states : [];
  const skills = kind === "skills" ? plugins.data.skills : [];
  const count = shownStates.length + rest.length + skills.length;
  return (
    <PageSection
      description={
        kind === "apps"
          ? "Review the apps this Bot can use, and check which are ready for you. It can't use apps outside this list."
          : "These are the skills this Bot can use. It can't use skills outside this list."
      }
      title={kind === "apps" ? "Apps it can use" : "Skills it has"}
    >
      {kind === "apps" && apps.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't check whether each app is ready for you. Try again in a
          moment.
        </p>
      ) : null}
      {count === 0 && kind === "skills" ? (
        <PageEmpty icon={IconBox} title="No skills yet">
          {mine
            ? "Turn one on under Your skills, or write one on the Skills page."
            : "The Bot's owner or an admin gives it skills."}
        </PageEmpty>
      ) : count === 0 ? (
        <PageEmpty icon={IconApps} title="No apps yet">
          {/*
           * The personal edition has no Your apps and no admin: every Bot gets every app you
           * connect, so the one way in is Connections.
           */}
          {edition === "personal" ? (
            <>
              Connect one on <Link to="/connections">Connections</Link>.
            </>
          ) : mine ? (
            "Turn one on under Your apps, or ask an admin. Until then this Bot can only talk with you."
          ) : (
            "An admin has to add them. Until then this Bot can only talk with you."
          )}
        </PageEmpty>
      ) : (
        <PageRows>
          {shownStates.map((app, index) => {
            const labels = tools.get(app.key) ?? [];
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} data-state={app.state} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{app.displayName}</ItemTitle>
                    {/*
                     * Unclamped: the sentence ends on who can fix it, and two lines at a phone's
                     * width cut exactly that off.
                     */}
                    <ItemDescription className="line-clamp-none">
                      {app.state === "ready"
                        ? [appAccessSentence(app, undefined, edition, admin)]
                            .concat(labels.length > 0 ? [toolList(labels)] : [])
                            .join(" ")
                        : appAccessSentence(app, undefined, edition, admin)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {app.state === "ready" ? (
                      <ToolCount count={labels.length} />
                    ) : (
                      <AppAccessAction access={app} agentId={agentId} />
                    )}
                    {admin ? (
                      <ManageLink
                        agentId={agentId}
                        appKey={app.key}
                        title={app.displayName}
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
          {rest.map(([key, labels], index) => (
            <Fragment key={key}>
              {shownStates.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconApps />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{connectorName(key)}</ItemTitle>
                  <ItemDescription>{toolList(labels)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ToolCount count={labels.length} />
                  {admin ? (
                    <ManageLink
                      agentId={agentId}
                      appKey={key}
                      title={connectorName(key)}
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {shownStates.length + rest.length + index > 0 ? (
                <Separator />
              ) : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBox />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{skill.title}</ItemTitle>
                  <ItemDescription>{skill.summary}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">Skill</span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** The first few tool labels, and how many more. */
function toolList(labels: string[]): string {
  return `${labels.slice(0, 4).join(", ")}${labels.length > 4 ? ` and ${labels.length - 4} more` : ""}`;
}

function ToolCount({ count }: { count: number }) {
  return (
    <span className="text-muted-foreground text-sm tabular-nums">
      {count} {count === 1 ? "tool" : "tools"}
    </span>
  );
}

/**
 * Where an administrator decides which of the app's tools this Bot holds.
 *
 * A CHEVRON OF ITS OWN RATHER THAN THE WHOLE ROW. The row used to be the link, which was right while
 * it held nothing else; now it can hold Connect or Request access, and a button inside a link is two
 * controls answering one click. The destination is unchanged.
 */
function ManageLink({
  agentId,
  appKey,
  title,
}: {
  agentId: string;
  appKey: string;
  title: string;
}) {
  const paths = useManagePaths();
  return (
    <Button
      aria-label={`Manage ${title} on this Bot`}
      render={<Link {...paths.pluginBot(appKey, agentId)} />}
      size="icon-sm"
      variant="ghost"
    >
      <IconChevronRight className="size-4 text-muted-foreground" />
    </Button>
  );
}
