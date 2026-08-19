import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  callRoutines,
  routineKeys,
  routineListQueryOptions,
  type WebhookTrigger,
  webhookTriggerQueryOptions,
} from "@/lib/routines/queries";

/**
 * The one door in this product that opens to somebody who has not signed in.
 *
 * The page is arranged around that. The secret is shown once, in a box that says so; a new trigger
 * is drawn as unfinished until somebody has looked at a real delivery and confirmed it; and the
 * endpoint's own port is stated rather than assumed, because it is not the port the rest of the API
 * is on and a person copying a URL out of here needs to know that.
 */
export const Route = createFileRoute("/_authed/admin/webhooks")({
  component: WebhooksPage,
});

function WebhooksPage() {
  const queryClient = useQueryClient();
  const triggers = useQuery(webhookTriggerQueryOptions());
  const routines = useQuery(routineListQueryOptions());
  const [error, setError] = useState<string | null>(null);
  /**
   * The secret, held only in this tab and only until the page is left.
   *
   * Never read back from the server, because the server does not have it: the row keeps a hash. This
   * is the one moment it exists anywhere but in the caller's own configuration.
   */
  const [revealed, setRevealed] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [routineId, setRoutineId] = useState("");

  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onError: (caught: Error) => setError(caught.message),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
    },
  });

  const rows = triggers.data ?? [];
  const available = routines.data ?? [];

  return (
    <PageShell
      description={
        <>
          A trigger is a URL another system can call to set a Bot working. It is
          served on its own port, not on this one, and every delivery is
          recorded in{" "}
          <Link className="underline" to="/admin/audit">
            Audit
          </Link>
          , including the ones that were refused.
        </>
      }
      title="Webhook triggers"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {revealed ? (
        <PageSection title="The secret, this once">
          <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <p className="text-sm">
              Copy this into whatever will be calling the endpoint. It is not
              stored, cannot be shown again, and leaving this page loses it. If
              that happens, rotate the trigger and use the new one.
            </p>
            <code className="mt-3 block break-all rounded bg-background p-2 font-mono text-xs">
              Authorization: Bearer {revealed.secret}
            </code>
            <Button
              className="mt-3"
              onClick={() => setRevealed(null)}
              size="sm"
              variant="outline"
            >
              I have copied it
            </Button>
          </div>
        </PageSection>
      ) : null}

      <PageSection title="New trigger">
        <form
          className="mt-4 rounded-lg border border-border bg-card p-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            act.mutate(async () => {
              const created = (await callRoutines("/triggers", {
                method: "POST",
                body: JSON.stringify({ name, routineId }),
              })) as { trigger: WebhookTrigger; secret: string };
              setRevealed({
                id: created.trigger.id,
                secret: created.secret,
              });
              setName("");
              return created;
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="trigger-name">Name</FieldLabel>
              <Input
                id="trigger-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Build finished"
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="trigger-routine">Runs</FieldLabel>
              <select
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                id="trigger-routine"
                onChange={(event) => setRoutineId(event.target.value)}
                value={routineId}
              >
                <option value="">Choose a routine…</option>
                {available.map((routine) => (
                  <option key={routine.id} value={routine.id}>
                    {routine.name}
                  </option>
                ))}
              </select>
              <FieldDescription>
                {/*
                 * Routine-backed only from this form. A trigger that names a routine gets that
                 * routine's run history and its one-at-a-time protection; one carrying a loose
                 * prompt gets neither, and offering the weaker shape as the easy option here would
                 * be a poor default.
                 */}
                The delivery is put underneath the routine's own instruction, so
                the Bot sees what arrived.
              </FieldDescription>
            </Field>
            <div>
              <Button
                disabled={!name.trim() || !routineId || act.isPending}
                size="sm"
                type="submit"
              >
                Create trigger
              </Button>
            </div>
          </FieldGroup>
        </form>
      </PageSection>

      <PageSection title="Triggers">
        {triggers.isPending ? (
          <PageEmpty>Loading…</PageEmpty>
        ) : rows.length === 0 ? (
          <PageEmpty>
            None yet. A trigger is how another system asks a Bot to do
            something.
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((trigger, index) => (
              <StaggerItem index={index} key={trigger.id}>
                <TriggerRow
                  busy={act.isPending}
                  onConfirm={() =>
                    act.mutate(() =>
                      callRoutines(`/triggers/${trigger.id}/verify`, {
                        method: "POST",
                      }),
                    )
                  }
                  onDelete={() =>
                    act.mutate(() =>
                      callRoutines(`/triggers/${trigger.id}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                  onRotate={() =>
                    act.mutate(async () => {
                      const rotated = (await callRoutines(
                        `/triggers/${trigger.id}/rotate`,
                        { method: "POST" },
                      )) as { secret: string };
                      setRevealed({ id: trigger.id, secret: rotated.secret });
                      return rotated;
                    })
                  }
                  onToggle={() =>
                    act.mutate(() =>
                      callRoutines(`/triggers/${trigger.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: !trigger.enabled }),
                      }),
                    )
                  }
                  trigger={trigger}
                />
                {index !== rows.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

function TriggerRow({
  trigger,
  busy,
  onConfirm,
  onRotate,
  onToggle,
  onDelete,
}: {
  trigger: WebhookTrigger;
  busy: boolean;
  onConfirm: () => void;
  onRotate: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="px-4 py-3">
      <Item className="p-0" size="sm">
        <ItemContent>
          <ItemTitle>
            {trigger.name}
            {!trigger.enabled ? (
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                off
              </span>
            ) : null}
          </ItemTitle>
          <ItemDescription>
            {/*
             * The path, not a full URL. This page has no way of knowing the address the endpoint is
             * reachable at from outside — it is a different port and usually behind something — and
             * printing this page's own origin with the webhook path on it would be a URL that does
             * not work, which is worse than a path somebody has to complete.
             */}
            <code className="font-mono text-xs">
              POST /hooks/{trigger.endpointId}
            </code>
            {" · "}
            {trigger.deliveryCount === 0
              ? "never called"
              : `${trigger.deliveryCount} ${trigger.deliveryCount === 1 ? "delivery" : "deliveries"}`}
            {trigger.eventTypes.length > 0
              ? ` · only ${trigger.eventTypes.join(", ")}`
              : null}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            disabled={busy}
            onClick={onRotate}
            size="sm"
            variant="outline"
          >
            New secret
          </Button>
          <Button disabled={busy} onClick={onToggle} size="sm" variant="ghost">
            {trigger.enabled ? "Turn off" : "Turn on"}
          </Button>
          <Button disabled={busy} onClick={onDelete} size="sm" variant="ghost">
            Delete
          </Button>
        </ItemActions>
      </Item>

      {trigger.verificationPending ? (
        <div className="mt-3 rounded-md border border-border bg-background p-3">
          {/*
           * The gate that catches a hook pointed at the wrong trigger. Until somebody has looked at
           * a real delivery and said yes, this endpoint accepts calls and starts nothing.
           */}
          <p className="text-sm">
            {trigger.sample
              ? "This is what actually arrived. Look at it, then confirm: nothing has run yet."
              : "Nothing has arrived yet. Send one delivery to the endpoint above; it will be kept here and nothing will run."}
          </p>
          {trigger.sample ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-card p-2 text-xs">
              {JSON.stringify(trigger.sample, null, 2)}
            </pre>
          ) : null}
          <Button
            className="mt-3"
            disabled={busy || !trigger.sample}
            onClick={onConfirm}
            size="sm"
          >
            This is right, start running it
          </Button>
        </div>
      ) : null}
    </div>
  );
}
