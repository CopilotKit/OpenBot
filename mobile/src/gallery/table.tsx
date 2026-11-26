/**
 * showTable, as the web app's `gallery/table.tsx` draws it: a table that scrolls sideways, sorted by a
 * tap on a column's heading. While the call streams, a last row still short of cells holds its place
 * rather than the whole table waiting.
 */
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { cn } from "../components/cn";
import { Text } from "../components/text";
import { byPosition, readTable } from "./drawn";
import { Badge, FailedCard, GalleryFrame, plain, Quiet, str } from "./frame";

export function DataTable({
  args,
  arriving,
}: {
  args: Record<string, unknown>;
  arriving: boolean;
}) {
  const [sort, setSort] = useState<{ column: number; up: boolean } | null>(
    null,
  );
  const table = readTable(args, arriving);
  const title = str(args.title);
  if (table && "failed" in table) return <FailedCard title="Data table" />;
  if (!table)
    return (
      <GalleryFrame title={title || "Table"}>
        <Quiet>Waiting for the rest of the table…</Quiet>
      </GalleryFrame>
    );
  const { columns, rows, held } = table;
  const ordered = rows.map((cells, position) => ({ cells, position }));
  if (sort)
    ordered.sort((left, right) => {
      const a = left.cells[sort.column];
      const b = right.cells[sort.column];
      const order =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true });
      return (sort.up ? order : -order) || left.position - right.position;
    });
  return (
    <GalleryFrame
      title={title}
      caption={str(args.caption)}
      action={
        <Badge>{`${rows.length} ${rows.length === 1 ? "row" : "rows"}`}</Badge>
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="rounded-lg border border-border"
        accessibilityLabel={`${title ?? "Table"}, scroll for more columns`}
      >
        <View>
          <View className="flex-row border-border border-b bg-fill">
            {byPosition(columns).map(({ item, key }, index) => {
              const sorted = sort?.column === index;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort by ${item}${sorted ? (sort?.up ? ", ascending" : ", descending") : ""}`}
                  onPress={() =>
                    setSort({
                      column: index,
                      up: sorted ? !sort?.up : true,
                    })
                  }
                  className="w-36 flex-row items-center justify-between gap-2 px-3 py-2.5 active:opacity-60"
                >
                  <Text
                    variant="caption"
                    tone="muted"
                    numberOfLines={2}
                    className="flex-1 font-medium"
                  >
                    {item}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {sorted ? (sort?.up ? "↑" : "↓") : "↕"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {ordered.map((row, index) => (
            <View
              key={row.position}
              className={cn("flex-row", index > 0 && "border-border border-t")}
            >
              {byPosition(columns).map(({ key }, column) => {
                const cell = row.cells[column];
                return (
                  <View key={key} className="w-36 px-3 py-2.5">
                    <Text
                      selectable
                      className={cn(
                        "text-sm leading-5",
                        typeof cell === "number" && "text-right",
                      )}
                      tone={cell === "" ? "muted" : "default"}
                    >
                      {cell === "" ? "–" : plain(cell)}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
          {held ? (
            <View className="border-border border-t px-3 py-2.5">
              <Text tone="muted" className="text-sm">
                …
              </Text>
            </View>
          ) : null}
          {rows.length === 0 && !held ? (
            <View className="px-3 py-6">
              <Text tone="muted" className="text-sm">
                No rows to show.
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
      {rows.length > 1 ? (
        <Text variant="caption" tone="muted" className="mt-2">
          {sort
            ? `Sorted by ${columns[sort.column]}, ${sort.up ? "ascending" : "descending"}.`
            : "Tap a column heading to sort."}
        </Text>
      ) : null}
    </GalleryFrame>
  );
}
