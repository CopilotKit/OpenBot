import { RESEARCH_ROLES } from "@openbot/shared/research";
import { IconChevronRight, IconPlugOff, IconWorld } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { PluginLogo } from "@/components/plugins/plugin-logo";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { undeclaredElsewhere } from "@/lib/skills/form";

/**
 * Which tools this skill says it needs.
 *
 * WHY IT MATTERS THAT THIS EXISTS AT ALL. Selection is over skills: before a run the deployment asks
 * its own model which skills the message needs, and the Bot is built with those skills' tools plus
 * every granted tool no skill claims. A deployment where no skill declares anything has nothing to
 * select on, so every Bot is offered its whole catalogue, which is the case the narrowing was built
 * to fix.
 *
 * A DECLARATION IS NOT A GRANT, and this is the one thing the screen has to get across. Anybody
 * signed in may write a skill; adding an MCP server is an administrator's decision. Naming a tool
 * here does not make it callable: the offer is intersected with what the Bot was granted. Said in the
 * section's description, because the failure it prevents is somebody ticking boxes expecting access.
 *
 * ONE ROW PER APP, AND A DIALOG FOR ITS TOOLS. The picker used to be a wrap of buttons per app, one
 * per tool, named in snake case with a pencil glyph on writes. At a dozen tools it read as noise,
 * and which ones were on did not survive a glance. A set of choices is a summary, a chevron and a
 * dialog in the layout skill's vocabulary, which is what each app's row is now.
 *
 * PART OF THE FORM, unlike granting. What a skill needs is the author's draft until they press save,
 * so the dialog changes the form's value and nothing else.
 */

/** One group of choices: an app, web research, or refs no app here offers. */
type ToolGroup = {
  key: string;
  title: string;
  media: ReactNode;
  tools: {
    ref: string;
    title: string;
    /** The vendor's own name, which is what its documentation calls it. */
    name?: string;
    description: string;
    writes: boolean;
  }[];
  /** Refs no app here offers: shown so they can be removed, never offered for adding. */
  unavailable?: boolean;
};

/** `create_routine` → "Create routine". The raw name stays on the row's tooltip. */
function toolTitle(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : name;
}

/**
 * A tool's description is written for the model and often runs to a paragraph. Its first sentence
 * is what a person needs to tell the tools apart.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

function summary(held: number, total: number, unavailable?: boolean): string {
  if (unavailable) return held === 1 ? "1 tool" : `${held} tools`;
  if (held === 0) return "None";
  if (held === total) return total === 1 ? "1 tool" : `All ${total} tools`;
  return `${held} of ${total} tools`;
}

export function SkillTools({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (refs: string[]) => void;
}) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const [open, setOpen] = useState<string | null>(null);
  const held = new Set(selected);

  const toggle = (ref: string, on: boolean) => {
    /*
     * Rebuilt rather than mutated, so the array handed to the form is a new one. React Form compares
     * by reference; mutating in place leaves the field looking unchanged and Save disabled.
     */
    onChange(
      on
        ? [...selected.filter((each) => each !== ref), ref]
        : selected.filter((each) => each !== ref),
    );
  };

  if (plugins.isPending) return null;
  if (!plugins.data) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        Couldn't load the tools. Reload the page.
      </p>
    );
  }

  /* Only apps that offer something: a heading with nothing under it reads as a failed draw. */
  const servers = plugins.data.servers.filter(
    (server) => server.tools.length > 0,
  );
  /*
   * Declared, and offered by nothing connected here. Shown rather than dropped: a package ships
   * skills declaring tools for apps nobody has added yet, and leaving them out would state part of
   * the declaration as if it were all of it.
   */
  const elsewhere = undeclaredElsewhere(
    selected,
    servers.flatMap((server) => server.tools.map((tool) => tool.ref)),
  );

  const groups: ToolGroup[] = [
    ...servers.map((server) => ({
      key: server.id,
      title: server.title,
      media: <PluginLogo logo={server.logo} name={server.title} />,
      tools: server.tools.map((tool) => ({
        ref: tool.ref,
        title: toolTitle(tool.name),
        name: tool.name,
        description: firstSentence(tool.description) || tool.name,
        writes: tool.effect === "write",
      })),
    })),
    {
      key: "research",
      title: "Web research",
      media: <IconWorld />,
      tools: RESEARCH_ROLES.map((role) => ({
        ref: role.ref,
        title: role.label,
        description: "Uses whichever research app the Bot has.",
        writes: false,
      })),
    },
    ...(elsewhere.length > 0
      ? [
          {
            key: "elsewhere",
            title: "Not available here",
            media: <IconPlugOff />,
            unavailable: true,
            tools: elsewhere.map((ref) => ({
              ref,
              title: ref,
              description: "No app here offers this.",
              writes: false,
            })),
          },
        ]
      : []),
  ];
  const current = groups.find((group) => group.key === open);

  return (
    <>
      <PageRows>
        {groups.map((group, index) => {
          const count = group.tools.filter((tool) => held.has(tool.ref)).length;
          return (
            <div key={group.key}>
              {/* A real button with no children: children passed to `render` replace the row's own. */}
              <Item
                render={
                  <button onClick={() => setOpen(group.key)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">{group.media}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{group.title}</ItemTitle>
                  <ItemDescription>
                    {group.unavailable
                      ? "This skill asks for these, but no app here offers them."
                      : count > 0
                        ? group.tools
                            .filter((tool) => held.has(tool.ref))
                            .map((tool) => tool.title)
                            .join(", ")
                        : group.tools.length === 1
                          ? "1 tool"
                          : `${group.tools.length} tools`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {summary(count, group.tools.length, group.unavailable)}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
              {index !== groups.length - 1 && <Separator />}
            </div>
          );
        })}
      </PageRows>

      <Dialog
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        open={current !== undefined}
      >
        {current ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{current.title}</DialogTitle>
              <DialogDescription>
                {current.unavailable
                  ? "These do nothing until an admin adds the app. Untick one to remove it from the skill."
                  : "Using this skill loads the tools you tick for that reply."}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4 overflow-y-auto">
              <div className="flex flex-col gap-px">
                {current.tools.map((tool) => (
                  <Item
                    key={tool.ref}
                    size="sm"
                    title={tool.name}
                    variant="muted"
                  >
                    <ItemContent>
                      <ItemTitle>{tool.title}</ItemTitle>
                      <ItemDescription>{tool.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Writes are marked: "this one changes something at the vendor" is the part
                       * worth seeing before ticking it.
                       */}
                      {tool.writes ? (
                        <span className="text-amber-600 text-xs dark:text-amber-500">
                          changes things
                        </span>
                      ) : null}
                      <Checkbox
                        aria-label={`Use ${tool.title}`}
                        checked={held.has(tool.ref)}
                        onCheckedChange={(checked) =>
                          toggle(tool.ref, checked === true)
                        }
                      />
                    </ItemActions>
                  </Item>
                ))}
              </div>
            </DialogBody>
            <DialogFooter className="mt-4 justify-between">
              {current.unavailable ? (
                <span />
              ) : (
                <Button
                  onClick={() => {
                    const refs = current.tools.map((tool) => tool.ref);
                    const all = refs.every((ref) => held.has(ref));
                    onChange(
                      all
                        ? selected.filter((ref) => !refs.includes(ref))
                        : [
                            ...selected,
                            ...refs.filter((ref) => !held.has(ref)),
                          ],
                    );
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {current.tools.every((tool) => held.has(tool.ref))
                    ? "Clear all"
                    : "Select all"}
                </Button>
              )}
              <Button onClick={() => setOpen(null)} size="sm" type="button">
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
