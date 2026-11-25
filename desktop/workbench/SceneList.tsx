import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import { cn } from "@/lib/utils";

export type SceneListItem = {
  id: string;
  title: string;
  group: "App" | "Setup";
};
export type SceneListProps = {
  scenes: readonly SceneListItem[];
  current: string;
  onPick(id: string): void;
};

/** Eleven starting points stay in view. Native buttons provide their keyboard navigation. */
export function SceneList({ scenes, current, onPick }: SceneListProps) {
  return (
    <nav aria-label="Views" className="flex flex-col gap-3">
      <h2 className="px-1 text-sm font-medium">Views</h2>
      {(["App", "Setup"] as const).map((group) => (
        <section key={group} className="flex flex-col gap-px">
          <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            {group}
          </h3>
          {scenes
            .filter((scene) => scene.group === group)
            .map((scene) => (
              <Item
                key={scene.id}
                size="xs"
                title={`${scene.title} (${scene.id})`}
                aria-current={scene.id === current ? "true" : undefined}
                data-scene={scene.id}
                data-current={scene.id === current ? "" : undefined}
                className={cn(
                  "block h-7 truncate py-1 text-left font-normal",
                  scene.id === current && "bg-muted font-medium",
                )}
                render={<Button variant="ghost" size="sm" />}
                onClick={() => onPick(scene.id)}
              >
                {scene.title}
              </Item>
            ))}
        </section>
      ))}
    </nav>
  );
}
