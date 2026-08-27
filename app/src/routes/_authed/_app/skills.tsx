import { IconDots, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { EditSkill } from "@/components/skills/edit-skill";
import { NewSkill } from "@/components/skills/new-skill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { removeSkillMutationOptions } from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Personal `/` skills. They are instructions, not capabilities, and can only be granted to Bots the
 * signed-in user owns.
 */

/**
 * Writing a skill is a search parameter rather than a route, so the list stays on screen behind the
 * panel and the form is linkable, reloadable, and closed by Back — the same contract the agents
 * roster makes.
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: skillsSearchSchema,
  component: SkillsPage,
});

function SkillsPage() {
  const queryClient = useQueryClient();
  const { new: isCreating, edit: editingSlug } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Creating wins if both are somehow set: it is the more recent intent, the same rule the agents
  // roster uses when `new` and `agent` arrive together.
  const showCreate = isCreating === true;
  const showEdit = !showCreate && editingSlug !== undefined;
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
  const [error, setError] = useState<string | null>(null);

  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });

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
    <DetailPanel
      detail={
        showCreate ? (
          <NewSkill />
        ) : editingSlug ? (
          <EditSkill slug={editingSlug} />
        ) : null
      }
      onClose={() => navigate({ search: {} })}
      open={showCreate || showEdit}
    >
      <PageShell
        description={
          <>
            A skill is a named instruction you invoke with <code>/</code> and a
            Bot follows. Yours are yours alone, and go on the Bots you own.
          </>
        }
        title="Agent Skills"
      >
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <PageSection
          action={
            <Button
              render={(props) => (
                <Link search={{ new: true }} to="/skills" {...props} />
              )}
              size="sm"
              variant="ghost"
            >
              <IconPlus />
              New skill
            </Button>
          }
          title="Your skills"
        >
          {/*
           * Nothing while the two queries are still in flight. The alternative is the empty state
           * standing there saying this person has written no skills, which is a claim the page has
           * not yet earned.
           */}
          {loading ? null : mine.length === 0 ? (
            <Empty className="mt-4 h-[180px] border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  You don't have any skills yet.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <PageRows>
              {mine.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * THE COMMAND FIRST, because it is the only part a person has to know. The title
                       * says what the skill is for; `/slug` is what they actually type, and a page that
                       * lists skills without showing how to invoke one leaves them guessing at it.
                       *
                       * The interpunct only appears when there is a summary to separate it from —
                       * a trailing "· " on a skill written without one reads as something missing.
                       */}
                      <ItemDescription>
                        <code className="font-mono text-foreground/80 text-xs">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon-sm">
                              <IconDots />
                            </Button>
                          }
                        ></DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onClick={() =>
                                navigate({ search: { edit: skill.slug } })
                              }
                            >
                              Edit
                            </DropdownMenuItem>
                            {/*
                             * Deleting is immediate and there is no undo. It is behind a menu rather
                             * than sitting on the row for that reason, and the slug is named in the
                             * label so the destructive item says WHICH skill it destroys — a menu
                             * opened over the wrong row is the ordinary way this goes wrong.
                             */}
                            <DropdownMenuItem
                              onClick={() => {
                                setError(null);
                                removeSkill.mutate(skill.slug);
                              }}
                              variant="destructive"
                            >
                              Delete /{skill.slug}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </ItemActions>
                  </Item>
                  {index !== mine?.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
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
            description="Written for everyone by an administrator. Which Bots carry them is decided in Admin."
            title="Workspace skills"
          >
            <PageRows>
              {deployment.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * THE COMMAND FIRST, because it is the only part a person has to know. The title
                       * says what the skill is for; `/slug` is what they actually type, and a page that
                       * lists skills without showing how to invoke one leaves them guessing at it.
                       *
                       * The interpunct only appears when there is a summary to separate it from —
                       * a trailing "· " on a skill written without one reads as something missing.
                       */}
                      <ItemDescription>
                        <code className="font-mono text-foreground/80">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                  {index !== deployment.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          </PageSection>
        ) : null}

        {/*
         * The commented write-a-skill form that used to sit here is gone: the detail panel above is
         * the real one now. `SkillRow` below is still parked, because its per-Bot grant toggles have
         * no equivalent in the redesigned rows yet.
         */}
      </PageShell>
    </DetailPanel>
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
