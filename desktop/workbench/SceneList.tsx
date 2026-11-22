import { SCENE_GROUPS } from "./scenes/types";

/** One row of the list: a desktop scene or an app scene. */
export type SceneListItem = { id: string; title: string; group: string };

export type SceneListProps = {
  scenes: readonly SceneListItem[];
  current: string;
  onPick(id: string): void;
  /** The group order. Default: SCENE_GROUPS. */
  groups?: readonly string[];
};

const OTHER_GROUP = "Other";

export function SceneList({
  scenes,
  current,
  onPick,
  groups = SCENE_GROUPS,
}: SceneListProps) {
  const known = new Set(groups);
  const sections: { group: string; items: SceneListItem[] }[] = groups.map(
    (group) => ({
      group,
      items: scenes.filter((scene) => scene.group === group),
    }),
  );
  sections.push({
    group: OTHER_GROUP,
    items: scenes.filter((scene) => !known.has(scene.group)),
  });
  return (
    <nav aria-label="Scenes">
      <h2>Scenes</h2>
      {sections.map(({ group, items }) => {
        if (items.length === 0) return null;
        return (
          <section key={group}>
            <h3>{group}</h3>
            {items.map((scene) => {
              const isCurrent = scene.id === current;
              return (
                <button
                  key={scene.id}
                  type="button"
                  // A long title ends in an ellipsis: the tooltip has all of it, and the id for links and the CLI.
                  title={`${scene.title} (${scene.id})`}
                  aria-current={isCurrent ? "true" : undefined}
                  className={isCurrent ? "wb-scene-current" : undefined}
                  onClick={() => onPick(scene.id)}
                >
                  {scene.title}
                </button>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}
