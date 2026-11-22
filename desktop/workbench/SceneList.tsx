import { SCENE_GROUPS, type Scene } from "./scenes/types";

export type SceneListProps = {
  scenes: readonly Scene[];
  current: string;
  onPick(id: string): void;
};

export function SceneList({ scenes, current, onPick }: SceneListProps) {
  return (
    <nav aria-label="Scenes">
      <h2>Scenes</h2>
      {SCENE_GROUPS.map((group) => {
        const inGroup = scenes.filter((scene) => scene.group === group);
        if (inGroup.length === 0) return null;
        return (
          <section key={group}>
            <h3>{group}</h3>
            {inGroup.map((scene) => {
              const isCurrent = scene.id === current;
              return (
                <button
                  key={scene.id}
                  type="button"
                  title={scene.id}
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
