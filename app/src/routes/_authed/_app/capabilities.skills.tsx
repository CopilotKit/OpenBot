import { IconBuilding, IconPlus, IconSlash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { PageSection } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type PluginSkill,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Personal `/` skills. They are instructions, not capabilities, and can only be granted to Bots the
 * signed-in user owns.
 */

/**
 * Writing and editing a skill used to be `?new` and `?edit=<slug>` on this page, in a panel and then
 * a sheet beside the list. They are screens of their own now, at `/capabilities/skills/new` and
 * `/capabilities/skills/<slug>`; the parameters are still read so a link already sent in a
 * conversation, where a proposed skill says "Put it on a Bot", lands on the screen it means.
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/capabilities/skills")({
  validateSearch: skillsSearchSchema,
  beforeLoad: ({ search }) => {
    // Creating wins if both are somehow set: it is the more recent intent.
    if (search.new === true) {
      throw redirect({ to: "/capabilities/skills/new", replace: true });
    }
    if (search.edit !== undefined) {
      throw redirect({
        params: { slug: search.edit },
        replace: true,
        to: "/capabilities/skills/$slug",
      });
    }
  },
  component: SkillsPage,
});

function SkillsPage() {
  const { data, isPending: skillsPending } = useQuery(
    pluginsPageQueryOptions(),
  );
  const { data: me, isPending: mePending } = useQuery(
    currentUserQueryOptions(),
  );
  /*
   * Both, because `mine` is the intersection of the two: until the person is known, nothing matches
   * them and the list is empty for a reason that is not "you have no skills".
   */
  const loading = skillsPending || mePending;
  // Every Bot this person can see, to draw the faces of the ones a skill is on.
  const { data: agents } = useQuery(agentListQueryOptions());
  const botsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));

  /*
   * The server has ALREADY excluded skills this person may not see — `listSkills` scopes the query
   * to `owner_user_id is null or owner_user_id = me`, so somebody else's private skill is never read
   * into the process. These two lines only sort what arrived into the two things the page draws.
   *
   * ONE CASE FALLS THROUGH ON PURPOSE, FOR NOW: an administrator receives everybody's skills, and
   * another person's lands in neither list. Not a leak, but an administrator cannot see here what
   * they are entitled to. Worth an owner column or a third section before this page is called done.
   */
  const skills = data?.skills ?? [];
  const mine = skills.filter((skill) => skill.ownerUserId === me?.id);
  const deployment = skills.filter((skill) => skill.ownerUserId === null);

  return (
    <CapabilitiesShell>
      <PageSection
        action={
          <Button
            render={(props) => (
              <Link to="/capabilities/skills/new" {...props} />
            )}
            size="sm"
            variant="ghost"
          >
            <IconPlus />
            New skill
          </Button>
        }
        description={
          <>
            Type <code>/</code> and a skill's name to give a Bot that
            instruction. Only you see yours, and they work on Bots you own.
          </>
        }
        title="Your skills"
      >
        {/*
         * Nothing while the two queries are still in flight. The alternative is the empty state
         * standing there saying this person has written no skills, which is a claim the page has
         * not yet earned.
         *
         * And not after a read that failed, for the same reason: `isPending` goes false on a
         * failed fetch too, and no list is no evidence of no skills. A list already held stays on
         * screen through a failed refetch, because `data` is still there.
         */}
        {loading ? null : !data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Couldn't load your skills. Reload the page.
          </p>
        ) : mine.length === 0 ? (
          <Empty className="mt-4 h-[180px] border border-dashed">
            <EmptyHeader>
              <EmptyTitle className="text-muted-foreground">
                No skills yet. Write one with New skill.
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          /*
           * A card per skill, 12px apart, where most lists are one `PageRows` card of divided rows.
           * Each skill is a thing of its own, opened and deleted on its own, not a line in one
           * setting; the same separate `outline` cards the Connections tiles use.
           */
          <div className="mt-4 flex flex-col gap-3">
            {mine.map((skill, index) => (
              <StaggerItem index={index} key={skill.id}>
                <SkillCard bots={botsById} opens skill={skill} />
              </StaggerItem>
            ))}
          </div>
        )}
      </PageSection>

      {/*
       * NO MENU ON THESE ROWS, AND THAT IS THE POINT. A workspace skill belongs to the deployment,
       * not to the person reading this page: they cannot edit it, delete it, or choose which Bots
       * carry it. Drawing the same dropdown here and refusing on click would be a worse answer than
       * not offering it — the server refuses either way, and an affordance that only ever fails is
       * a promise the page cannot keep.
       *
       * Hidden entirely when there are none, rather than shown empty: an administrator who has
       * written nothing yet is the normal case, and a permanently empty section reads as broken.
       */}
      {deployment.length > 0 ? (
        <PageSection
          description="An admin writes these for everyone and picks which Bots use them."
          title="Workspace skills"
        >
          <div className="mt-4 flex flex-col gap-3">
            {deployment.map((skill, index) => (
              <StaggerItem index={index} key={skill.id}>
                <SkillCard bots={botsById} skill={skill} workspace />
              </StaggerItem>
            ))}
          </div>
        </PageSection>
      ) : null}

      {/*
       * The commented write-a-skill form that used to sit here is gone: the screens at
       * `/capabilities/skills/new` and `/$slug` are the real ones now. `SkillRow` below is still
       * parked, because its per-Bot grant toggles have no equivalent in the redesigned rows yet.
       */}
    </CapabilitiesShell>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How many faces the chip stacks; the count beside them says how many there are in all. */
const FACES = 3;

/**
 * Where a skill is in use, as one chip: the faces of the Bots it is on, then how many Bots and how
 * many tools, as in "3 Bots · 5 tools".
 *
 * Faces as well as a count, because the faces are the same ones the Bots roster draws and say which
 * at a glance; their names are the chip's tooltip. A Bot this person cannot see still counts without
 * being named or drawn.
 *
 * "Not on a Bot yet" rather than "0 Bots", because a skill on no Bot is written and inert — nobody's
 * `/` menu offers it — and that is the thing a person scanning their skills most needs to notice.
 */
function SkillUsage({
  skill,
  bots,
}: {
  skill: PluginSkill;
  bots: Map<string, AgentProfile>;
}) {
  const seen = skill.grantedTo.flatMap((id) => bots.get(id) ?? []);
  const tools = skill.tools?.length ?? 0;
  const parts = [
    skill.grantedTo.length === 0
      ? "Not on a Bot yet"
      : plural(skill.grantedTo.length, "Bot", "Bots"),
    ...(tools > 0 ? [plural(tools, "tool", "tools")] : []),
  ];
  const names = seen.map((bot) => bot.name).join(", ");

  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2 text-muted-foreground text-xs"
      title={names ? `On ${names}` : undefined}
    >
      {seen.length > 0 ? (
        <span aria-hidden="true" className="flex items-center -space-x-1">
          {seen.slice(0, FACES).map((bot) => (
            <span className="flex rounded-full ring-1 ring-muted" key={bot.id}>
              <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={14} />
            </span>
          ))}
        </span>
      ) : null}
      {parts.join(" · ")}
    </span>
  );
}

/**
 * One skill: what it is called, what you type, what it is for, and where it is in use.
 *
 * THE COMMAND BESIDE THE TITLE, because it is the only part a person has to know. The title says what
 * the skill is for; `/slug` is what they actually type, and a page that lists skills without showing
 * how to invoke one leaves them guessing at it. The one-liner gets the second line to itself.
 *
 * A building for a workspace skill and a slash for your own, so the two sections read apart at a
 * glance: one is the deployment's, looked after by an administrator, the other is yours to change.
 *
 * `opens` makes the whole card a link to the skill's screen, where it is edited, put on Bots and
 * deleted. Nothing else on the card does anything, so there is nothing for a press to land on but
 * the skill itself.
 */
function SkillCard({
  skill,
  bots,
  opens = false,
  workspace = false,
}: {
  skill: PluginSkill;
  bots: Map<string, AgentProfile>;
  opens?: boolean;
  workspace?: boolean;
}) {
  return (
    <Item
      className="bg-card dark:border-transparent"
      render={
        opens ? (
          <Link params={{ slug: skill.slug }} to="/capabilities/skills/$slug" />
        ) : undefined
      }
      size="sm"
      variant="outline"
    >
      <ItemMedia variant="icon">
        {workspace ? <IconBuilding /> : <IconSlash />}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <ItemTitle className="min-w-0 truncate">{skill.title}</ItemTitle>
          <code className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
            /{skill.slug}
          </code>
        </div>
        {skill.summary ? (
          <ItemDescription className="line-clamp-1">
            {skill.summary}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="hidden sm:flex">
        <SkillUsage bots={bots} skill={skill} />
      </ItemActions>
    </Item>
  );
}

/*
 * Parked, not deleted. Its only callers are the commented sections above, and it still holds the
 * per-Bot grant toggles — the one piece of the old page the new one has no equivalent for yet.
 * Whoever adds granting to the redesigned rows should start from this rather than reinvent it.
 *
 * function SkillRow({
 *   skill,
 *   bots,
 *   onToggle,
 *   onDelete,
 * }: {
 *   skill: PluginSkill;
 *   bots: { id: string; name: string }[];
 *   onToggle?: (agentId: string, held: boolean) => void;
 *   onDelete?: () => void;
 * }) {
 *   const held = new Set(skill.grantedTo);
 *
 *   return (
 *     <li className="rounded-xl border border-border p-4">
 *       <div className="flex items-start justify-between gap-4">
 *         <div className="min-w-0">
 *           <div className="flex items-baseline gap-2">
 *             <code className="font-medium">/{skill.slug}</code>
 *             <span className="text-sm text-muted-foreground">{skill.title}</span>
 *           </div>
 *           {skill.summary ? (
 *             <p className="mt-0.5 text-sm text-muted-foreground">
 *               {skill.summary}
 *             </p>
 *           ) : null}
 *         </div>
 *         {onDelete ? (
 *           <Button onClick={onDelete} size="sm" variant="outline">
 *             Delete
 *           </Button>
 *         ) : null}
 *       </div>
 *
 *       {onToggle ? (
 *         <div className="mt-3 flex flex-wrap items-center gap-2">
 *           {bots.length === 0 ? (
 *             <p className="text-sm text-muted-foreground">
 *               You do not own a Bot to put this on yet.
 *             </p>
 *           ) : (
 *             bots.map((bot) => {
 *               const on = held.has(bot.id);
 *               return (
 *                 <button
 *                   className={`rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
 *                     on
 *                       ? "border-primary/40 bg-primary/10 text-foreground"
 *                       : "border-border text-muted-foreground hover:text-foreground"
 *                   }`}
 *                   key={bot.id}
 *                   onClick={() => onToggle(bot.id, on)}
 *                   type="button"
 *                 >
 *                   {on ? "✓ " : ""}
 *                   {bot.name}
 *                 </button>
 *               );
 *             })
 *           )}
 *         </div>
 *       ) : null}
 *     </li>
 *   );
 * }
 */
