import { IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ApiControl, ApiRecord, ApiRoute, ApiSource } from "./appContract";
import { formatTime } from "./formatTime";
import { shortPath } from "./routeText";

export type RequestLogProps = {
  api: ApiControl | null;
  onPick?(route: ApiRoute): void;
};

const SOURCE_WORDS: Record<ApiSource, string> = {
  answer: "Scene answer",
  stream: "Stream",
  extra: "Extra",
  spec: "Spec example",
  none: "No answer",
};

function statusText(record: ApiRecord): string {
  if (record.status !== null) return String(record.status);
  return record.state === "failed" ? "Failed" : "Waiting";
}

/** The route of a request without its query string, for the API answers panel. */
function routeOf(record: ApiRecord): ApiRoute {
  const pathname = record.path.split("?")[0] ?? record.path;
  return `${record.method.toUpperCase()} ${pathname}` as ApiRoute;
}

/** A sentence for an empty log. */
function Nothing({ children }: { children: string }) {
  return (
    <Empty className="p-3">
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

const HEAD = "h-8 px-1.5";
const CELL = "px-1.5 py-1";

/** Lists the requests of the app frame to `/api`, newest first. */
export function RequestLog(props: RequestLogProps) {
  const { api, onPick } = props;
  const [, setVersion] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (api === null) return;
    return api.onChange(() => setVersion((version) => version + 1));
  }, [api]);

  if (api === null) {
    return (
      <section>
        <Nothing>No window is loaded.</Nothing>
      </section>
    );
  }

  const needle = filter.toLowerCase();
  const records = [...api.requests()]
    .reverse()
    .filter((record) =>
      `${record.method} ${record.path}`.toLowerCase().includes(needle),
    );

  return (
    <section className="flex flex-col gap-2">
      <InputGroup>
        <InputGroupAddon>
          <IconSearch aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Filter"
          placeholder="Filter requests"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </InputGroup>
      {records.length === 0 ? (
        <Nothing>No requests yet.</Nothing>
      ) : (
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className={`${HEAD} w-10`}>Time</TableHead>
              <TableHead className={HEAD}>Request</TableHead>
              <TableHead className={`${HEAD} w-14 text-right`}>
                Status
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <TableRow
                key={record.id}
                data-testid="request"
                data-source={record.source}
                title={`${record.method} ${record.path}`}
              >
                <TableCell className={`${CELL} font-mono tabular-nums`}>
                  {formatTime(record.at)}
                </TableCell>
                <TableCell className={CELL}>
                  <span className="flex gap-2 font-mono">
                    <span className="font-medium">{record.method}</span>
                    <code className="truncate">{shortPath(record.path)}</code>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span
                      className={
                        record.source === "none"
                          ? "whitespace-nowrap text-destructive"
                          : "whitespace-nowrap text-muted-foreground"
                      }
                    >
                      {SOURCE_WORDS[record.source]}
                    </span>
                    {onPick && (
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto px-0"
                        onClick={() => onPick(routeOf(record))}
                      >
                        Answer this
                      </Button>
                    )}
                  </span>
                </TableCell>
                <TableCell
                  className={`${CELL} text-right font-mono tabular-nums`}
                >
                  {statusText(record)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
