# OpenBot Desktop workbench

The workbench shows the real OpenBot setup window in a browser. The window talks to a fake native side, not to the Tauri shell. You can play an install, stop at any second and measure the layout. The goal is to find layout and state problems before people do.

The workbench is for development only. It never goes into the shipped app.

## Start the workbench

1. Run `cd desktop && bun run workbench`.
2. Open http://localhost:3021/workbench/.

The workbench uses port 3021. The app keeps port 3020. If port 3021 is busy, the server stops and does not pick another port.

The workbench also starts the app server on port 3023. The app scenes use it through `/__app/` on the workbench port.

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

## Scenes and runs

A scene is one state of the window. The scene list on the left groups the scenes: Install, Update, Connected, Status, Move to Cloud, Shutting down and Security floor.

Two kinds of scene exist:

- A **run** is an install that plays over time. The seven install runs come from `scenes/install.ts`.
- A **state scene** is one still state. There is one for each state in `src/fakeNative/states.ts`.

A scene with a run shows these controls:

- **Play** and **Pause** start and stop the clock.
- **Step** jumps to the next run step.
- The **Time** slider seeks to any second. Marks on the slider show the run steps.
- **Speed** is 1×, 10× or Max. Max runs as fast as the browser can go.

A run stops at its end, at every speed. A scene without a run shows only the time.

When the window asks the native side to open OpenBot, the workbench shows the card "OpenBot opens here". In the real app, the setup window hands over to OpenBot's own page at this point. Press "Show the setup window" to close the card.

## Window settings

The Window panel sets how the frame looks:

- **Size**: two presets (1000 × 800 and 720 × 560), or any width and height. The minimum is 720 × 560.
- **OS**: Mac or Windows. This changes the frame (traffic lights or Windows title bar). It also changes the user agent of the window. Windows also sets the answers the Windows setup needs.
- **Active**: sets whether the window has focus. An inactive window has gray controls.
- **Theme**: Light or Dark.
- **Zoom**: from 0.5 to 2.
- **Grid**: draws a 4 px grid over the window. You can change the grid color.

When you move the pointer over the window, the inspector shows the box of the element, the gaps to its neighbors and the distance from the 4 px grid.

## Comment mode

Use Comment mode to write a change request for a coding agent.

1. Press the `C` key, or press the Comment button. The `C` key does nothing while the focus is in a text field.
2. Click one element, or drag over an area of the window.
3. Type your comment.
4. Press **Copy as prompt**.
5. Paste the prompt into your agent.

Press `Escape` or `C` to leave Comment mode.

The prompt is a Markdown message. It holds:

- Your comment.
- The scene, the time, the window settings and a link to the same frame.
- The `bun run workbench:shot` command that shoots the same frame.
- For one element: its label, its component, its box, its gaps, its distance from the grid, its main styles and its text.
- For an area: a table of the elements in it (first 30), and a summary of vertical gaps, font sizes and padding.
- A short list of what to do. It names the 4 px grid and the `openbot-copy` and `openbot-screen-layout` rules.

The component line names the React component and, when the workbench can find it, the source file and line. The workbench reads this from React internals and from source maps of the dev server. If it cannot find a component, the line is missing. The prompt then tells the agent to search the repo.

## Use a link

The address of the workbench holds all of its state:

| Parameter | Holds |
| --- | --- |
| `scene` | The scene id |
| `at` | The time in seconds |
| `w`, `h`, `os`, `active`, `theme`, `zoom`, `grid` | The window settings |
| `env` | The build settings (JSON) |
| `answers` | The command answers you set (JSON) |

Press **Copy link** in the Window panel to copy the address. Open it to get the same frame again.

If a parameter is bad, the workbench uses the default for it and shows a notice. The notice says what was wrong. For example, an unknown scene shows the first scene.

Answers that are scripts (code in a scene) are not kept in the link.

## Panels and warnings

Three panels fold open on the right:

- **Commands** sets the answer of any command. The modes are `value`, `never` (the call does not end), `fail` (the call fails with a problem) and `delay` (the answer comes after some milliseconds). The workbench keeps your answers in the link.
- **Calls** lists every native call, newest first. A call to a command that is not in `src/fakeNative/registry.ts` shows "Not in the registry".
- **Events** sends any event to the window. You pick the event and edit its JSON payload.

Under the window, the workbench lists layout warnings as the clock moves. A warning is one of these:

- **moved**: an element moved more than 2 px between two states.
- **cut off**: the content of an element is clipped.
- **outside the window**: an element goes past the edge of the window.

Click a warning to seek to its time.

## Run the CLI

Agents use `workbench:shot` to get a picture and a report of a frame. It does not need you to start the server. It uses a server on port 3021 (or `WORKBENCH_PORT`) if one runs. If not, it starts one and stops it at the end.

```sh
cd desktop
bun run workbench:shot <scene> [--at <seconds>] [--grid] [--size <w>x<h>] \
  [--os mac|windows] [--theme light|dark] [--out <dir>] [--all]
```

| Flag | Meaning |
| --- | --- |
| `<scene>` | The scene id, for example `install-mac` |
| `--at` | The time in seconds. The default is `0` |
| `--grid` | Draw the 4 px grid |
| `--size` | The window size, for example `1000x800` |
| `--os`, `--theme` | The OS frame and the theme |
| `--out` | The output folder. The default is `workbench-shots/` (not tracked by git) |
| `--all` | Shoot every scene at its end and at each run step |

For each shot, the CLI writes two files:

- `<out>/<scene>@<at>s.png` is the window with its frame.
- `<out>/<scene>@<at>s.json` holds `{ scene, at, window, handedOver, elements, warnings, calls }`.

Exit codes:

- `0`: the shots are saved. Warnings do not change this. Read `warnings` in the JSON.
- `2`: the scene is unknown or a flag is bad.

## Add a scene

Add a scene to change what the window shows or to play a new run.

1. Write a `Scene` in `scenes/install.ts`, or in a new file under `scenes/`.
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

- `registry.ts` lists every command and event the window uses.
- `control.ts` keeps the answers, the call log and the events. It lives on `globalThis.__workbench`.
- `states.ts` gives the answers for each state of the window.

The workbench page holds the window in an iframe (`WindowFrame.tsx`). The iframe loads `frame.html`. `frameBoot.ts` runs before the window's own code. It installs the page clock, sets the user agent, sets the answers and the theme, and starts the run.

The page clock (`clock.ts`) replaces `Date`, `setTimeout`, `setInterval` and `performance.now` in the iframe. Time moves only when the workbench says so. This makes every frame repeatable. A seek forward runs the clock in steps of at most 500 ms, and it stops at each run step. In this way every timer and every step runs in order, and the window can draw between them. A seek back loads the window again and plays forward to the new time.

Nothing of the workbench goes into the shipped build. `shippedBuild.test.ts` builds the app and fails if the output holds `__workbench` or `fakeNative`.

## Tests

Run these commands in the `desktop` folder:

```sh
bun test workbench src/fakeNative
bun run typecheck
```

The browser tests drive a real browser. They need `OPENBOT_APP_BROWSER=1`:

```sh
OPENBOT_APP_BROWSER=1 bun test workbench/determinism.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/layoutWatch.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test workbench/shot.browser.test.ts
OPENBOT_APP_BROWSER=1 bun test src/setupLayout.browser.test.ts
```

`shippedBuild.test.ts` runs a full build. It takes up to three minutes.
