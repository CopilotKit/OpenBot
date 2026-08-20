import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";

/**
 * Which of your Agents carry this skill.
 *
 * WITHOUT THIS THE SKILL DOES NOTHING. A skill reaches a Bot's `/` menu only through a grant: the
 * menu is fed by `GET /api/plugins/for/:agentId`, which returns what that Bot HOLDS, and a row in
 * `plugin_grants` IS the grant — absence is the refusal. A skill nobody granted is written, listed,
 * and invisible everywhere it would actually be used.
 *
 * ONLY BOTS THIS PERSON OWNS. The server's rule is that somebody may put THEIR OWN skill on a Bot
 * THEY OWN, and neither half alone is enough — a skill one person wrote would otherwise change how a
 * shared Bot answers everybody. Offering the others here and having them refused on click would be
 * a worse answer than not offering them.
 */
export function SkillAgents({
  slug,
  grantedTo,
}: {
  slug: string;
  grantedTo: string[];
}) {
  const queryClient = useQueryClient();
  const { data: agents } = useQuery(agentListQueryOptions());
  const mine = (agents ?? []).filter((agent) => agent.mine);
  const held = new Set(grantedTo);

  const grant = useMutation(setPluginGrantMutationOptions(queryClient));

  /* `on` is the current state, so a click asks for its opposite. */
  const toggle = (agentId: string, on: boolean) =>
    grant.mutate({ agentId, granted: !on, kind: "skill", ref: slug });

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Agents</h2>
      {mine.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          You do not own an Agent to put this on yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {mine.map((agent) => {
              const on = held.has(agent.id);
              return (
                <Button
                  disabled={grant.isPending}
                  key={agent.id}
                  onClick={() => toggle(agent.id, on)}
                  size="sm"
                  type="button"
                  /*
                   * The state is the fill, not a tick alone: a row of outline buttons where one
                   * carries a small mark reads as a list of choices rather than as a set of
                   * switches, and which are on has to survive a glance.
                   */
                  variant={on ? "default" : "outline"}
                >
                  {agent.name}
                </Button>
              );
            })}
          </div>
          <p className="text-muted-foreground text-xs">
            An Agent carrying this offers <code>/{slug}</code> in its composer.
          </p>
        </>
      )}
      {grant.error ? (
        <p className="text-destructive text-xs" role="alert">
          {grant.error.message}
        </p>
      ) : null}
    </div>
  );
}
