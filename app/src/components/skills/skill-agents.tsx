import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { pluginKeys } from "@/lib/plugins/queries";

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

  const toggle = useMutation({
    mutationFn: async ({ agentId, on }: { agentId: string; on: boolean }) => {
      const response = on
        ? await fetch(
            `/api/plugins/grants?kind=skill&ref=${encodeURIComponent(slug)}&agentId=${encodeURIComponent(agentId)}`,
            { method: "DELETE", credentials: "include" },
          )
        : await fetch("/api/plugins/grants", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "skill", ref: slug, agentId }),
          });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        // The server's sentence: it knows why it refused and this component does not.
        throw new Error(body?.error ?? "That Agent could not be changed.");
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });

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
                  disabled={toggle.isPending}
                  key={agent.id}
                  onClick={() => toggle.mutate({ agentId: agent.id, on })}
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
      {toggle.error ? (
        <p className="text-destructive text-xs" role="alert">
          {toggle.error.message}
        </p>
      ) : null}
    </div>
  );
}
