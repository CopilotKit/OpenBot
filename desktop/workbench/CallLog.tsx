import { useEffect, useState } from "react";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { NativeControl } from "../src/fakeNative/control";
import { formatTime } from "./formatTime";

export type CallLogProps = { control: NativeControl | null };

function showArgs(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return "";
  const json = JSON.stringify(args) ?? "";
  return json.length > 120 ? json.slice(0, 120) : json;
}

const HEAD = "h-8 px-1.5";
const CELL = "px-1.5 py-1";

export function CallLog(props: CallLogProps) {
  const { control } = props;
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (control === null) return;
    return control.onChange(() => setVersion((version) => version + 1));
  }, [control]);

  const calls = control === null ? [] : [...control.calls()].reverse();

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Calls</h3>
      {calls.length === 0 ? (
        <Empty className="p-3">
          <EmptyDescription>No calls yet.</EmptyDescription>
        </Empty>
      ) : (
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className={`${HEAD} w-10`}>Time</TableHead>
              <TableHead className={HEAD}>Command</TableHead>
              <TableHead className={HEAD}>Arguments</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((call, index) => (
              <TableRow
                data-testid="call"
                // biome-ignore lint/suspicious/noArrayIndexKey: calls have no other identity
                key={index}
              >
                <TableCell className={`${CELL} font-mono tabular-nums`}>
                  {formatTime(call.at)}
                </TableCell>
                <TableCell className={`${CELL} font-mono`}>
                  <code className="block truncate" title={call.command}>
                    {call.command}
                  </code>
                  {!call.known && (
                    <span className="block font-sans text-destructive">
                      Not in the registry
                    </span>
                  )}
                </TableCell>
                <TableCell
                  className={`${CELL} font-mono break-all text-muted-foreground`}
                >
                  {showArgs(call.args)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
