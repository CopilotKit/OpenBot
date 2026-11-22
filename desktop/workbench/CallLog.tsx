import { useEffect, useState } from "react";
import type { NativeControl } from "../src/fakeNative/control";
import { formatTime } from "./RunControls";

export type CallLogProps = { control: NativeControl | null };

function showArgs(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return "";
  const json = JSON.stringify(args) ?? "";
  return json.length > 120 ? json.slice(0, 120) : json;
}

export function CallLog(props: CallLogProps) {
  const { control } = props;
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (control === null) return;
    return control.onChange(() => setVersion((version) => version + 1));
  }, [control]);

  const calls = control === null ? [] : [...control.calls()].reverse();

  return (
    <section>
      <h3>Calls</h3>
      {calls.length === 0 ? (
        <p>No calls yet.</p>
      ) : (
        <ul>
          {calls.map((call, index) => (
            <li
              data-testid="call"
              // biome-ignore lint/suspicious/noArrayIndexKey: calls have no other identity
              key={index}
            >
              <span>{formatTime(call.at)}</span> <code>{call.command}</code>{" "}
              <span>{showArgs(call.args)}</span>
              {!call.known && <em> Not in the registry</em>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
