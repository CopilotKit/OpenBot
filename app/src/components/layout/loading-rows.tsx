import { PageRows } from "@/components/layout/page-shell";
import { Item, ItemContent, ItemMedia } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const WIDTHS = ["w-40", "w-32", "w-48", "w-36", "w-44"] as const;

/**
 * The shape of a list that hasn't loaded yet: the same card of `Item` rows it will be, with bars
 * where the title and description go.
 *
 * Built from the real `PageRows` and `Item`, so each placeholder row is as tall as a loaded one and
 * nothing jumps when the rows arrive. Shown only for a first load: a list that has data keeps it
 * while it refetches.
 *
 * One status for the whole list, named by `label`, with every bar hidden from a screen reader. A
 * dozen empty shapes read aloud says nothing. The pulse stops for reduced motion.
 */
export function LoadingRows({
  label,
  rows = 3,
  media = "icon",
  className,
}: {
  /** What is loading, read once: "Loading your Bots". */
  label: string;
  rows?: number;
  /** The leading mark the loaded rows have: a 32px icon tile, or a round avatar. */
  media?: "icon" | "avatar" | "none";
  className?: string;
}) {
  return (
    <div aria-label={label} className={className} role="status">
      <PageRows>
        <div aria-hidden="true">
          {Array.from({ length: rows }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity of their own.
            <div key={index}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                {media === "none" ? null : (
                  <ItemMedia>
                    <Skeleton
                      className={cn(
                        "bg-muted motion-reduce:animate-none",
                        media === "avatar"
                          ? "size-7 rounded-full"
                          : "size-8 rounded-md",
                      )}
                    />
                  </ItemMedia>
                )}
                <ItemContent className="gap-1.5">
                  <Skeleton
                    className={cn(
                      "h-3.5 motion-reduce:animate-none",
                      WIDTHS[index % WIDTHS.length],
                    )}
                  />
                  <Skeleton className="h-3 w-3/5 max-w-64 motion-reduce:animate-none" />
                </ItemContent>
              </Item>
            </div>
          ))}
        </div>
      </PageRows>
    </div>
  );
}
