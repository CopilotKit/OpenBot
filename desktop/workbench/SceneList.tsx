import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconChevronRight, IconSearch, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Item } from "@/components/ui/item";
import { cn } from "@/lib/utils";
import { SCENE_GROUPS } from "./scenes/types";
import { isStringList, readPref, writePref } from "./viewerPrefs";

/** One row of the list: a desktop scene or an app scene. */
export type SceneListItem = { id: string; title: string; group: string };

/** What the page's keys do to the list. */
export type SceneListHandle = {
  /** "/": puts the focus in the filter field. */
  focusFilter(): void;
  /** ↑ and ↓: moves the keyboard cursor to the scene before or after it. */
  move(delta: 1 | -1): void;
  /** Enter: opens the scene under the cursor. False when the cursor is on the current view. */
  pickCursor(): boolean;
};

export type SceneListProps = {
  scenes: readonly SceneListItem[];
  current: string;
  onPick(id: string): void;
  /** The group order. Default: SCENE_GROUPS. */
  groups?: readonly string[];
  handle?: Ref<SceneListHandle>;
};

const OTHER_GROUP = "Other";
/** Where the folded groups are kept, for this viewer. */
export const COLLAPSED_PREF = "collapsedGroups";

/** The DOM id of a scene row, for aria-activedescendant. */
export function sceneRowId(id: string): string {
  return `wb-scene-${id.replace(/[^\w-]/g, "_")}`;
}

/** True when the scene matches the filter: by its title, its id or its group. */
export function sceneMatches(scene: SceneListItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  return [scene.title, scene.id, scene.group].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

export function SceneList({
  scenes,
  current,
  onPick,
  groups = SCENE_GROUPS,
  handle,
}: SceneListProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(readPref(COLLAPSED_PREF, isStringList) ?? []),
  );
  const [cursor, setCursor] = useState(current);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const sections = useMemo(() => {
    const known = new Set(groups);
    const all = groups.map((group) => ({
      group,
      items: scenes.filter((scene) => scene.group === group),
    }));
    all.push({
      group: OTHER_GROUP,
      items: scenes.filter((scene) => !known.has(scene.group)),
    });
    return all.filter((section) => section.items.length > 0);
  }, [scenes, groups]);

  const currentGroup = sections.find((s) =>
    s.items.some((scene) => scene.id === current),
  )?.group;
  const filtering = filter.trim() !== "";
  const shown = sections
    .map(({ group, items }) => {
      const matches = filtering
        ? items.filter(
            (scene) =>
              sceneMatches(scene, filter) ||
              group.toLowerCase().includes(filter.trim().toLowerCase()),
          )
        : items;
      // A filter opens every group that has a match; the current view's group is always open.
      const open = filtering || group === currentGroup || !collapsed.has(group);
      return { group, items: matches, total: items.length, open };
    })
    .filter((section) => section.items.length > 0);
  const visible = shown.flatMap((s) =>
    s.open ? s.items.map((i) => i.id) : [],
  );
  const visibleKey = visible.join("\n");

  // The cursor follows the current view, and stays on a row that shows.
  useEffect(() => {
    setCursor(current);
  }, [current]);
  // With a filter, the cursor goes to the first match; without one, back to the current view.
  useEffect(() => {
    const ids = visibleKey === "" ? [] : visibleKey.split("\n");
    if (!filtering && ids.includes(currentRef.current)) {
      setCursor(currentRef.current);
      return;
    }
    setCursor((c) => (ids.includes(c) ? c : (ids[0] ?? c)));
  }, [visibleKey, filtering]);

  // The current view is in view when the page opens and after each pick.
  useEffect(() => {
    document
      .getElementById(sceneRowId(current))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  useEffect(() => {
    document
      .getElementById(sceneRowId(cursor))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const currentRef = useRef(current);
  currentRef.current = current;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const move = (delta: 1 | -1) => {
    const ids = visibleRef.current;
    if (ids.length === 0) return;
    const at = ids.indexOf(cursorRef.current);
    const next =
      at === -1
        ? delta === 1
          ? 0
          : ids.length - 1
        : Math.max(0, Math.min(ids.length - 1, at + delta));
    const id = ids[next];
    if (id === undefined) return;
    cursorRef.current = id;
    setCursor(id);
  };
  const pickCursor = () => {
    const id = cursorRef.current;
    if (id === currentRef.current || !visibleRef.current.includes(id))
      return false;
    onPickRef.current(id);
    return true;
  };

  useImperativeHandle(handle, () => ({
    focusFilter: () => {
      filterRef.current?.focus();
      filterRef.current?.select();
    },
    move,
    pickCursor,
  }));

  const store = (next: ReadonlySet<string>) => {
    setCollapsed(next);
    writePref(COLLAPSED_PREF, next.size === 0 ? null : [...next]);
  };
  const toggle = (group: string) => {
    const next = new Set(collapsed);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    store(next);
  };
  const allFolded = sections.every(
    (s) => s.group === currentGroup || collapsed.has(s.group),
  );

  return (
    <nav aria-label="Views" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <h2 className="text-sm font-medium">Views</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            store(allFolded ? new Set() : new Set(sections.map((s) => s.group)))
          }
        >
          {allFolded ? "Expand all" : "Collapse all"}
        </Button>
      </div>
      <InputGroup className="h-8">
        <InputGroupAddon>
          <IconSearch aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={filterRef}
          type="search"
          aria-label="Filter views"
          placeholder="Filter views"
          aria-keyshortcuts="/"
          aria-controls="wb-scene-rows"
          aria-activedescendant={
            visible.includes(cursor) ? sceneRowId(cursor) : undefined
          }
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              pickCursor();
            } else if (event.key === "Escape") {
              if (filter !== "") setFilter("");
              else event.currentTarget.blur();
            }
          }}
        />
        {filter !== "" && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear the filter"
              onClick={() => {
                setFilter("");
                filterRef.current?.focus();
              }}
            >
              <IconX aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <div id="wb-scene-rows" className="flex flex-col gap-2">
        {shown.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted-foreground">{`No view matches “${filter.trim()}”.`}</p>
        )}
        {shown.map(({ group, items, total, open }) => {
          const pinned = !filtering && group === currentGroup;
          return (
            <Collapsible
              key={group}
              open={open}
              onOpenChange={() => {
                if (!pinned && !filtering) toggle(group);
              }}
              render={<section />}
            >
              <h3>
                <CollapsibleTrigger
                  className="group/trigger flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:cursor-default after:ml-auto after:font-mono after:tabular-nums after:content-[attr(data-count)]"
                  aria-disabled={pinned || filtering ? true : undefined}
                  data-count={filtering ? `${items.length}/${total}` : total}
                  title={
                    pinned
                      ? "The group of the current view stays open."
                      : undefined
                  }
                >
                  <IconChevronRight
                    aria-hidden="true"
                    className="size-3 shrink-0 transition-transform duration-150 group-aria-expanded/trigger:rotate-90 motion-reduce:transition-none"
                  />
                  {group}
                </CollapsibleTrigger>
              </h3>
              <CollapsibleContent className="flex flex-col gap-px pt-0.5">
                {items.map((scene) => {
                  const isCurrent = scene.id === current;
                  return (
                    <Item
                      key={scene.id}
                      size="xs"
                      id={sceneRowId(scene.id)}
                      // A long title ends in an ellipsis: the tooltip has all of it, and the id for links and the CLI.
                      title={`${scene.title} (${scene.id})`}
                      aria-current={isCurrent ? "true" : undefined}
                      data-scene={scene.id}
                      data-current={isCurrent ? "" : undefined}
                      data-cursor={
                        scene.id === cursor && !isCurrent ? "" : undefined
                      }
                      className={cn(
                        "block h-7 truncate py-1 text-left font-normal data-cursor:inset-ring data-cursor:inset-ring-ring",
                        isCurrent && "bg-muted font-medium",
                      )}
                      render={<Button variant="ghost" size="sm" />}
                      onClick={() => onPick(scene.id)}
                    >
                      {scene.title}
                    </Item>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </nav>
  );
}
