# OpenBot workbench

The workbench shows the real OpenBot Desktop windows in a browser. It has two kinds of scene:

- A **desktop scene** shows the OpenBot Desktop setup window. The window talks to a fake native side, not to the Tauri shell.
- An **app scene** shows OpenBot's own web app (`app/`), as OpenBot Desktop shows it after setup. The app talks to a fake API and to the same fake native side.

You can play a run, stop at any second and measure the layout. The goal is to find layout and state problems before people do.

The workbench is for development only. It never goes into a shipped build.

## The rule

The workbench uses the app's own components, types, state and values. It never keeps a copy of them. Fakes are allowed only at the boundaries (see [The boundaries and their fakes](#the-boundaries-and-their-fakes)).

So when the app changes, the workbench changes with it, or it fails to build. Nobody has to keep a second copy up to date. This applies to:

- **What the window shows.** A scene loads the real app. It never draws a screen of its own.
- **Where the app is.** A scene gets to a state through the app's own state. Each desktop state names the setup step it shows with App's own type, `SetupStep`, and `stateSteps.browser.test.ts` checks that the window really shows that step.
- **Types and values.** Scene data uses `satisfies` with the app's own types. A list, a key or a route that the app has comes in by import, never typed out again. If the workbench cannot import it, move it to `shared/` and import it from there in both places. `noCopies.test.ts` fails when the workbench spells out one of these values.
- **The workbench's own panels.** These use the app's UI components (`app/src/components/ui`) and do not draw their own. `appUi.test.ts` fails when a workbench file draws its own control or sets its own color.

A new panel uses the app's components. If the app has no component for a need, add it to `app/src/components/ui` first.

## Start the workbench

1. Run `cd desktop && bun run workbench`.
2. Open http://localhost:3021/workbench/. The startup output prints this link under Vite's own links.

The address `/` (for example http://localhost:3021/) sends you to `/workbench/` and keeps the query. A frame of the app still gets the app at `/`.

The workbench uses port 3021. The desktop app keeps port 3020. If port 3021 is busy, the server stops and does not pick another port.

The workbench also starts the app server on port 3023 (the workbench port + 2). The app scenes use it through `/__app/` on the workbench port. You do not start the app server yourself. When the workbench server stops, the app server stops too. A workbench never uses an app server that it did not start: if the app server's port is busy, the server log says so.

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
| `WORKBENCH_APP_PORT` | The app server | The workbench port + 2 (3023) |

Then open http://localhost:4100/workbench/. With `--port 4100` alone, the app server uses port 4102.

If a port is busy, the workbench stops with one line. The line names the port and tells you how to pick another.

The CLI (`workbench:shot`, `workbench:check`) and the browser tests read the same two settings. Set them to keep your run apart from the runs of other people or agents:

```sh
WORKBENCH_PORT=4100 WORKBENCH_APP_PORT=4103 bun run workbench:check
```

A running workbench keeps its config. If you change `vite.workbench.config.ts` or a file that it imports, the server tells you so. Stop and start the workbench to use the change.

## The page

The page has three columns:

- On the left: two links, **Scenes** (this page) and **Findings** (see [Findings](#findings)). Under them, **Scenes** (a filter and the scene groups), and **Import a log** folded under them.
- In the center: the window, the notices and the layout warnings.
- On the right: **Run** (the run controls and the **?** keys help), **Window**, **Review** (Comment mode and Critique this screen) and the panels that fold open.

The page uses the app's components and the app's theme. It follows the light or dark setting of your computer, also when the setting changes while the page is open. The window and its contents show as the real app shows them.

### Panel sizes

A drag handle is between the columns, and one is above the layout warnings. Drag a handle to change the size:

| Handle | Default | Limits |
| --- | --- | --- |
| Scene column width | 248 px | 180 to 420 px |
| Right panel width | 280 px | 220 to 480 px |
| Layout warnings height | 25% of the page height | 72 px to 70% of the page height |

You can also press Tab to go to a handle and then use the arrow keys. Each press moves 8 px, and Shift moves 32 px. Home and End go to the limits. Double-click a handle, or press Enter on it, to go back to the default.

The browser keeps the sizes for you only, in `localStorage`. They are not in the link. In a private window, the defaults apply.

### Keys

Press the **?** button next to **Run** to see the keys.

| Key | Does |
| --- | --- |
| `/` | Puts the focus in the scene filter |
| `↑` `↓` | Moves between the scenes in the list |
| `Enter` | Opens the scene you moved to |
| `Space` | Plays or pauses the run |
| `.` | Steps to the next run step |
| `←` `→` | Seeks 1 second back or on |
| `C` | Turns Comment mode on or off |

The keys do nothing while the focus is in a field that you type in. A focused slider or drag handle keeps its own arrow keys. Only `C` works while the focus is in the window.

## Scenes and runs

A scene is one state of the window. The scene list groups the scenes. The desktop groups are Install, Update, Connected, Status, Move to Cloud, Shutting down and Security floor. The app groups are App: Home, App: Settings, App: Conversation and App: Account.

The current scene has a gray fill. When the page opens, the list scrolls to it.

Type in **Filter scenes** to show only the scenes whose title, id or group has the text. Press `↓` and `↑` in the filter to move between the matches, and `Enter` to open one. `Escape` clears the filter.

Click a group name to fold the group or open it again. The number after the name is how many scenes the group has. **Collapse all** folds every group, and **Expand all** opens them. The group of the current scene always stays open, and a filter opens every group that has a match. The browser keeps the folded groups for you only, in `localStorage`.

The desktop scenes come from three files in `scenes/`:

- `install.ts` has the eight install runs.
- `windows.ts` has six runs for the Status, Update, Move to Cloud and Shutting down windows.
- `states.ts` has one still scene for each state in `src/fakeNative/states.ts`. Each state names the setup step it shows (`step`, a `SetupStep` from `src/telemetry.ts`), or `null` when the window shows no setup step. When App's flow changes, `stateSteps.browser.test.ts` names each state that no longer shows its step.

A **run** is a scene that plays over time. A scene with a run shows these controls:

- **Play** and **Pause** start and stop the clock.
- **Step** jumps to the next run step.
- The **Time** slider seeks to any second. Marks under the slider show the run steps.
- **Speed** is ¼×, ½×, 1×, 10× or Max. Max runs as fast as the browser can go.
- **Pause at each action**: when this is on, a play stops just before each click and type step. The run controls then show the next action, for example "Next: Click · Install".

A run stops at its end, at every speed. A scene without a run says "No run. The scene plays on its own." and shows the time.

When a run clicks or types during a play or a step, a marker shows the element over the window for a short time (at most 1.2 s). The marker follows its element at every speed. When the element leaves the screen, is hidden or has no size, the marker stays at the element's last place for 0.5 s as a ghost: the same label in a quiet outlined style (inside the box when it fits), the outline dashed. The ghost stays at full strength for most of the 0.5 s, then fades out in the last 150 ms. So every click and type step shows for at least about 0.5 s, also when the click changes the screen at once. With reduced motion, the ghost does not fade. A marker never shows as a ghost while its element is on the screen: it follows the element. The paused "Next:" marker is measured again when the zoom, the window or the stage changes. A seek shows no markers, so a CLI shot never shows them.

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
- **OS**: Mac or Windows. This changes the frame (traffic lights or Windows title bar). The Mac lights are where macOS draws them, over the page (see [Spacing](#spacing)). It also changes the user agent of the window. Windows also sets the answers the Windows setup needs.
- **Active**: sets whether the window has focus. An inactive window has gray controls.
- **Theme**: Light or Dark. The default is Dark.
- **Zoom**: from 0.5 to 2, or **Fit**. Fit makes the window as big as the space for it, up to 100%. The button shows the zoom, for example "Fit (75%)". When the link has no `zoom`, Fit is on. When you type a zoom, Fit goes off. Press **Fit** to turn it on or off. With Fit on, the link has no `zoom`, so the link opens with Fit too. The CLI and the browser tests always give a `zoom`, so their shots never use Fit.
- **Grid**: draws a 4 px grid over the window. You can change the grid color.

Each setting has its name on the left. For an app scene, the panel also has an **App** section:

- **Host**: OpenBot Desktop or Browser. With Browser, the frame shows a browser bar with the route that the app shows now. When the app goes to another route, for example after a redirect, the bar shows the new route.
- **Signed in as**: As the scene says, Member, Admin or Owner.
- **Motion**: Still or Real.
- **Skin**: As the scene says, OpenBot, OpenDuet, OpenDots or OpenFuse. The workbench puts the skin in the frame's storage (`openbot-skin`, read before the first paint) and answers the person's preferences with it, since the account's skin wins over the stored one.
- **Sidebar**: As the scene says, Open or Closed. It goes in the frame's storage (`openbot-sidebar`: `expanded` or `collapsed`), where OpenBot's own sidebar reads it. OpenDots keeps its sidebar in React state only, so this setting does not reach it; its closed scenes press "Collapse sidebar" instead (see below). OpenDuet and OpenFuse have no sidebar.

A change to the host, the role, the motion, the skin or the sidebar loads the window again. When you pick another scene, the host, the motion, the skin and the sidebar stay, and the role goes back to the scene's role. The link keeps the skin and the sidebar (`skin`, `sidebar`), and the CLIs take `--skin` and `--sidebar`.

### Skin scenes

A layout can be right in one skin and wrong in another, or right with the sidebar open and wrong with it closed: the window's buttons then sit over another part of the page. So the group **App: Skins** has the main Bot page (`app-home-bots`) and Settings → Connections (`app-settings-connections`) in every skin (`app/workbench/skins.ts`): OpenBot and OpenDots with the sidebar open and closed (`<id>-<skin>-sidebar-<open|closed>`), OpenDuet and OpenFuse once each (`<id>-<skin>`). `workbench:check` walks all of them, so the [Spacing](#spacing) check sees each layout. A scene can set `start.skin` and `start.sidebar` itself too.

When you move the pointer over the window, the inspector shows the box of the element, the gaps to its neighbors and the distance from the 4 px grid.

## Comment mode

Use Comment mode to write a prompt for a coding agent about one part of the window.

1. Press the `C` key, or press **Comment** in the Review section. The `C` key does nothing while the focus is in a text field.
2. Click one element, or drag over an area of the window.
3. In **Ask for**, choose what you want: **Change request**, or an impeccable command (Critique, Audit, Layout, Typeset, Clarify or Polish). The browser keeps your last choice.
4. Type your comment. A change request needs a comment. For an impeccable command, the comment is optional.
5. Press **Copy as prompt**, or press Cmd+Enter (Ctrl+Enter on Windows).
6. Paste the prompt into your agent.

Press `Escape` or `C` to leave Comment mode.

### Change request

The prompt is a Markdown message. It holds:

- Your comment.
- The scene, the time, the window settings and a link to the same frame.
- For an app scene: the route that the app frame shows now, and the host (OpenBot Desktop or Browser).
- The `bun run workbench:shot` command that shoots the same frame.
- For one element: its label, its component, its box, its gaps, its distance from the grid, its main styles and its text.
- For an area: a table of the elements in it (first 30), and a summary of vertical gaps, font sizes and padding.
- A short list of what to do. It names the 4 px grid and the `openbot-copy` and `openbot-screen-layout` rules.

The component line names the React component and, when the workbench can find it, the source file and line. The workbench reads this from React internals and from source maps of the dev server. For an app scene, the file is under `app/src`. If the workbench cannot find a component, the line is missing. The prompt then tells the agent to search the repo.

### An impeccable command

With an impeccable command, the prompt is the same kind of prompt that `bun run workbench:critique` writes (see `critiquePrompt.ts`), but only for the part you picked:

- The first line is `/impeccable <command> <target>`. The target is the source file that most of the picked elements have in their component chain. If there is none, it is the app route or the scene id.
- The surface mode is Operate.
- No image comes with the prompt. The prompt tells the agent to shoot the frame first with `bun run workbench:shot`, and not to use impeccable's own `shot`.
- A Scope section names the element or the area and its box, and tells the agent not to change the rest of the screen.
- The prompt lists the picked elements and only the layout warnings whose box touches the picked part.
- Your comment, if you wrote one.

### Critique this screen

To ask about the whole window, choose a command next to **Critique this screen** and press the button. The workbench copies an impeccable prompt for the whole frame, with all of its elements (first 60) and all of its layout warnings. Paste it into your agent.

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
| `mark` | A layout warning to show when the page opens: `<kind>\|<ms>\|<label>`, for example `moved\|44000\|span "Opening OpenBot"`. See below |
| `embed` | `1` shows only the window and the layout warnings. The Findings page uses it |

With `mark`, the workbench goes to the warning's time after it opens the scene, finds the warning of the same kind and label (at most 1 s from that time), and keeps its mark over the window, as a click on its row does. If the run does not show the warning again, a notice says so. The workbench reads `mark` once: it is not in the address after that.

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
- **Requests** lists every `/api` request, newest first. The first line has the time, the method, the route and the status. The route shows `…` in place of `/api/v2/organizations/default`. Hold the pointer on a row to see all of the route. The second line has the source and **Answer this**. The source is Scene answer, Stream, Extra, Spec example or No answer. Press **Answer this** to open the route in the API answers panel.
- **API answers** sets the answer for a route. The modes are Value, Never, Fail, Delay and Offline. The workbench keeps your answers in the link.
- **Stream and sockets** lists the open streams and sockets. You can send an AG-UI event to an agent, or a message to the sockets whose address contains a text.

The app listens to no Tauri events, so an app scene has no Events panel.

Under the window, the workbench lists layout warnings as the clock moves. The list is in a fixed order: by time, then by the name of the element. A warning is one of these:

- **moved**: an element moved more than 2 px between two checks. The warning names the cause, for example a command or a request. If most of the page moved by the same amount, one warning says "The whole page".
- **cut off**: a box with hidden overflow (the element or a box around it) hides more than 2 px of the element's text. Text cut on purpose does not count: an ellipsis (`text-overflow: ellipsis`, as Tailwind's `truncate`) or a line clamp, on the element or on the box that cuts it. Text that is larger than its box but shows (overflow visible), and text in a box that scrolls, do not count either.
- **outside the window**: an element goes past the edge of the window, and no scroll brings it into view. An element in a box that scrolls, or past the bottom or the right of a page that scrolls itself, is not outside; an element fixed to the window (`position: fixed`) still is.
- **spacing**: on a Mac in OpenBot Desktop, the page comes too near the window's close, minimise and zoom buttons, or the buttons do not sit well in the column under them. See [Spacing](#spacing).
- **spinners**: the window shows more than one spinner at the same time. The step's own wait is the one spinner. Anything else that runs beside it is marked and held still (`SetupProgress` `quiet`). A spinner is an element with the class `step-spinner` (also when reduced motion holds it still) or `animate-spin`, or an element that runs the `step-spin` or `spin` animation. A spinner that a person does not see (hidden, no size, opacity 0, or for screen readers only) does not count. A spinner has `aria-hidden`, but that does not hide it from this check. The warning names where each spinner is: the `aria-label` of the nearest box around it, or else that box's tag and class.

Each move gets a class by the same rules as the findings (see [Which moves are findings](#which-moves-are-findings)), and its row names it. The list shows shift under hand, jitter, cut off, outside, spacing and spinners. The expected moves (after an input, a new screen, a load, a late load shift) are behind **Show expected moves (N)**, as on the Findings page. The heading counts the rows shown without the expected moves.

The workbench checks after each native call and event. In an app scene, it also checks after each request, stream event and socket message. Elements that are hidden from view, such as labels for screen readers only, do not get warnings.

Hold the pointer on a warning for 250 ms to jump to its time. The row says "Jumping…" while the window gets there, and the heading says where it goes, for example "Seeking to 0:44…". The list keeps its rows during the jump, so the row under the pointer stays. When the jump goes back in time, the window starts again under a still of what it showed, so the replay does not show; the new state shows in one step. The still looks like the window: the same theme, under the title bar, and with the cards over the window ("OpenBot opens here") as they were. After a seek back, the rows that the replay has not reached yet stay in the list, muted. A muted row goes when the run passes its time without finding it again, for example after you fixed it and the frame loaded again. Then the workbench marks the warning over the window:

- For **moved**: a dashed box where the element was, a solid box where it is, and an arrow between them. A label says how far it moved, for example "moved 157 px down".
- For **cut off**: a box around the element, with a shaded strip for the hidden part. A label says "cut off by N px".
- For **outside the window**: the part past the edge is shaded. A label says "N px outside the window".
- For **spacing**: a box around the element (or the column), with the window's buttons shaded. A label on the buttons says what is wrong, for example "0 px from the window buttons".
- For **spinners**: a box around all the spinners, with each spinner shaded. A label says "2 spinners at once".

### Spacing

macOS draws the window's buttons over OpenBot's page, so the page must leave room for them. "Little details matter": a panel's rounded corner 5 px from the green light, or buttons that miss the middle of the icons under them, makes the window look unfinished. The Spacing check runs on every check of every scene, with the other warnings, for a Mac window in OpenBot Desktop. A Windows window has its own title bar above the page, and a browser draws no buttons, so they get no Spacing warnings.

Where the buttons are (`titleBar.ts`, one place for every number):

| Number | Value | Source |
| --- | --- | --- |
| Close button's frame | 20 px in | `TRAFFIC_LIGHTS` (`x: 20.0, y: 31.0`) in `desktop/src-tauri/src/main.rs`, set with `.traffic_light_position` on the window's builder. tao 0.37.2 (`inset_traffic_lights` in `src/platform_impl/macos/view.rs`) puts button *i* at `x + i × space_between` and does not move them up or down. |
| Circles | 12 px, 8 px apart (20 px from middle to middle), each in a 14 px frame | AppKit's standard window buttons: the first circle is 21 to 33 px in, its middle at 27. |
| Middle of the row | 32.5 px down | main.rs: on macOS 26 the circles' middle lands about 1.5 px below `y` (31). |
| Check | — | Dusty's capture of Settings → Connections (1252 px wide; the window's edge at x 55, y 37): centres at 27, 48, 68 and 33 from the window, so the scale is 1.0 and the numbers above agree within the capture's 1 px. |

So the circles run from 21 to 73 px in and from 26.5 to 38.5 px down. The workbench draws the Mac lights there, over the page.

The rules (`spacing.ts`, pure geometry; `layoutWatch.ts` reads the boxes from the page):

- **Clearance**: nothing a person sees (text, an icon, an image, a field) comes within 8 px of the buttons or goes under them, and no panel's edge or rounded corner does either. A panel is a box that paints itself: a border, a background unlike its parent's, or a rounded box with a shadow. The page's own background (a box as big as the window) does not count, nor a panel's edges on the window's own edges, nor the drag region, which paints nothing. A painted panel that also moves the window (the inset `main`) is still a panel.
- **Column**: the column the buttons sit over (the sidebar, with its gutter on to the panel beside it) is at least the buttons' width plus 8 px on each side ("The window buttons do not fit their column: N px for M px"), and, in a rail of icons (at most twice that room wide), the buttons sit in its middle, over its icons. In a wider sidebar macOS puts them at its top left, so only the fit counts there.
- **Row**: the buttons' middle is the middle of the nearest item on their row (for example Back to app in Admin), and no panel beside them starts above their middle with its corner next to them.

The scene `app-settings-connections` (Settings → Connections, dark) shows all three: the inset panel starts at 72 px, under the zoom button's last 1 px; the buttons sit 11 px right of the middle of the 72 px column (21 px from its left edge, -1 px from its right); and the panel's top is 25 px above the buttons' middle. Dusty's capture has the same three, with the panel 5 px past the green light.

The row of the marked warning has a tint and a dot in the color of the mark. When the pointer leaves the list, the mark goes away. Click a warning to keep its mark. A kept mark stays until you click another warning. A play, a step, a seek or another scene removes every mark. The mark is outside the window, so a shot of the window does not show it.

## Import a log

You can make a scene from an OpenBot Desktop troubleshooting file. The scene plays the setup rows of the log at the times in the log. The scene is approximate: the log has the words and the times of the rows, but no download bytes, no clicks and no answers from the back end.

To import a log in the browser:

1. Open **Import a log** under the scene list. It is folded until you import a scene.
2. Set **Start** to First run or Relaunch.
3. Choose the troubleshooting file.

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
  [--role member|admin|owner] [--skin openbot|openduet|opendots|openfuse] [--sidebar open|closed]
  [--out <dir>] [--all] [--check] [--include-imported]
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
| `--skin` | For an app scene: the skin (see [Window settings](#window-settings)) |
| `--sidebar` | For an app scene: the sidebar open or closed at the start |
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

`bun run workbench:check` is `workbench:shot --all --check --out workbench-shots/check`. It walks every scene to its end and saves only the last shot of each. It also writes `findings.json` (see [Findings](#findings)). With one scene and `--check`, the walk also stops at each run step before `--at`. It skips the imported scenes unless you add `--include-imported`. It fails on these problems:

- A run step that finds nothing to click or type into.
- A run that stalls.
- For an app scene: an `/api` request that has no answer.
- For an app scene: an uncaught error in the app.
- More than one spinner at the same time (a **spinners** warning). It is the one layout warning that fails the check.

Exit codes:

- `0`: the shots are saved. Warnings other than spinners do not change this. Read `warnings` in the JSON.
- `1`: `--check` found a problem. Each problem is one line on stderr, with the scene and the time.
- `2`: the scene is unknown or a flag is bad. For an unknown scene, the CLI lists the scene ids.

## Findings

The Findings page puts every finding of the last check in one list. Open it with the **Findings** link at the top left of the workbench, or at http://localhost:3021/workbench/findings/.

### What a finding is

`bun run workbench:check` also writes `workbench-shots/check/findings.json`. It holds every layout warning (moved, cut off, outside the window, spacing, spinners) and every problem of the runs (a request with no answer, an error in the app, a run that stalls, a run step that finds nothing) of every committed scene.

For each warning, the check finds its element in the window while the run is at a step, and reads the element's component chain and source file. When the element is gone by then, it takes them from another warning of the same kind and label.

The same problem can show in many scenes. One finding holds all of them. Warnings are the same finding when they have the same kind, element, component file and size (a move in steps of 4 px). Each finding has:

| Field | Holds |
| --- | --- |
| `id` | A short id made from the finding's key. The same key gives the same id in every check |
| `title` | For example `span "Opening OpenBot" moves 245 px up` |
| `kind` | `moved`, `clipped`, `outside`, `spacing`, `spinners`, `no-answer`, `app-error`, `stalled` or `step` |
| `severity` | How bad it is: how far it moved, how many px are cut off or outside, or for spacing how far inside the 8 px, off the middle or short of room. A problem of a run is always 10000 |
| `component` | The nearest component with a source file, and the line |
| `movement` | For a move: its class, the rule it hit and why (see below) |
| `occurrences` | Each scene and time (ms) it shows at, with the warning, its boxes and its own class |

### Which moves are findings

A layout changes, and things move: most moves are normal. The check gives each move a class, and the page shows only the two classes that are bugs:

| Class | Rule | A move is in it when |
| --- | --- | --- |
| Shift under hand (worst) | Shift under hand | The element the person is about to click or type into moves, with no input in the last 500 ms. A run has no real pointer, so this is the element of the next click or type step (at most 2 s later), the element of the last click or type step on the same screen, or the focused element |
| Jitter | Jitter | The same element moves back and forth 3 or more times on the same screen, with no input between the moves |
| Expected | After an input | It moves at most 500 ms after a click, typing or a route change of the run (as CLS leaves out moves after input) |
| Expected | New screen | The screen changed between the two checks: another route or another main heading |
| Expected | While the screen loads | It moves before the screen is first quiet (500 ms with no move, at most 5 s after the screen starts) |
| Expected | Late load shift | Any other move: a late move on a quiet screen. This is normal |

The rules are tried in this order: after an input, new screen, while the screen loads, shift under hand, jitter, late load shift. The screen is the route and the main heading (the `h1`, or else the first heading). For each check, the workbench keeps the screen and the focused element (`__workbenchPage.screens()`), so the check can read them after the run.

Each finding says the rule it hit and why, for example `Jitter: moved up to 13 px 14 times on "Finishing setup" with no input`. The moves of a jitter are one finding, whatever their size. `classifyMoves` in `findings.ts` does this, and `findings.test.ts` tests each rule.

`findings.ts` makes the findings. It has no browser and no files, and `findings.test.ts` tests it.

### The page

On the left:

- When the check ran, and **Run the check again**. The check runs in the background on the workbench server, one at a time. The page shows how many scenes are done, and loads the new findings at the end. A check that finds problems still writes its findings.
- Filters: words, the kind, the window (setup window or app), the component file and the smallest size. **Sort by** size, number of scenes or time. By size, shift under hand comes first, then jitter.
- **Show expected moves**: off by default, so the list shows shift under hand, jitter, cut off, outside, spacing and the run problems. Turn it on to see the expected moves too.
- The findings. Each row has the title, the kind or the class, the size, the number of scenes and the file.

On the right, the selected finding:

- Its title, kind or class, size, scenes and file, and the rule it hit at this time and why. A Spacing finding shows the Spacing rule and why it matters.
- **Previous** and **Next** go to its other times. The row of buttons under them lists every time.
- The real workbench page in a frame, with `embed=1` and `mark`. It opens the scene at the time and marks the warning (the dashed box where it was, the box where it is, the arrow and the label). The frame is the workbench itself, not a copy: what it shows is what **Open in workbench** shows. A time in the same scene goes there in the frame, without a new load.
- **Copy as prompt** copies a change request for an agent: the finding, every scene and time, the file, and the element at this time.
- **Open in workbench** opens the same time in the full workbench.

Keys: `j` and `k` go to the next and the previous finding. `←` and `→` go to the previous and the next time. They do nothing while the focus is in a field.

The address keeps the selected finding (`finding`) and the time (`o`).

### The server

The workbench server (`findingsServer.ts`) answers these requests:

| Request | Does |
| --- | --- |
| `GET /__workbench/findings` | The newest `findings.json` in `workbench-shots/check/` or a folder under it, with its time. A 404 with a message when there is none |
| `POST /__workbench/findings/run` | Starts `workbench:check` with the server's own ports, so it uses this server and its leases. A 409 when a check already runs |
| `GET /__workbench/findings/status` | Whether a check runs, how many scenes are done of how many, and the last lines of its errors |

CI keeps `findings.json` of each check as the artifact `workbench-findings`, also when the check fails.

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
- Import a value from the app. Do not type it out again (see [The rule](#the-rule)).
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

If the app frame loads again during a seek (for example, Vite reloads it), the seek waits for the new load. It does not end on a window that is not ready. The app server's lines about optimized dependencies and reloads go to `server.log` in the folder `<tmpdir>/openbot-workbench-<port>/`. Look there to see if a reload occurred.

The page clock (`clock.ts`) replaces `Date`, `setTimeout`, `setInterval` and `performance.now` in the iframe. Time moves only when the workbench says so. This makes every frame repeatable. A seek forward runs the clock in steps of at most 500 ms, and it stops at each run step. In this way every timer and every step runs in order, and the window can draw between them. A seek back loads the window again and plays forward to the new time.

Nothing of the workbench goes into a shipped build:

- `desktop/workbench/shippedBuild.test.ts` builds the desktop app. It fails if the output holds `__workbench` or `fakeNative`.
- `app/workbench/shippedBuild.test.ts` always checks that `app/src`, `app/index.html` and `app/vite.config.ts` do not name the workbench. With `OPENBOT_APP_BUILD_GUARD=1`, it also builds the app with `vite.config.ts`. It fails if the output holds `__workbench`, `fakeNative`, `/__app/` or `workbenchPreboot`.

## Tests

Run these commands in the `desktop` folder:

```sh
bun test workbench src/fakeNative
bun run typecheck
bun run typecheck:workbench
```

`bun run typecheck` checks the desktop without the workbench. The desktop's build jobs install only the `desktop` folder, and the workbench uses the app's components, whose packages only the `app` folder installs. `bun run typecheck:workbench` checks the workbench with `workbench/tsconfig.json`, which maps `@/` to `app/src`. CI runs it in the static job, where both folders are installed. `workbench/desktopOnlyInstall.test.ts` fails if the desktop's typecheck or its test preloads need the app's packages.

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
OPENBOT_APP_BROWSER=1 bun test workbench/critique.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/motion.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/findings.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/stateSteps.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/oneSpinner.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/appUi.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/popups.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/keys.browser.test.ts
```

- `appFrame.browser.test.ts` checks the app frame: it boots, the bridge and the fake API answer, and Vite does not load it two times. It also checks that a seek ends when the frame loads again.
- `appDeterminism.browser.test.ts` checks that an app frame is the same after a seek back and after a reload.
- `appShot.browser.test.ts` runs the CLI on an app scene and on an unknown scene.
- `critique.browser.test.ts` runs `workbench:critique` and checks the folder it writes: `frame.png`, `frame.json` and `prompt.md`.
- `motion.browser.test.ts` checks that the paused "Next:" marker stays on its element after Fit and a splitter drag, that the Install marker (or its ghost) shows for at least 400 ms after the click, and that a warning hover that seeks back keeps a still of the window over the replay that looks like the window did (less than 2% of its pixels differ).
- `appUi.browser.test.ts` checks that the workbench page loads with the app's light and dark theme and with one copy of React.
- `popups.browser.test.ts` checks that a popup of the page (a list, a box) over the window shows above the window. The inspector does not measure it, and in Comment mode a click in it does not start a comment.
- `keys.browser.test.ts` checks that the page's keys (`C`, `.`, `/`, Space) do nothing while the focus is in a list, the Time slider or a popup, so a typed comment is not lost. Space and Enter still open a list, and the slider keeps its arrow keys.
- `stateSteps.browser.test.ts` opens each state scene and checks that the window shows the setup step that the state names.
- `oneSpinner.browser.test.ts` walks each install run to each of its run steps and to its end, and opens each state scene that shows a setup step. It names each frame that shows more than one spinner at the same time.
- `findings.browser.test.ts` runs the check on one scene, then opens the Findings page. It checks that the page lists the findings, that a finding opens its scene at its time with the warning marked, and that the next time works.

You can also run all fifteen files in one `bun test` command, as CI does. Each file gets the workbench server in its `beforeAll` hook and gives it back with `stop()` in its `afterAll` hook. The hooks have their own time limits, because bun gives a hook only 5 seconds. `bun test` does not send the process `exit` event, so a file that does not call `stop()` leaves the server running.

`desktop/workbench/shippedBuild.test.ts` runs a full build. It takes up to three minutes. To run the full build check of the app, run this in the repository root:

```sh
OPENBOT_APP_BUILD_GUARD=1 bun test app/workbench/shippedBuild.test.ts
```

## CI

The CI job "app (real browser, desktop setup window)" runs the workbench checks. It runs when a change touches code that is not a test or a doc. The job does these steps:

1. It runs `bun run generate:app-config`.
2. It runs the full build check of the app with `OPENBOT_APP_BUILD_GUARD=1`, on the runner. It runs before the steps in the image: those run as root, and after them the build cannot write its config into `app/node_modules/.vite-temp`.
3. It runs the fourteen browser tests in the Playwright image.
4. It runs `bun run workbench:check` in the Playwright image.
5. It keeps `workbench-shots/check/findings.json` as the artifact `workbench-findings`.

Both image steps run with `docker run --init`. Then tini is PID 1 and reaps the app servers whose workbench server exited. Without it, such an app server stays a zombie that looks alive, and each stop waits out its time limits.
