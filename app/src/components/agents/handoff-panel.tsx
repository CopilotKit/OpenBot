import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentListQueryOptions,
} from "@/lib/agents/queries";

/**
 * Which Bots this one may hand work to.
 *
 * On the Bot's own screen rather than in the connector catalogue: a catalogue entry has a fixed list
 * of tools somebody else maintains, and the Bots a deployment has are whatever was made here. It is
 * also the question a person asks while looking at a Bot, not while looking at a vendor.
 *
 * DIRECTIONAL, and said so on the screen, because the pair is the one thing about this that is easy
 * to get backwards: this is who this Bot may ask, not who may ask it.
 *
 * One Item per candidate, with a Switch: the grant is one boolean that takes effect when switched,
 * which is exactly the row kind a Switch means everywhere else in this app.
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const handoff = useQuery(agentHandoffQueryOptions(agentId));
  const agents = useQuery(agentListQueryOptions());
  const setGrant = useMutation(setHandoffGrantMutationOptions(queryClient));

  if (handoff.isPending || !handoff.data) return null;
  const { enabled, canGrant, reachable, grantable } = handoff.data;

  /*
   * A Bot may not be granted itself, and the server refuses it, so it is not offered here either.
   * Hidden Bots are already absent from this list.
   */
  const others = (agents.data ?? []).filter(
    (candidate) => candidate.id !== agentId,
  );
  const granted = others.filter((candidate) =>
    reachable.includes(candidate.id),
  ).length;
  /*
   * On a Bot that cannot be a grantee only the leftovers are shown: a stale grant may still be
   * revoked — taking away is always allowed — but offering switches that can only bounce off the
   * server's refusal is the thing the explanation item above replaces.
   */
  const candidates = grantable
    ? others
    : others.filter((candidate) => reachable.includes(candidate.id));

  // Nothing to say to somebody who cannot change it and has nothing to read.
  if (!canGrant && reachable.length === 0) return null;

  return (
    <section className="grid gap-2">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Bots it may ask
        </h2>
        {/* The current answer at a glance, so the list below is detail rather than homework. */}
        {grantable && others.length > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {granted} of {others.length}
          </span>
        ) : null}
      </header>

      <p className="text-muted-foreground text-sm">
        Who this Bot may ask, not who may ask it. What the asked Bot says comes
        back into the conversation that asked, relayed and attributed.
      </p>

      {enabled ? null : (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>Switched off for this deployment</ItemTitle>
            {/*
             * Unclamped: `ItemDescription` clips to two lines, which is right for a roster row
             * whose description is a subtitle and wrong for an item that exists to explain. The
             * sentence that gets cut is the one saying what to do about it.
             */}
            <ItemDescription className="line-clamp-none">
              These grants are kept but none takes effect until handing work
              between Bots is switched back on.
            </ItemDescription>
          </ItemContent>
        </Item>
      )}

      {grantable ? null : (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>This coworker cannot hand work on</ItemTitle>
            {/* Unclamped for the same reason as above: three lines, and the third is the useful one. */}
            <ItemDescription className="line-clamp-none">
              Handing work on is a tool that runs inside this deployment's own
              loop, and this coworker runs as its own agent — so there is
              nothing to grant it. It can still be asked by Bots that can.
            </ItemDescription>
          </ItemContent>
        </Item>
      )}

      {setGrant.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}

      {grantable && others.length === 0 ? (
        <Empty className="h-[180px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              No other Bot here yet
            </EmptyTitle>
            <EmptyDescription>
              When this deployment has more Bots, this is where this one is
              allowed to ask them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {candidates.length > 0 ? (
        <div className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <Item key={candidate.id} size="sm" variant="muted">
              <ItemMedia>
                <AbstractAvatar
                  image={candidate.avatarUrl}
                  name={candidate.name}
                  seed={candidate.avatarSeed}
                  size={28}
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{candidate.name}</ItemTitle>
                <ItemDescription>{candidate.title}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={`Let this Bot ask ${candidate.name}`}
                  checked={reachable.includes(candidate.id)}
                  disabled={!canGrant || setGrant.isPending}
                  onCheckedChange={(next: boolean) =>
                    setGrant.mutate({
                      agentId,
                      ref: candidate.id,
                      granted: next,
                    })
                  }
                />
              </ItemActions>
            </Item>
          ))}
        </div>
      ) : null}

      {canGrant ? null : (
        <p className="text-muted-foreground text-xs">
          An administrator decides which Bots may be asked.
        </p>
      )}
    </section>
  );
}
