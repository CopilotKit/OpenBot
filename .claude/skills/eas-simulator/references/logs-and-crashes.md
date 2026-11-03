# Device logs and crash reports (iOS)

When the user's app crashes, closes on launch, or misbehaves on an iOS session, read what the device recorded instead of guessing from screenshots. The session's preview server (serve-sim) keeps a shared buffer of the simulator's device log and collects the crash reports macOS writes for simulator apps, each with the app's own log lines from just before the crash.

This covers iOS sessions. Call `sim_api /crashes` first. If it returns `404 Not found`, the session's preview server predates these routes: fall back to `agent-device logs` (see [controllers.md](./controllers.md)) and tell the user crash reports aren't available on that session. Don't call `/logs` there, because older servers stream it without end.

## Reach the preview API

`simulator:get --json` returns `remoteConfig.previewApiUrl`, the preview server's API URL with the session token already in its query. Keep it in a shell variable and don't print it: the token grants control of the session. As with `simulator:exec`, run this from the Expo project directory. Pass `--id` with the session you are driving, because another agent can replace the dotenv session between your commands.

```bash
API=$(npx --yes eas-cli@latest simulator:get --json --id <session-id> | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let j;
    try { j = JSON.parse(s); } catch { console.error("simulator:get did not print JSON"); process.exit(1); }
    const url = j.remoteConfig?.previewApiUrl;
    if (j.status !== "IN_PROGRESS" || j.platform !== "IOS" || !url) {
      console.error(`no preview API (status ${j.status}, platform ${j.platform})`);
      process.exit(1);
    }
    process.stdout.write(url);
  });')

API_BASE="${API%%\?*}"; API_BASE="${API_BASE%/}"
case "$API" in *\?*) API_QUERY="${API#*\?}" ;; *) API_QUERY="" ;; esac
EVENTS="${TMPDIR:-/tmp}/eas-sim-crashes-${API_BASE##*//}"  # files for the log hold below

# sim_api <path> [extra query]: call a preview route, keeping the token query.
# printf is a shell builtin, so the URL goes to curl on stdin and stays out of `ps`.
sim_api() {
  : "${API_BASE:?no preview API}"
  printf 'url = "%s"\n' "$API_BASE$1?$API_QUERY${2:+&$2}" | curl -sS --fail-with-body --max-time 20 -K -
}
```

If your shell does not keep variables between commands, repeat these lines at the start of each command. Each repeat runs `simulator:get` again, which takes a few seconds, so put related reads in one command. Only call `/crashes`, `/crashes/<id>`, and `/logs`. Don't call `/api`: its response includes the exec token. Calls to the preview server do not reset the session's idle timer.

## Catch a crash with its log tail

The device log only runs while something holds it, so **start holding it before you reproduce the crash.** A crash that happens while nothing holds the log still gets a report, but its tail is empty. Hold it with a `/crashes` stream opened with `?tail=1`, which also writes each crash event to `$EVENTS.log`:

```bash
printf 'url = "%s"\n' "$API_BASE/crashes?$API_QUERY&tail=1" |
  curl -sSN --fail-with-body --max-time 300 -H 'Accept: text/event-stream' -K - > "$EVENTS.log" 2> "$EVENTS.err" &
echo $! > "$EVENTS.pid"
for i in $(seq 1 20); do
  grep -q '^data:' "$EVENTS.log" && break
  kill -0 "$(cat "$EVENTS.pid")" 2>/dev/null || break
  sleep 0.5
done
grep -q '^data:' "$EVENTS.log" && echo "log held" || cat "$EVENTS.err" "$EVENTS.log"

# ... reproduce the crash with agent-device (open the app, press through the flow) ...

grep -E '"type":"(crash|recurred)"' "$EVENTS.log"  # a crash event arrives a few seconds after the process dies
sim_api /crashes                                    # {meta, crashes}: one record per distinct crash
kill "$(cat "$EVENTS.pid")" 2>/dev/null; rm -f "$EVENTS.log" "$EVENTS.err" "$EVENTS.pid"
```

Reproduce only after `log held`. Otherwise the command prints the error: `401` means the session ended or its token changed, and `404` means the server predates these routes. `--max-time 300` ends the hold after 5 minutes even if nothing kills it; start it again for a longer run. Without the stream, call `sim_api /logs "snapshot=1&follow=1&limit=1"` more often than every 8 seconds: the log stops 8 seconds after its last reader.

Right after a session boots, the simulator writes many log lines for a minute or two, and a crash in that window can come back without its tail (`logTailSource` of `buffer-rolled-past` or `no-app-lines`, no lines). If that happens, reproduce again once logging settles; the new occurrence gets its tail.

An empty `crashes` array right after a crash means "not yet", not "nothing happened". `meta.reportDelaySeconds` estimates the delay, and `meta.status` says whether collection is running (`watching`) at all.

## Read a crash

```bash
sim_api "/crashes/<id>"                 # newest occurrence of that crash
sim_api "/crashes/<id>" "key=<key>"     # an occurrence, by a key from occurrenceTimes
```

The list gives one record per crash signature, with `signal`, `exceptionType`, `culpritFrame`, `bundleId`, `pid`, `count`, and `occurrenceTimes` (each retained occurrence's `key`, oldest first). Repeats of the same crash collapse into one record with a higher `count`.

The detail returns `{record, occurrence, report, reportError}`:

- `occurrence.frames` is that occurrence's stack. The first frame with `appOwned: true` is usually where to look in the user's code.
- `occurrence.logTail` holds the app's own device-log lines (NDJSON) from at or before the crash. `occurrence.logTailSource` says how it was chosen:
  - `app-windowed`: lines found.
  - `buffer-rolled-past`: the buffer no longer reached back that far, or nothing held the log when the crash happened.
  - `no-app-lines`: the window was there, but the app logged nothing.
  - `none`: nothing was buffered for the device, usually because nothing held the log. It is also `none` when the report has no timestamp or process name.
- `occurrence.appVersion`, `buildVersion`, and `faultingQueue` are per occurrence.
- `report` is the full `.ips` text. When it is `null`, `reportError` says why. The detail can be large, so print only the fields you need.

## Read the device log

```bash
sim_api /logs "snapshot=1&follow=1&limit=500"             # newest 500 lines, keep the log running
sim_api /logs "snapshot=1&follow=1&since=<latestSeq>"     # only lines after a previous read
```

The JSON has `lines` (`{seq, at, raw}`, where `raw` is one NDJSON log entry with `processImagePath`, `processID`, `eventMessage`, and `messageType`), `latestSeq`, `oldestSeq`, and `status` (`streaming`, `restarting`, or `stopped`). `streamError` keeps the last stream error, so it can be set while `status` is `streaming`. Keep `snapshot=1`: without it, `/logs` is an event stream that does not end. Without `follow=1`, `/logs` only reads what is already buffered, and `stopped` means nothing is holding the log. The first `follow=1` read after the log was idle can return no lines, so read again after a second or two.

To keep only the user's app, match `processImagePath` ending in the app's executable name (its `CFBundleExecutable`; app paths contain `/Containers/Bundle/Application/`), or `processID` for one launch.

A busy simulator can log hundreds of lines a second, and the buffer is capped at about 4 MB, so it may hold only seconds to minutes of history. Read right after the event you care about; if `since` is older than `oldestSeq`, those lines are gone.

## What the user sees

The same data is in the browser preview the user opens from `webPreviewUrl`: the device log in the Logs drawer (toolbar icon), and crashes in the Crashes section of the Tools panel, where each crash opens its stack, log tail, and `.ips`. Point the user there when they want to look for themselves.
