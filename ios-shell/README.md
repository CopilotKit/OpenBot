# iOS web view shell (experiment)

A tiny native iOS app whose whole UI is one `WKWebView` showing the hosted OpenBot web app at
https://my.open.bot. It exists to find out whether the web app works inside a web view on iOS:
CORS, cookies, storage, streaming, popups and permissions. It is not a product. The Expo app in
`mobile/` is unchanged.

## Run it on a Mac

```sh
brew install xcodegen
cd ios-shell
xcodegen
open OpenBotShell.xcodeproj
```

Pick an iPhone simulator and press Run. No signing is needed for the simulator.

To point the app at another server, open Product > Scheme > Edit Scheme > Run > Arguments and turn
on `OPENBOT_BASE_URL` (it is there, switched off, set to the local probe). The default comes from
the `OpenBotBaseURL` key in Info.plist, which `project.yml` sets to `https://my.open.bot`.
`http://localhost` and `http://127.0.0.1` load too (`NSAllowsLocalNetworking`).

## Diagnostics

Turn on `OPENBOT_SHELL_DIAGNOSTICS=1` in the same place (the UI tests always do). The app then:

- injects a script into every frame that reports `console.error`/`console.warn`, uncaught errors,
  unhandled promise rejections, CSP violations, and every `fetch` and `XMLHttpRequest` (method,
  URL, status, failure, page origin vs request origin, mode, credentials). A cross-origin fetch
  that rejects with `TypeError` is flagged `likelyCORS`;
- records every navigation, its HTTP status and security headers, popups, permission requests and
  load errors;
- after each page load, and 5 seconds later, records a snapshot of the page: URL, title, user
  agent, cookie names, storage and API availability, viewport meta, size, `env(safe-area-inset-*)`
  values and the first 600 characters of visible text; plus the cookie jar's names and attributes.

Each record is one JSON line in `Documents/diagnostics.jsonl` in the app's container and is also
logged with the prefix `OPENBOT_DIAG `. Cookie values, query string values, tokens and request or
response bodies are never recorded.

On a simulator: `cat "$(xcrun simctl get_app_container booted ai.openbot.shell data)/Documents/diagnostics.jsonl"`.

## The probe

`Probe/` is a static test page plus `serve.py`, a Python standard library server on two ports:
8765 plays the web app's origin and 8766 a different-origin API. The page checks cookies, CORS
(blocked, allowed with credentials, preflighted), a same-site cross-origin cookie, localStorage,
IndexedDB, server-sent events, a streaming fetch, the user agent, and shows a popup button, a
microphone button and a file input. `persist.html` checks that a cookie and a localStorage value
survive an app relaunch.

```sh
python3 ios-shell/Probe/serve.py
```

Then open http://127.0.0.1:8765/ in the shell (set `OPENBOT_BASE_URL`) or in any browser to
compare. The comment at the top of `serve.py` lists every endpoint.

## CI

`.github/workflows/ios-shell.yml` runs on pushes to `ios-webview-shell` that touch this folder,
and by hand. It generates the project, starts the probe, boots an iPhone simulator, runs the UI
tests, and uploads `ios-shell-<run id>` with screenshots, `diagnostics.jsonl`, the app's log and a
`SUMMARY.md`.
