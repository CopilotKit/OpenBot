import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
  /** Enter: opens the scene under the cursor. False when the cursor is on the current scene. */
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

function Chevron() {
  return (
    <svg
      className="wb-chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
      // A filter opens every group that has a match; the current scene's group is always open.
      const open = filtering || group === currentGroup || !collapsed.has(group);
      return { group, items: matches, total: items.length, open };
    })
    .filter((section) => section.items.length > 0);
  const visible = shown.flatMap((s) =>
    s.open ? s.items.map((i) => i.id) : [],
  );
  const visibleKey = visible.join("\n");

  // The cursor follows the current scene, and stays on a row that shows.
  useEffect(() => {
    setCursor(current);
  }, [current]);
  // With a filter, the cursor goes to the first match; without one, back to the current scene.
  useEffect(() => {
    const ids = visibleKey === "" ? [] : visibleKey.split("\n");
    if (!filtering && ids.includes(currentRef.current)) {
      setCursor(currentRef.current);
      return;
    }
    setCursor((c) => (ids.includes(c) ? c : (ids[0] ?? c)));
  }, [visibleKey, filtering]);

  // The current scene is in view when the page opens and after each pick.
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
    <nav aria-label="Scenes" className="wb-scenes">
      <div className="wb-scenes-head">
        <h2>Scenes</h2>
        <button
          type="button"
          className="wb-link-button"
          onClick={() =>
            store(allFolded ? new Set() : new Set(sections.map((s) => s.group)))
          }
        >
          {allFolded ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <input
        ref={filterRef}
        type="search"
        className="wb-scene-filter"
        aria-label="Filter scenes"
        placeholder="Filter scenes"
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
      <div id="wb-scene-rows">
        {shown.length === 0 && (
          <p className="wb-empty">{`No scene matches “${filter.trim()}”.`}</p>
        )}
        {shown.map(({ group, items, total, open }) => {
          const pinned = !filtering && group === currentGroup;
          return (
            <section key={group}>
              <h3>
                <button
                  type="button"
                  className="wb-group-toggle"
                  aria-expanded={open}
                  aria-disabled={pinned || filtering ? true : undefined}
                  data-count={filtering ? `${items.length}/${total}` : total}
                  title={
                    pinned
                      ? "The group of the current scene stays open."
                      : undefined
                  }
                  onClick={() => {
                    if (!pinned && !filtering) toggle(group);
                  }}
                >
                  <Chevron />
                  {group}
                </button>
              </h3>
              {open &&
                items.map((scene) => {
                  const isCurrent = scene.id === current;
                  const classes = [
                    "wb-scene",
                    isCurrent ? "wb-scene-current" : "",
                    scene.id === cursor && !isCurrent ? "wb-scene-cursor" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      key={scene.id}
                      id={sceneRowId(scene.id)}
                      type="button"
                      // A long title ends in an ellipsis: the tooltip has all of it, and the id for links and the CLI.
                      title={`${scene.title} (${scene.id})`}
                      aria-current={isCurrent ? "true" : undefined}
                      className={classes}
                      onClick={() => onPick(scene.id)}
                    >
                      {scene.title}
                    </button>
                  );
                })}
            </section>
          );
        })}
      </div>
    </nav>
  );
}
