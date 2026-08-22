import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Which tools this skill says it needs.
 *
 * WHY IT MATTERS THAT THIS EXISTS AT ALL. Selection is over skills: before a run the deployment asks
 * its own model which skills the message needs, and the Bot is built with those skills' tools plus
 * every granted tool no skill claims. A deployment where no skill declares anything has nothing to
 * select on, so every Bot is offered its whole catalogue — which is the case the narrowing was built
 * to fix. Until this screen existed the only way to declare a tool was to call the API by hand.
 *
 * A DECLARATION IS NOT A GRANT, and this is the one thing the screen has to get across. Anybody
 * signed in may write a skill; adding an MCP server is an administrator's decision. If naming a tool
 * here made it callable, the first surface would be a way around the second. It does not: the offer
 * is intersected with what the Bot was granted, so a skill naming a tool its Bot does not hold
 * selects the skill and loads nothing. Said in the hint rather than left for somebody to discover,
 * because the failure it prevents is somebody ticking boxes expecting access.
 *
 * PART OF THE FORM, unlike the Agents toggles below it. What a skill needs is the author's draft
 * until they press save, so unticking one and closing the panel changes nothing. Granting is the
 * opposite and saves on press, which is why the two look different on purpose.
 */
export function SkillTools({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (refs: string[]) => void;
}) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const held = new Set(selected);

  const toggle = (ref: string) => {
    /*
     * Rebuilt rather than mutated, and filtered rather than spliced, so the array handed to the form
     * is a new one. React Form compares by reference; mutating in place leaves the field's value
     * looking unchanged and the submit button disabled on a form the person has edited.
     */
    onChange(
      held.has(ref)
        ? selected.filter((each) => each !== ref)
        : [...selected, ref],
    );
  };

  /*
   * Only servers that actually offer something. A server whose tools have never been refreshed has
   * an empty list, and a heading with nothing under it reads as a tool that failed to draw.
   */
  const servers = (plugins.data?.servers ?? []).filter(
    (server) => server.tools.length > 0,
  );

  return (
    <Field>
      <FieldLabel>Tools it needs</FieldLabel>

      {plugins.isPending ? null : plugins.error ? (
        <p className="text-destructive text-xs" role="alert">
          Could not load the tools this deployment has.
        </p>
      ) : servers.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No connected server offers a tool yet. A skill can still be written —
          most are instructions rather than tool use.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {servers.map((server) => (
            <div className="flex flex-col gap-1.5" key={server.id}>
              <p className="text-muted-foreground text-xs">{server.title}</p>
              <div className="flex flex-wrap gap-2">
                {server.tools.map((tool) => {
                  const on = held.has(tool.ref);
                  return (
                    <Button
                      key={tool.ref}
                      onClick={() => toggle(tool.ref)}
                      size="sm"
                      /*
                       * The vendor's own tool name, not the namespaced one a model sees. The person
                       * reading this is matching it against the vendor's documentation.
                       */
                      title={tool.description}
                      type="button"
                      variant={on ? "default" : "outline"}
                    >
                      {tool.name}
                      {/*
                       * Writes are marked. Which tools a skill pulls in is a governance question, and
                       * "this one changes something at the vendor" is the part worth seeing before
                       * ticking it rather than after.
                       */}
                      {tool.effect === "write" ? (
                        <span
                          aria-label="changes something"
                          className="ml-1 opacity-60"
                          role="img"
                        >
                          ✎
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Picking this skill is what loads these tools for a turn. It does not
        grant them — a Bot still only calls what it was granted, so naming a
        tool here gives nobody access to it.
      </p>
    </Field>
  );
}
