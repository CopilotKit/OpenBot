import { useEffect, useState } from "react";
import type { ApiControl, ApiRecord, ApiRoute, ApiSource } from "./appContract";
import { formatTime } from "./RunControls";
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
        <p>No window is loaded.</p>
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
    <section>
      <input
        type="search"
        aria-label="Filter"
        placeholder="Filter requests"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {records.length === 0 ? (
        <p>No requests yet.</p>
      ) : (
        <ul className="wb-req-list">
          {records.map((record) => (
            <li
              key={record.id}
              data-testid="request"
              title={`${record.method} ${record.path}`}
              className={
                record.source === "none" ? "wb-request-missing" : undefined
              }
            >
              <div className="wb-req-line">
                <span className="wb-time">{formatTime(record.at)}</span>
                <span className="wb-req-method">{record.method}</span>
                <code className="wb-req-route">{shortPath(record.path)}</code>
                <span className="wb-req-status">{statusText(record)}</span>
              </div>
              <div className="wb-req-meta">
                <em>{SOURCE_WORDS[record.source]}</em>
                {onPick && (
                  <button
                    type="button"
                    className="wb-link-button"
                    onClick={() => onPick(routeOf(record))}
                  >
                    Answer this
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
