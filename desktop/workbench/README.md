# OpenBot workbench

The workbench shows the real OpenBot Desktop windows in a browser. It has two kinds of scene:

- A **desktop scene** shows the OpenBot Desktop setup window. The window talks to a fake native side, not to the Tauri shell.
- An **app scene** shows OpenBot's own web app (`app/`), as OpenBot Desktop shows it after setup. The app talks to a fake API and to the same fake native side.

You can play a run, stop at any second and measure the layout. The goal is to find layout and state problems before people do.

The workbench is for development only. It never goes into a shipped build.

## Start the workbench

1. Run `cd desktop && bun run workbench`.
2. Open http://localhost:3021/workbench/.

The workbench uses port 3021. The desktop app keeps port 3020. If port 3021 is busy, the server stops and does not pick another port.

The workbench also starts the app server on port 3023. The app scenes use it through `/__app/` on the workbench port. You do not start the app server yourself. When the workbench server stops, the app server stops too.

If the app server does not start, the desktop scenes still work. A notice says that the app scenes did not load.

## Choose the ports

To use other ports, set them when you start the workbench:

```sh
cd desktop
WORKBENCH_PORT=4100 WORKBENCH_APP_PORT=4103 bun run workbench
```

| Setting | Port | Default |
| --- | --- | --- |
| `WORKBENCH_PORT`, or `bun run workbench --port <port>` | The workbench page | 3021 |
| `WORKBENCH_APP_PORT` | The app server | 3023 |

Then open http://localhost:4100/workbench/.

If a port is busy, the workbench stops with one line. The line names the port and tells you how to pick another.

The CLI (`workbench:shot`, `workbench:check`) and the browser tests read the same two settings. Set them to keep your run apart from the runs of other people or agents:

```sh
WORKBENCH_PORT=4100 WORKBENCH_APP_PORT=4103 bun run workbench:check
```

A running workbench keeps its config. If you change `vite.workbench.config.ts` or a file that it imports, the server tells you so. Stop and start the workbench to use the change.

## The page

The page has three columns:

- On the left: **Import a log** and the scene list.
- In the center: the window, the notices and the layout warnings.
- On the right: Comment mode, the run controls, the Window panel and the panels that fold open.

The page has the CopilotKit look: a lavender-gray ground with soft blur circles, glass panels, Plus Jakarta Sans for text and Spline Sans Mono for code. The fonts load from Google Fonts. When your computer uses a dark theme, the page is dark too. The look changes only the page around the window. The window and its contents show as the real app shows them.

## Scenes and runs

A scene is one state of the window. The scene list groups the scenes. The desktop groups are Install, Update, Connected, Status, Move to Cloud, Shutting down and Security floor. The app groups are App: Home, App: Settings, App: Conversation and App: Account.

The desktop scenes come from three files in `scenes/`:

- `install.ts` has the seven install runs.
- `windows.ts` has six runs for the Status, Update, Move to Cloud and Shutting down windows.
- `states.ts` has one still scene for each state in `src/fakeNative/states.ts`.

A **run** is a scene that plays over time. A scene with a run shows these controls:

- **Play** and **Pause** start and stop the clock.
- **Step** jumps to the next run step.
- The **Time** slider seeks to any second. Marks on the slider show the run steps.
- **Speed** is ¼×, ½×, 1×, 10× or Max. Max runs as fast as the browser can go.
- **Pause at each action**: when this is on, a play stops just before each click and type step. The run controls then show the next action, for example "Next: Click · Install".

A run stops at its end, at every speed. A scene without a run shows only the time.

When a run clicks or types during a play or a step, a marker shows the element over the window for a short time. A seek shows no markers, so a CLI shot never shows them.

### Handover and handback

When the setup window asks the native side to open OpenBot (`show_openbot`), the workbench shows the card "OpenBot opens here". In the real app, the setup window goes to OpenBot's own page at this point. The card has two buttons:

- **Open OpenBot** opens the app scene that comes next. After an install, this is `app-onboarding`. After a scene that connects to an OpenBot somewhere else, this is `app-home-bots`. The window settings stay.
- **Show the setup window** closes the card.

Some app buttons give control back to the setup window: `move_to_cloud`, `change_ai_connection`, `stop`, `sign_out` and `change_connection`. When such a call ends, the workbench shows the card "OpenBot Desktop shows its setup window here". The card has two buttons:

- **Open the setup window** opens the desktop scene that shows the next screen, for example `move-to-cloud` after `move_to_cloud`. The button is missing when no scene shows that screen.
- **Show OpenBot** closes the card.

`handover.ts` holds both maps. The cards are outside the window, so a shot of the window does not show them.

## App scenes

An app scene shows the real app: `app/index.html`, `app/src/main.tsx`, the real router and the real routes. It starts at a route, with a signed-in person and seeded server data. The app runs as OpenBot Desktop shows it after setup, or in a plain browser tab.

### The two servers

The app has its own dependencies, so it has its own Vite server:

- The workbench server (port 3021) serves the workbench page and the desktop windows.
- The app server (port 3023, `app/vite.workbench.config.ts`) serves the app under `/__app/`.

The workbench server sends `/__app/*` to the app server, with the HMR socket. When an iframe opens a path that is not a workbench path, the workbench server answers with the app's HTML. Thus the frame's address is the route, for example `/settings/computer`. Everything is on one origin, so the workbench can read the frame.

`cd app && bun run workbench` starts the app server alone. It runs `generate:app-config` first. The workbench starts it for you with this script.

### The boundaries and their fakes

The app crosses these boundaries. The workbench has one fake for each:

| Boundary | Fake | Where |
| --- | --- | --- |
| Desktop bridge (`__TAURI_INTERNALS__`, `plugin:openbot-desktop\|<command>`) | The same native control as the setup window. The page commands get default answers. | `desktop/src/fakeNative/pageShell.ts`, `pageRegistry.ts`, `app/workbench/pageDefaults.ts` |
| Desktop page scripts | The real script text from the Rust source | `app/workbench/rustScripts.ts` |
| HTTP to `/api` | An in-page `fetch`. The base is the MSW handlers that Orval generates from `api/openapi.yaml`. | `app/workbench/api/fakeApi.ts`, `handlers.ts`, `extraHandlers.ts` |
| AG-UI stream | Open `text/event-stream` answers for the runtime's `run` and `connect` requests | `app/workbench/api/agentStream.ts` |
| WebSockets | A fake `WebSocket`. A socket opens at once and stays quiet. | `app/workbench/socket.ts` |
| Session | API answers for the signed-in person, the organization and the role | `app/workbench/session.ts` |
| Storage | A memory `localStorage` and `sessionStorage` for each frame, seeded from the scene | `app/workbench/preboot.js` |
| Time | The page clock, and `Math.random` with a fixed seed | `app/workbench/clockBoot.ts` |

With the host Browser, the app has no Desktop bridge and no Desktop page scripts, as in a real browser.

### Run steps for app scenes

Every step has `at`, the time in seconds from the start of the scene. One step does one of these:

| Step | Does |
| --- | --- |
| `{ at, click }` | Clicks the element with that accessible name |
| `{ at, type, into }` | Types the text into the field with that name |
| `{ at, answer, with }` | Sets the answer of a page command |
| `{ at, settle, value }` | Answers a waiting page command with a value |
| `{ at, fail, problem }` | Makes a waiting page command fail with a problem |
| `{ at, api, with }` | Sets the answer for an API route. `with: null` removes it |
| `{ at, stream, events }` | Writes AG-UI events to the stream of an agent |
| `{ at, streamEnd }` | Ends the stream of an agent |
| `{ at, socket, send }` | Sends a message to each open socket whose address contains the text |
| `{ at, navigate }` | Goes to a route. The router follows the change |

If no stream of the agent is open, its events wait. They go out when the stream opens. Thus a scene can start in the middle of a run of the agent.

### API answers

An API answer is set for a route: a method and an MSW path, for example `GET /api/v2/organizations/:organizationId/bots`. The method `ALL` matches every method. An answer has one of these modes:

| Mode | Does |
| --- | --- |
| `value` | Answers with a JSON body. The status is 200 if you do not give one |
| `never` | The request waits until a new answer for the same route |
| `fail` | Answers with an error status and a body |
| `delay` | Answers after some milliseconds on the page clock |
| `offline` | `fetch` fails, as it does when the network is down |

For a request under `/api/`, the fake API looks in this order:

1. The answers that are set. The newest answer wins.
2. The stream handlers.
3. The extra handlers, for calls that are not in the spec (`/api/auth/*` and others).
4. The generated handlers from the spec.
5. Nothing. The request gets a 404 with "The workbench has no answer for this request."

The answers are set in this order, so a later one wins: the session, the scene's `start.api`, the link's `api`, then the run steps and the API answers panel.

The page commands have a similar order: the defaults in `pageDefaults.ts`, the scene's `start.answers`, the link's `answers`, then the run steps and the Desktop commands panel.

### Time in the app frame

The page clock controls all of the app's timers. These rules apply:

- A `value` answer settles at once. A paused clock still shows the answered screen.
- A `delay` answer and every timer wait for the clock.
- A query that fails tries again on the page clock. By default the app tries one time more, after 1 s. TanStack Query doubles the delay at each new try (1 s, then 2 s). If a scene must show a failed query, seek past these delays.
- At each stop, the workbench waits until the app frame is quiet: no request on its way, no route that loads and no change for two frames. It waits for 3 s or less.
- The time zone and the language come from your browser. The CLI uses UTC and `en-US`, so its shots are the same on each computer.

The **Motion** setting is Still by default. Still stops Motion's animations and sets CSS transitions and animations to 0 s. Real lets them play. The CLI always uses Still.

### Add an app scene

1. Write an `AppScene` in a file under `app/workbench/scenes/`.
2. Add its list to `APP_SCENES` in `app/workbench/scenes/index.ts`.
3. Type each body with `satisfies` against the app's own types.
4. Run `cd app && bun test workbench && bun run typecheck`.
5. Run `cd desktop && bun run workbench:shot <id> --check`.
6. If the Requests panel or the check names a request with no answer, add an answer to the scene's `start.api`.

An `AppScene` has `kind: "app"`, an `id` that starts with `app-`, a `title`, a `group` and a `start`. The `start` holds `route`, `host` and `session`. It can also hold `os`, `api`, `answers`, `storage` and `agents`. The types are in `desktop/workbench/appContract.ts`.

Rules for new app scenes:

- A scene file imports only types from `app/src`. It imports values only from `app/src/lib/api/generated/`.
- Do not put personal data in a scene. Use made-up names, for example `Sam Rivera` and `sam@example.com`.
- `app/workbench/scenes/scenes.test.ts` checks the ids, the groups, the routes, the step times, the API routes, the page commands and the personal data.

## Window settings

The Window panel sets how the frame looks:

- **Size**: two presets (1000 × 800 and 720 × 560), or any width and height. The minimum is 720 × 560.
- **OS**: Mac or Windows. This changes the frame (traffic lights or Windows title bar). It also changes the user agent of the window. Windows also sets the answers the Windows setup needs.
- **Active**: sets whether the window has focus. An inactive window has gray controls.
- **Theme**: Light or Dark. The default is Dark.
- **Zoom**: from 0.5 to 2.
- **Grid**: draws a 4 px grid over the window. You can change the grid color.

For an app scene, the panel also has the **App** fieldset:

- **Host**: OpenBot Desktop or Browser. With Browser, the frame shows a browser bar with the route.
- **Signed in as**: As the scene says, Member, Admin or Owner.
- **Motion**: Still or Real.

A change to the host, the role or the motion loads the window again. When you pick another scene, the host and the motion stay, and the role goes back to the scene's role.

When you move the pointer over the window, the inspector shows the box of the element, the gaps to its neighbors and the distance from the 4 px grid.

## Comment mode

Use Comment mode to write a change request for a coding agent.

1. Press the `C` key, or press the Comment button. The `C` key does nothing while the focus is in a text field.
2. Click one element, or drag over an area of the window.
3. Type your comment.
4. Press **Copy as prompt**, or press Cmd+Enter (Ctrl+Enter on Windows).
5. Paste the prompt into your agent.

Press `Escape` or `C` to leave Comment mode.

The prompt is a Markdown message. It holds:

- Your comment.
- The scene, the time, the window settings and a link to the same frame.
- The `bun run workbench:shot` command that shoots the same frame.
- For one element: its label, its component, its box, its gaps, its distance from the grid, its main styles and its text.
- For an area: a table of the elements in it (first 30), and a summary of vertical gaps, font sizes and padding.
- A short list of what to do. It names the 4 px grid and the `openbot-copy` and `openbot-screen-layout` rules.

The component line names the React component and, when the workbench can find it, the source file and line. The workbench reads this from React internals and from source maps of the dev server. For an app scene, the file is under `app/src`. If the workbench cannot find a component, the line is missing. The prompt then tells the agent to search the repo.

## Use a link

The address of the workbench holds all of its state:

| Parameter | Holds |
| --- | --- |
| `scene` | The scene id |
| `at` | The time in seconds |
| `w`, `h`, `os`, `active`, `theme`, `zoom`, `grid` | The window settings |
| `env` | The build settings (JSON) |
| `answers` | The command answers you set (JSON) |
| `api` | The API answers you set, by route (JSON). App scenes only |
| `host` | `desktop` or `browser`. If it is missing, the scene's host applies |
| `role` | `member`, `admin` or `owner`. If it is missing, the scene's role applies |
| `motion` | `real`. If it is missing, the motion is still |

Press **Copy link** in the Window panel to copy the address. Open it to get the same frame again.

If a parameter is bad, the workbench uses the default for it and shows a notice. The notice says what was wrong. For example, an unknown scene shows the first scene.

Answers that are scripts (code in a scene) are not kept in the link.

## Panels and warnings

For a desktop scene, three panels fold open on the right:

- **Commands** sets the answer of a command. The modes are Value, Never answers, Fails (the call fails with a problem) and Delay (the answer comes after some milliseconds). The workbench keeps your answers in the link.
- **Calls** lists every native call, newest first. A call to a command that is not in `src/fakeNative/registry.ts` shows "Not in the registry".
- **Events** sends an event to the window. You pick the event and edit its JSON payload.

For an app scene, these panels fold open:

- **Desktop commands** is the Commands panel for the page commands of the app.
- **Calls** lists every call to the Desktop bridge.
- **Requests** lists every `/api` request, newest first, with its time, status and source. The source is Scene answer, Stream, Extra, Spec example or No answer. Press **Answer this** to open the route in the API answers panel.
- **API answers** sets the answer for a route. The modes are Value, Never, Fail, Delay and Offline. The workbench keeps your answers in the link.
- **Stream and sockets** lists the open streams and sockets. You can send an AG-UI event to an agent, or a message to the sockets whose address contains a text.

The app listens to no Tauri events, so an app scene has no Events panel.

Under the window, the workbench lists layout warnings as the clock moves. The newest warning is first. A warning is one of these:

- **moved**: an element moved more than 2 px between two checks. The warning names the cause, for example a command or a request. If most of the page moved by the same amount, one warning says "The whole page".
- **cut off**: the content of an element is clipped.
- **outside the window**: an element goes past the edge of the window.

The workbench checks after each native call and event. In an app scene, it also checks after each request, stream event and socket message. Elements that are hidden from view, such as labels for screen readers only, do not get warnings.

Hold the pointer on a warning for 250 ms to jump to its time. The row says "Jumping…" while the window gets there. Then the workbench marks the warning over the window:

- For **moved**: a dashed box where the element was, a solid box where it is, and an arrow between them. A label says how far it moved, for example "moved 157 px down".
- For **cut off**: a box around the element, with a shaded strip for the hidden part. A label says "cut off by N px".
- For **outside the window**: the part past the edge is shaded. A label says "N px outside the window".

When the pointer leaves the list, the mark goes away. Click a warning to keep its mark. A kept mark stays until you click another warning. A play, a step, a seek or another scene removes every mark. The mark is outside the window, so a shot of the window does not show it.

## Import a log

You can make a scene from an OpenBot Desktop troubleshooting file. The scene plays the setup rows of the log at the times in the log. The scene is approximate: the log has the words and the times of the rows, but no download bytes, no clicks and no answers from the back end.

To import a log in the browser:

1. In **Import a log**, set **Start** to First run or Relaunch.
2. Choose the troubleshooting file.

The scene shows under **Imported** and opens at once. It stays only in this browser tab. A link to it does not open it in another browser.

To save the scene for agents and the CLI, run this in the `desktop` folder:

```sh
bun run workbench:import <file> [--start first-run|relaunch] [--session <n>] [--id <id>]
```

The command writes `workbench/scenes/imported/<id>.json`. Git ignores that folder, because the files come from customers. Do not commit them.

## Run the CLI

Agents use `workbench:shot` to get a picture and a report of a frame. You do not need to start the server. The CLI uses a server on port 3021 (or `WORKBENCH_PORT`) if one runs. If not, it starts one. It stops that server at the end, unless another process still uses it. It never stops a server that you started with `bun run workbench`.

```sh
cd desktop
bun run workbench:shot <scene> [--at <seconds>] [--grid] [--size <w>x<h>] \
  [--os mac|windows] [--theme light|dark] [--host desktop|browser] \
  [--role member|admin|owner] [--out <dir>] [--all] [--check] [--include-imported]
```

| Flag | Meaning |
| --- | --- |
| `<scene>` | The scene id, for example `install-mac` or `app-home-bots` |
| `--at` | The time in seconds. The default is `0` |
| `--grid` | Draw the 4 px grid |
| `--size` | The window size, for example `1000x800` |
| `--os`, `--theme` | The OS frame and the theme |
| `--host` | For an app scene: OpenBot Desktop or a browser |
| `--role` | For an app scene: the role of the signed-in person |
| `--out` | The output folder. The default is `workbench-shots/` (not tracked by git) |
| `--all` | Shoot every scene at each run step and at its end |
| `--check` | Fail on problems in the runs (see below) |
| `--include-imported` | With `--all --check`, also check the imported scenes |

The CLI opens its page with the time zone UTC and the language `en-US`.

For each shot, the CLI writes two files:

- `<out>/<scene>@<at>s.png` is the window with its frame.
- `<out>/<scene>@<at>s.json` holds `{ scene, at, window, kind, handedOver, handedBack, elements, warnings, calls, requests, errors }`.

In the JSON:

- `kind` is `desktop` or `app`.
- `handedOver` is true when the setup window opened OpenBot.
- `handedBack` names the command that gave control back to the setup window, or is null.
- `requests` lists the `/api` requests of an app scene. A request with `source: "none"` had no answer.
- `errors` lists the uncaught errors in the app frame.

`bun run workbench:check` is `workbench:shot --all --check`. It walks every scene to its end and saves only the last shot of each. It skips the imported scenes unless you add `--include-imported`. It fails on these problems:

- A run step that finds nothing to click or type into.
- A run that stalls.
- For an app scene: an `/api` request that has no answer.
- For an app scene: an uncaught error in the app.

Exit codes:

- `0`: the shots are saved. Warnings do not change this. Read `warnings` in the JSON.
- `1`: `--check` found a problem. Each problem is one line on stderr, with the scene and the time.
- `2`: the scene is unknown or a flag is bad. For an unknown scene, the CLI lists the scene ids.

## Add a desktop scene

Add a scene to change what the setup window shows or to play a new run.

1. Write a `Scene` in `scenes/install.ts` or `scenes/windows.ts`, or in a new file under `scenes/`.
2. Add it to the list in `scenes/index.ts`.
3. Run `bun test workbench` to check it.

A `Scene` has an `id`, a `title`, a `group` and a `start`. The `start` holds the page `hash` and `search`, and can hold `os`, `env` and `answers`. A scene can also have a `run`, a list of `RunStep`.

Every step has `at`, the time in seconds from the start of the scene. One step does one of these:

| Step | Does |
| --- | --- |
| `{ at, emit, payload }` | Sends an event to the window |
| `{ at, answer, with }` | Sets the answer of a command |
| `{ at, settle, value }` | Answers a command with a value |
| `{ at, fail, problem }` | Makes a command fail with a problem |
| `{ at, click }` | Clicks the button with that accessible name |
| `{ at, type, into }` | Types the text into the field with that name |

Rules for new scenes:

- Type each payload with `satisfies`, so the compiler checks it against the window's own types.
- Do not put personal data in a scene. Use made-up names and keys.
- Match the words and the timing of the real native side. `scenes/install.ts` names the Rust functions it copies.
- A command that a run does not answer gets the answer of the first-run state.

## How it works

One fake native side serves the whole project. It lives in `src/fakeNative`. The workbench and `src/setupLayout.browser.test.ts` both use it, so they cannot drift apart. `vite.workbench.config.ts` points `@tauri-apps/api/core` and `@tauri-apps/api/event` to the fake. The shipped build uses `vite.config.ts` and never loads it.

- `registry.ts` lists every command and event the setup window uses.
- `pageRegistry.ts` lists the page commands that the app calls.
- `control.ts` keeps the answers, the call log and the events. It lives on `globalThis.__workbench`.
- `states.ts` gives the answers for each state of the setup window.

The workbench page holds the window in an iframe (`WindowFrame.tsx`). For a desktop scene, the iframe loads `frame.html`. `frameBoot.ts` runs before the window's own code. It installs the page clock, sets the user agent, sets the answers and the theme, and starts the run.

For an app scene, the iframe loads the app at its route. The app server adds three scripts to the app's HTML. `preboot.js` runs first. It puts in the memory storage and a `matchMedia` that follows the workbench theme and motion. Then `clockBoot.ts` installs the page clock and the seeded `Math.random`. Then `frameBoot.ts` installs the fakes, runs the Desktop page scripts and starts the run. These run before `main.tsx`. After the app draws its first element, `appBoot.ts` tells the page that the frame is ready. The page loads the app scenes from `/__app/workbench/scenes/index.ts`. The frame finds its scene by id in the same file.

The page clock (`clock.ts`) replaces `Date`, `setTimeout`, `setInterval` and `performance.now` in the iframe. Time moves only when the workbench says so. This makes every frame repeatable. A seek forward runs the clock in steps of at most 500 ms, and it stops at each run step. In this way every timer and every step runs in order, and the window can draw between them. A seek back loads the window again and plays forward to the new time.

Nothing of the workbench goes into a shipped build:

- `desktop/workbench/shippedBuild.test.ts` builds the desktop app. It fails if the output holds `__workbench` or `fakeNative`.
- `app/workbench/shippedBuild.test.ts` always checks that `app/src`, `app/index.html` and `app/vite.config.ts` do not name the workbench. With `OPENBOT_APP_BUILD_GUARD=1`, it also builds the app with `vite.config.ts`. It fails if the output holds `__workbench`, `fakeNative`, `/__app/` or `workbenchPreboot`.

## Tests

Run these commands in the `desktop` folder:

```sh
bun test workbench src/fakeNative
bun run typecheck
```

Run these commands in the `app` folder:

```sh
bun test workbench
bun run typecheck
```

The browser tests drive a real browser. They need `OPENBOT_APP_BROWSER=1`. Run them in the `desktop` folder:

```sh
OPENBOT_APP_BROWSER=1 bun test src/setupLayout.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/determinism.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/layoutWatch.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/shot.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/appFrame.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/appDeterminism.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/appShot.browser.test.ts
```

- `appFrame.browser.test.ts` checks the app frame: it boots, the bridge and the fake API answer, and Vite does not load it two times.
- `appDeterminism.browser.test.ts` checks that an app frame is the same after a seek back and after a reload.
- `appShot.browser.test.ts` runs the CLI on an app scene and on an unknown scene.

`desktop/workbench/shippedBuild.test.ts` runs a full build. It takes up to three minutes. To run the full build check of the app, run this in the repository root:

```sh
OPENBOT_APP_BUILD_GUARD=1 bun test app/workbench/shippedBuild.test.ts
```

## CI

The CI job "app (real browser, desktop setup window)" runs the workbench checks. It runs when a change touches code that is not a test or a doc. The job does these steps:

1. It runs `bun run generate:app-config`.
2. It runs the seven browser tests in the Playwright image.
3. It runs `bun run workbench:check` in the Playwright image.
4. It runs the full build check of the app with `OPENBOT_APP_BUILD_GUARD=1`.
