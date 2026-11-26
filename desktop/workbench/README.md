# Workbench

Open the real web app or Desktop setup UI in a browser, without building an installer:

```sh
cd desktop
bun run desktop-workbench
```

The page starts on Home. Eight app presets and three setup presets provide small starting points.
The App and Setup starting points stay visible; Tab and Enter or Space open a view.
Use the app's navigation, or enter a route and press Go. Back uses the real router history.
Reload restarts the view at the current route with the selected settings.

Change the viewport, zoom, OS, theme, host, role, skin and sidebar from the Window panel.
Fit scales the window to its available space; a fixed zoom lets the stage scroll. Resizing and
changing theme preserve the current interaction. Host, OS and session changes restart the frame.

The Setup preset is a first run you can click through, with the same build settings as a release
installer (OpenBot Cloud on). Pick OpenBot (Self-Contained) and press Install. Sign-in waits for
the browser: press Open the sign-in page to stand in for approving it there. Then accept the
agreement, and setup finishes after a few seconds. The fake for this is `#first-run` in
`src/fakeNative/states.ts`.

Select mode sets what the pointer does when Comment is off. Inspect outlines the element under the
pointer, with its size and the gaps to its neighbours. Off draws nothing over the app, so you can
just click through it. The workbench keeps your choice in this browser.

## Request changes

Press Comment (or C), then click an element or drag over an area. Write what should change and
copy the request. The prompt includes the picked elements, geometry, computed styles, React source
chains and a link containing the current route, viewport and native/API overrides.
The same box can request an Impeccable review. Critique this screen reviews the whole window.
Escape closes the selection. Text fields keep their normal typing and keyboard behavior.

Links reproduce the view's starting configuration and route. Transient interaction state, open
menus, typed text and in-flight requests are not replayed. Include those details in the comment
when they matter. The viewer uses normal browser timers and animations.

## Live warnings

The checks watch DOM changes, resizing, scrolling and the fake boundaries. Current warnings cover
movement, clipped text, overflow, simultaneous spinners, and intersection with macOS window controls.
Hover or focus a warning to highlight it; click to keep the highlight. The window stays interactive.
There is no timeline or historical findings page.

Advanced holds native answers, call and request logs, API overrides, native events, streams and
sockets. These controls affect only the fake boundary of that frame. Nothing contacts a real
OpenBot server.

## Capture a view

Copy a link, then capture its route and configuration:

```sh
bun run desktop-workbench:shot --url 'http://localhost:3021/workbench/?scene=app-home&route=%2Fconnections'
bun run desktop-workbench:shot app-home --route /settings --theme light --size 1000x800
```

The command writes a PNG and JSON report to `workbench-shots/` (`--out` changes the directory).
It opens one view on normal browser time. It does not replay actions or crawl the preset list.
The JSON includes the captured route, configuration, current warnings, elements and boundary logs.

## The rule

The shell reuses `app/src/components/ui` and the app theme. Frames render the actual app or setup
entry, generated MSW examples and Desktop page scripts. Workbench modules are excluded from
shipped app/desktop builds. The generic fake-native states remain available to production UI tests.

All Workbench checks are manual. No CI job runs its browser, unit or type checks.

```sh
# From desktop/
bun run typecheck:desktop-workbench
bun test workbench/urlState.test.ts workbench/CommentLayer.test.tsx workbench/commentPrompt.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/live.browser.test.ts
# From app/
bun run typecheck:desktop-workbench
bun test workbench/preboot.test.ts workbench/session.test.ts workbench/api
```

The browser smoke requires the root Playwright Chromium installation. The screenshot command and
manual tests start and stop their own server leases. `WORKBENCH_PORT` and `WORKBENCH_APP_PORT`
select alternate ports for another viewer.
