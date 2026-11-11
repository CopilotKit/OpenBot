# Changelog

What changed, for somebody deciding whether to upgrade. Written for the person running OpenBot, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## Unreleased

**Before upgrading.** No migrations run in this release: the database stays at
`0088_approval_reviewer_guidance`, and a 1.0.1 database is used as it is. Upgrading from 1.0.0 or
0.3.x runs the migrations listed under 1.0.1, and a database that has run them does not go back:
restore the backup taken before the upgrade instead. Three things change for an existing OpenBot
Desktop installation:
- On Windows OpenBot now always runs in a Podman machine of its own, `openbot`, beside any of
  yours, and on a Mac it does when yours is rootless, after asking to pause it (below). An
  installation that ran in a machine of yours starts fresh in `openbot`, and its earlier data stays
  in your machine.
- At setup and at every Start, a Docker Desktop or Podman too old to run OpenBot is updated
  (below). Docker Desktop quits while it updates, which stops its containers; the ones that were
  running are started again afterwards.
- OpenBot Desktop's bundled CLI moves to `copilotkit@2e1c519` (below). The back end stays on
  CopilotKit Intelligence 0.16.0-rc.10.

### OpenBot Desktop

- **OpenBot uses its own Podman machine when yours can't run it, and leaves yours as it is.** A
  Podman machine made with `podman machine init` is rootless, and OpenBot used it and stopped at
  "Change this computer's setup" because local Intelligence needs rootful Podman. On Windows even a
  rootful machine of yours left chat unable to reach OpenBot's back end. OpenBot now makes and uses
  its own rootful machine, `openbot`, as on a computer with none. On Windows it runs beside yours,
  which keeps running untouched, and never takes Docker's default pipe (`docker_engine`), so your
  Docker tools and Docker Desktop keep reaching what they did. On a Mac, where Podman runs one
  machine at a time, OpenBot asks before it pauses your rootless machine while it runs (**Pause my
  Podman**), and Quit starts yours again with its containers. Docker, and a rootful machine of
  yours on a Mac, are used as before. Your default Podman connection is never changed. An
  installation that ran in your own machine starts fresh in `openbot`; its old data stays in your
  machine.
- **OpenBot updates Docker Desktop or Podman when it is too old to run OpenBot.** A computer with
  Docker Desktop 4.27 got through setup and then stopped at Start with "Compose config exited with
  exit status: 15", an error nobody could act on. OpenBot now checks the engine at setup and at
  every Start, before Compose reads anything, and updates one that is too old for you: Docker
  Compose before 2.27.2 (Docker Desktop before 4.32), or Podman before 6.1. Docker Desktop's update
  comes from Docker's own update feed, is checked against Docker's checksums and signature, and
  installs over the one you have, keeping its images, containers and volumes; the containers that
  were running before are started again once it is back. Podman's is OpenBot's own pinned
  installer over the old one, and every Podman machine that was running before, yours included, is
  running afterwards with its containers. A Mac asks for your password, and an all-users Docker
  Desktop on Windows for Windows' approval. The row for what's installing in the background says
  why it is updating and shows the update's own lines in full, and the Account step waits for the
  update and says so. Where an update can't be done for you, such as a Mac or PC too old for the
  newest Docker Desktop, or an Intel Mac with an old Podman (Podman publishes its Mac package for
  Apple silicon only), one plain step says what to do. Separately, the Compose file now starts on
  an older Compose too: with no harness Bot picked, Compose 2.25 and older refused the whole
  project.
- **A Podman machine that stops answering is restarted.** A Podman machine OpenBot uses that had
  lost its Docker API failed setup and Start until you restarted it yourself, and Quit could not
  stop the back end, so the next launch said "OpenBot had trouble shutting down last time." At every
  check, including Start and Retry after a relaunch, and before Stop and Quit, such a machine is now
  stopped and started once, your default machine included. A failure while setup runs behind the
  Account step now has Try again.
- **Start says in the log what it is waiting on, and why it gave up.** A Start that waited five
  minutes for OpenBot's services and then said "OpenBot didn't get ready in time" left nothing in
  the log in between. Each wait now writes what it asked (the address or the back end's status),
  each new answer and the same one again once a minute, and why it ended, with how long it took and
  the last answer.
- **The big downloads start on the first screen, before you click Install.** Nothing used to
  download until Install, and then one thing at a time: on a new Mac, Podman, then the 937 MB
  engine image with no progress shown, then 1.1 GB of OpenBot's software. Now the engine image,
  Podman's installer, the deployment and, when Docker or Podman already runs, OpenBot's software
  start downloading as soon as the first screen shows, side by side, while you sign in and enter
  your Mac password. The first screen says how far they are ("Downloading OpenBot. About 3 minutes
  left.", with the bytes under a bar), and the row for what's installing in the background carries
  on with it. A download stopped by quitting carries on from where it stopped next time,
  and every file is checked against its pinned digest before it is used. Podman builds its machine
  from the downloaded image instead of fetching its own. With less free disk than OpenBot needs,
  the first screen says how much is free and how much is needed, and the downloads start once
  there is room. Nothing is installed before you are asked.
- **OpenBot's own software downloads on the first screen too, before there is anything to run it.**
  On a new Mac or PC, or with Docker Desktop not running, OpenBot's images (about 1.1 GB for the
  default Bot) waited for the engine to start, then downloaded behind it. They now download from
  the first screen with everything else, into the same cache, checked against their digests and
  carried on after a quit. Once the engine answers, Install loads them into it, so the step after
  it no longer downloads them. Anything that didn't download or load is downloaded then, as before.
- **An update downloads before you click Update.** As soon as a new version of OpenBot is out,
  OpenBot Desktop downloads what it runs in the background while you keep working: the parts for
  the Bots you use, and the back end's when it changes too, kept until you update. Clicking Update
  then stops OpenBot, backs it up, updates it and starts it again, with nothing big left to
  download. The update offer, Settings › This computer and the setup window say the new version
  "is downloading in the background (40%).", then that it "is ready to install. It takes a few
  minutes." It downloads one part at a time, waits while OpenBot starts, stops or updates, never
  stops or restarts anything you are using, and downloads nothing when the disk is short of room
  (the Desktop log says why, and the update downloads as before). Candidates and internal builds,
  which do not update themselves, download nothing ahead.
- **downloads.copilotkit.ai serves each release's `desktop-images.json`.** It answered 403, so the
  list of a release's images could only come from GitHub.
- **The Status window, Settings > This computer and the Install step say what's running in plain
  words.** The Status window, opened from the menu bar or the system tray, and Settings > This
  computer said "Back end", "Container engine", "Podman" or "Docker" and the build's commit and
  time. Both now name each part by what it does: App, OpenBot's services, and Software OpenBot runs
  on, with "App and Bots" for what was "Front end and Bots". They show the version on its own, and
  the engine, the build and Docker's container names stay in Copy diagnostics and the logs. A
  stopped app on This computer says it isn't using memory, where it said its memory couldn't be
  measured. On the Install step, the rest of OpenBot downloads alongside OpenBot's own download,
  and both said they were in progress at once ("Step 2 of 4" and "Step 3 of 4"). The step now shows
  one step at a time: the rest of OpenBot is step 3, shown once step 2 is done, as far along as it
  got meanwhile.
- **Windows setup no longer opens Microsoft's "Welcome to Windows Subsystem for Linux" window, and
  the installer asks plainly to close a running OpenBot.** The welcome window opened partway
  through setup, the first time OpenBot's Podman machine was made on a computer with no Linux
  distribution. It isn't OpenBot's and isn't needed, so OpenBot now marks it as already seen for
  you before it makes the machine. Installing over a running OpenBot said "OpenBot is running!
  Click OK to kill it". It now says "OpenBot is open. Click OK to close it and continue."
- **OpenBot stays behind your browser while you sign in, and opens where you left it.** On
  Windows, OpenBot came in front of the browser partway through setup while you were typing your
  email to sign in. While the browser sign-in is open it now stays where it is, and comes forward
  once when the sign-in ends, since the license agreement is next (flashing in the taskbar if
  Windows won't bring it forward). A reopened window showed blank at Windows' default place for a
  moment and then jumped to where you left it; it now opens at its saved size and place from the
  first frame, and in the middle of the main screen when the screen it was on is gone.
- **The Account step leads with OpenBot.** Its header reads "OpenBot by CopilotKit" and its
  heading "Self-contained OpenBot". It says this version of OpenBot runs self-contained on this
  computer and needs a free license key, and that your conversations and files stay on this
  computer. The button reads "Sign in for a free local license key", and CopilotKit's logo no
  longer heads the step.
- **Setup says OpenBot, not CopilotKit.** Signing in, the license agreement and the usage-data
  notice named CopilotKit on its own: "Sign in to CopilotKit", "Checking your CopilotKit
  account…", "accept the CopilotKit license agreement", "OpenBot sends CopilotKit usage data". They
  now say OpenBot ("Sign in to OpenBot", "your OpenBot account"), and "OpenBot by CopilotKit" where
  the company is named: the license agreement, what signing in sends, and the copyright in the
  Windows installer and the Mac About box. The sign-in a stopped setup asks for is headed by
  OpenBot by CopilotKit instead of CopilotKit's logo, and Settings > General > Share usage data
  says the same as the first screen.
- **Usage data also says when setup looks stuck, or its window stops answering.** A hang is not a
  failure, so `setup_failed` never said it. A step of the back end's setup or update, OpenBot's own
  start, or OpenBot updating itself that runs three times as long as it usually takes, and two
  minutes over at least, now sends one `setup_stalled` with the step, its usual time and how long it
  has run. A setup window that stops taking what OpenBot sends it for over 30 seconds while it is on
  screen (as one did on Windows until a click or Alt+Tab) sends one `ui_stalled` with how long it
  lasted, and the Desktop log says `[ui] the window stopped answering for 42s during
  start_machine`. Minimised, hidden or covered windows never count. Step names and seconds only,
  and nothing at all when usage data is off.
- **A CopilotKit back end set up in your home folder no longer takes over OpenBot's.** Someone who
  once ran `copilotkit local setup` in their home folder, or any folder above `~/OpenBot`, had that
  back end resumed for OpenBot: the CLI looks for a back end in the folder it runs in and in every
  folder above it. It then wrote OpenBot's connection settings into that folder's `.env`, and Start
  stopped with "The connection settings do not match the backend that was set up". OpenBot now
  tells the CLI to use exactly `~/OpenBot`, so it sets up a back end of its own and connects
  `~/OpenBot/.env`, and the other folder's back end and `.env` are left alone. OpenBot also counts
  a back end as its own, to stop with Stop and Quit, only when the CLI records it for `~/OpenBot`;
  one it was handed for another folder is never stopped.
- **Connecting the back end a second time no longer stops setup.** Setup Retry, going Back and
  forward through setup, and reinstalling over an existing install connect `~/OpenBot` to its back
  end again. After the first connection OpenBot writes the back end's addresses at `127.0.0.1`
  where the CLI wrote `localhost`, and the CLI then refused every later connection with "App
  settings changed after connection was planned", so setup could not finish. The CLI now treats
  `localhost`, `127.0.0.1` and `[::1]` with the same port as the same address, connects again, and
  leaves OpenBot's addresses as they are. An address changed to another port or host is still
  refused.
- **CopilotKit CLI `copilotkit@2e1c519`.** OpenBot Desktop's bundled CLI moves to the production
  build of Intelligence `2e1c51900`: `6bfaa0f5c`, which added `telemetry link`, with `--app-path`
  added to its `local` commands and a second `local connect` accepted after OpenBot rewrote its
  addresses to `127.0.0.1`. It keeps Intelligence 0.16.0-rc.10 and CopilotKit v1.85.0 templates.

### Conversations

- **A new conversation's first message starts one run.** Every first message started a second run
  on the Bot about a second after yours: the CopilotKit runtime named the new conversation by
  running the same Bot again on a title prompt. On a Bot OpenBot runs in a harness, such as the
  Personal Assistant, that was two runs at once, and where they overlapped the answer could come
  back garbled. The runtime no longer names conversations. OpenBot still titles them itself, as
  before, so the sidebar is unchanged, and no model run nobody asked for is spent on each new
  conversation.
- **A Bot draws a chart or a table only from results it has read, and a form stops at the first
  field that fails.** A model that calls tools in parallel, such as Claude Opus, asked for its
  searches and the chart and table meant to show them in one step, so they were drawn with figures
  it hadn't read, and it then said so under them. A chart, table, card or approval asked for in the
  same step as another tool is no longer shown, not even for a moment, and the Bot draws it again
  from the results. One on its own, or beside other components, draws as before. A Bot's computer
  actions in one step run one at a time, in the order asked for, and stop at the first that fails:
  the rest are reported to the Bot as not run, and it looks at the page again. Every Bot is told to
  batch only tool calls that don't depend on each other. This follows Anthropic's guidance for
  parallel tool use and holds whichever model a Bot runs on, in conversations and in routines.
- **A Claude Agent SDK Bot answers the first question of a conversation however many apps it
  holds.** Asked one question, a Personal Assistant on the Claude Agent SDK searched the web and
  Notion and then stopped with "Claude turned down the request because this conversation is too
  long for the model". The harness's Claude Code did not know the Claude 5.5 models and held them to
  a 200K window (they have 1M), and it sent every one of the Bot's app tools' definitions with every
  request, which took a Bot holding a few apps most of the way there before any result came back.
  The provider's window now decides, the Bot looks its app tools up when it needs them (about a
  fifth of the size for 128 tools), no tool result is replayed longer than 100,000 characters, and a
  turn the model still refuses as too long is tried once more with every tool result cut to its
  start, each saying how to ask for the rest. A built-in Bot on a Claude plan gets the same window
  and limits. The message still appears for a conversation that really is too long.
- **Talk to OpenBot without a transcription provider.** The message box shows a microphone on
  every OpenBot, not only where `TRANSCRIPTION_PROVIDER` is set. Click it and your words appear in
  the box as you speak; the microphone turns into Stop. Stop, or Enter, stops listening and keeps
  the words in the box without sending them, and the next Enter sends. Typing while it listens
  stops it too. In OpenBot Desktop the words come from your computer's own speech recognition, on
  the device (Apple's Speech framework on a Mac, the Windows speech recognizer on Windows), and a
  Mac asks once for the microphone and speech recognition. In a browser they come from the
  browser's speech recognition, and a browser without one (Firefox) shows no microphone. Chrome's
  speech recognition sends the audio to Google's speech service. With `TRANSCRIPTION_PROVIDER` set
  nothing changes: OpenBot records and your server transcribes, as before.
- **Picking a model closes the picker and puts you back in the message box.** The model picker
  stayed open after a model was picked, so the next click, meant for the message box, could land
  on another model in the list. Picking a model now closes the picker and puts the cursor in the
  message box. A model with thinking levels keeps the picker open on its levels alone, with the
  other models and the search gone, and picking a level closes it.

### Smaller changes

- "Backend" is one word everywhere OpenBot shows it: OpenBot Desktop's Status window, tray and
  messages, the app, the server's messages and the Recorder. Desktop's Status window heads its card
  "Backend" where it said "Back end".
- The Personal Assistant on a framework picked in setup reads "Everyday life agent. (powered by a
  LangChain agent; you can bring your own agent from any stack.)" under its name (with its own
  framework's name), on a new install and on an existing one that kept "Powered by LangChain
  (LangGraph)" after an upgrade. Any other Bot OpenBot subtitled under LangChain's earlier names
  reads "Powered by LangChain". Only what a person sees changes: nothing stored changes, a Bot is
  told its subtitle as before, and words a person wrote stay theirs. A Bot's page shows a long
  subtitle on up to three lines.
- The "Always ask before making changes" switch is called "Extra vigilant", on Welcome, in
  Settings → Approvals and on a Bot's Tools section in the personal edition. Its description,
  behaviour and default are unchanged.
- Welcome's permissions section is shorter: "Choose when Bots ask", one sentence saying Bots ask
  before they delete, send, share, post or pay in your apps or on websites, the Extra vigilant
  switch, and where to change it later. Allowing an action always, passwords and a Bot's own
  workspace are still explained in Settings → Approvals.
- In the dark theme, the Bot's orb at the top of a conversation no longer has a light ring around
  it or its pattern showing through it, and its glow is no longer cut off at the edge of the
  conversation.
- In OpenBot Desktop's setup, the row for what's installing in the background keeps one height
  whatever it says, so the step's button under it (such as Continue on the AI step) no longer moves
  up and back on its own.
- OpenBot and OpenBot for Business carry a small trademark sign (™) where they stand as a brand:
  the name beside the logo in the sidebar and in each skin, the onboarding header, the OpenBot for
  Business title and menu entry, and the OpenBot Desktop setup window. Mentions in sentences stay
  plain, a deployment with its own product name shows none, and screen readers read the name once.

## 1.0.1

**Before upgrading.** Three migrations run at start, and the database moves to
`0088_approval_reviewer_guidance`. `0086_channel_title` adds a nullable `title` column to
`channels`, for a name a person gives a conversation. `0087_approval_conversation_grants` creates a
new, empty `approval_conversation_grants` table, which records an action allowed for the rest of
one conversation. It also adds a nullable `kind` column to `approval_rules` and an `action_kinds`
column to `approval_team_settings` (`{}` on every existing row), and lets
`approval_requests.decision` hold `allow_conversation` as well as its earlier values. `0088_approval_reviewer_guidance` adds a
nullable `reviewer_guidance` column to `approval_team_settings`. No existing row is rewritten and
nothing is dropped. A database that has run this release does not go back to 1.0.0: restore the
backup taken before the upgrade instead. Three things change for an existing deployment:
- Sending, deleting, sharing and posting offer **Allow for this conversation** and **Always allow
  here** beside Allow once and Deny, and paying and account-setting changes ask with the same four
  answers instead of being handed to you (below). In the team edition an admin can set each kind
  to ask every time in Admin > Approvals.
- A Personal Assistant whose instructions nobody changed takes the new ones at the next start
  (below). One whose instructions were edited keeps them.
- OpenBot Desktop's bundled CLI moves to `copilotkit@6bfaa0f`, and Start writes
  `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` in `~/OpenBot/.env` as empty (below). The back end stays
  on CopilotKit Intelligence 0.16.0-rc.10.

### OpenBot Desktop

- **Setup says what it's doing in plain words, and what's installing behind every step.** The
  setup window said "Preparing the engine machine", "Installing Podman", "Waiting for the back end"
  and "Updating the back end to 0.16.0-rc.10", and a tester waiting on the first step couldn't tell
  whether it was stuck. Each line now says what OpenBot is doing for you ("Preparing this computer
  to run OpenBot. This takes a few minutes the first time.", "Getting OpenBot ready", "Updating
  OpenBot"), and the Desktop log keeps the technical detail beside it. The Account and AI steps
  show one row for the install running behind them: what it's doing, step N of 4, the time so far,
  and the time left while it downloads. That row has its own slot under the step's form, so the AI
  step's fields no longer jump when a download starts or ends, and the window no longer grows or
  moves. When setup, a start or an update stops, the card says what happened and what to do in the
  same plain words ("OpenBot has 30 GB of free disk. It needs 40 GB. Free up space on drive C:,
  then Retry."), with the engine's own output under Technical details and in the logs you can
  copy. Docker Desktop and Podman are named only where you act in them. The Start screen no longer
  sits on "Waiting for the back end · 13s elapsed" for minutes: one journey over the whole start
  says what is happening now ("Starting OpenBot's services", "Updating your data", "Downloading
  the update · 300.0 MB of 900.0 MB"), with one bar that only moves forward and "About 2 minutes
  left" from how long each part measured on a real machine. A part that runs long slows the bar
  and says "Taking longer than usual, still working" instead of a wrong time, and a slow download
  no longer counts against the step it holds up. Updating OpenBot on Start says "Downloading the
  update" and "Installing the update" rather than a release name, its download's total no longer
  shrinks partway, and the card is held from the top, so nothing already on screen moves as rows
  and downloads come and go. The bar follows how long each part actually takes, so a long download
  is most of it and moves it, and the time left never jumps up. Once a download's bytes are in, its
  row says which part is unpacking ("Unpacking OpenBot (4 of 5)") under a bar that is never full
  while a part is left, with the time so far and the time left. Quit shows the same bar and time
  left. The window keeps the size and place it opened with, and a step taller than it scrolls
  inside its card; a reopened window comes back where it was. The license step links "Read the
  license agreement" without the agreement's id, and no step line shows a release name or the
  engine's own output.
- **A first install on a Mac starts the first time, and a reinstall sets its back end up again.**
  Three things a from-zero install of 1.0.0 hit on a Mac with Docker Desktop:
  - The first Start could stop with "Something went wrong" because Docker Desktop refused the
    sign-in folder OpenBot had made a moment before (`invalid mount config for type "bind" ...
    operation not permitted`). Retry worked seconds later. Install now makes that folder, and
    Start waits and tries again for up to 15 seconds on exactly that refusal. Every other error
    still stops Start at once.
  - After the earlier installation's folder and back end were deleted, the AI step said "Back end
    setup stopped" every time: the CopilotKit CLI still recorded a back end for `~/OpenBot` whose
    private files were gone. OpenBot now has the CLI forget that back end and sets one up from the
    start. A back end whose files are damaged, or that another app also uses, is kept, and OpenBot
    says which folder to restore or delete.
  - An app copied into Applications without Finder (with `ditto` or `cp`) runs from a temporary
    copy, and the Recorder said "Move OpenBot Desktop to Applications" though it was there. The
    Recorder now uses the app's real place in Applications.
- **Usage data now says why setup stopped.** A failed `local setup`, every failed install or
  Start (a failed `compose up` among them), a failed `local start`, `local connect` or Learning
  model setup, and an Account step that stops on an engine too small or one local setup does not
  run on each send one `setup_failed`, with the step that failed, a reason class, the CLI's own
  reason, and for an engine too small its CPUs, memory and disk against what setup needs. The
  Account step's sign-in sends when it starts and whether it completed, failed or was cancelled.
  The app version keeps a release candidate's label (`1.0.0-rc.5`, not `1.0.0`). Only closed values
  and numbers are sent, and nothing at all when usage data is off.
- **Sign-in comes first, and macOS asks for your password only after OpenBot says why.** On a new
  Mac the Account step waited for Install to put Podman in before any browser sign-in opened, and
  the "osascript wants to make changes" password box came up by itself over it. The CopilotKit
  sign-in now opens in your browser as soon as the Account step opens: the CLI's sign-in needs no
  engine, and only the license agreement waits for one. Podman downloads meanwhile. Before macOS
  asks, the step says "Your Mac will ask for your password so OpenBot can install what it needs to
  run.", and the password box comes up by itself a moment later, with no button to press first.
  It now says "OpenBot needs your password to install the software it runs on." Closing it
  without a password says plainly that OpenBot needs it and asks again by itself, or at once with
  Try again, instead of stopping Install. On Windows, turning on Windows Subsystem for Linux starts
  by itself the same way; the restart after it still waits for you, so you don't lose unsaved work.
- **A back end update that was stopped partway no longer breaks every later Start.** Quitting
  while the back end updated could leave it half updated, and every Start after that failed with
  "Local update-quiesce failed (exit 1)". OpenBot now lets an update finish once it has begun
  changing the back end ("Finishing the OpenBot update" on the Shutting down screen), repairs a
  back end an earlier update left half done, rolls back one Helm left mid-upgrade, uncordons a
  back end node left unschedulable, and tries the update once more. While it runs, the Start
  screen says what it is doing and how long is left, and a failed part of the update is said as
  soon as it fails. A failed update says where it stopped, and that your data is kept.
- **The Account step says when it is waiting for Install to set up the engine.** On a new Mac it
  said "Checking your CopilotKit account…" for minutes while Install put Podman in, because the
  license agreement check needs a running engine. It now says "You're signed in. OpenBot is setting
  up the software it runs on. The license agreement comes next.", with what Install is doing
  ("Downloading Podman.", "Preparing the engine machine.", "Starting the engine machine."). The
  desktop log says each change once as `[account]`: what the CLI's preflight answered, the install
  step, how long the wait took and what the sign-in check answered, and how long the browser
  sign-in took.
- **Connecting an app from OpenBot Desktop brings you back to OpenBot Desktop.** The app's sign-in
  opens in your browser, and when it finished, the browser showed OpenBot in a new tab while the
  window behind it still had the app as not connected. The browser now shows a short "Back to
  OpenBot" page, which records the account and opens the Desktop window where you left it. An app's
  page in the window checks the account again when the window is back in front. Apps that sign in
  through Arcade, or by their own sign-in page, still return to the browser tab.
- **On a Mac, the window's buttons share a row with OpenBot's name and +.** The sidebar's header
  started below the close, minimise and zoom buttons, under an empty strip. The buttons now sit 20pt
  in and level with the header's first row, and the name and + start just to their right.
  With the sidebar hidden, the page starts below them, and so does onboarding.
- **Check for Updates… on the Mac answers with OpenBot's icon.** "OpenBot is up to date", the offer
  of a newer version, and "couldn't check" or "couldn't install" showed the system's grey note icon,
  because the alert was drawn by macOS rather than by OpenBot. They are now OpenBot's own alerts.
- **OpenBot Desktop says it sends usage data, and Settings turns it off.** The first setup screen
  now says that OpenBot sends CopilotKit usage data linked to your CopilotKit account, that it never
  sends your conversations, files or keys, and links what it sends (`desktop/TELEMETRY.md`). Earlier
  releases sent it with no notice. Settings > General > Privacy has Share usage data: off is the
  same opt-out as `COPILOTKIT_TELEMETRY_DISABLED=1`, kept for every later launch. The desktop app's
  own usage data and the CLI's stop at once, and the server's the next time OpenBot starts. With
  `COPILOTKIT_TELEMETRY_DISABLED` or `DO_NOT_TRACK` set at launch the switch shows off and cannot be
  turned on.
- **Desktop usage data is linked to the CopilotKit account.** After you sign in, OpenBot Desktop
  links its installation ID to your CopilotKit account through the bundled CLI's
  `telemetry link`, so setup and runtime usage count as one person. It sends an opaque account
  fingerprint, never an email, name or credential, and only for the personal edition; Enterprise
  and team deployments are unchanged. The server receives the installation ID when OpenBot starts.
  Signing in and Start never wait for the link, and nothing about it can keep OpenBot from
  starting.
- **CopilotKit CLI `copilotkit@6bfaa0f`.** OpenBot Desktop's bundled CLI moves to the production
  build of Intelligence `6bfaa0f5c`, which adds `telemetry link`. It keeps Intelligence
  0.16.0-rc.10 and CopilotKit v1.85.0 templates.
- **A Learning container left in `~/OpenBot/.env` by an earlier setup no longer fails every
  message.** A folder set up against hosted Intelligence kept
  `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID="openbot"`, which the local back end did not have, so every
  message failed with "Failed to initialize thread" (or "Failed to resolve Learning Container").
  Start now writes that setting itself, empty, in place of any other line for it. The server also
  checks a named container at start: one its Intelligence does not have is logged as
  `configured_absent`, naming the variable and its value, and ignored, and a container is assigned
  automatically as though none was named. A chat whose first message failed this way works when sent
  to again.
- **A saved Learning container the current back end does not have no longer fails every message
  either.** A default container saved while OpenBot used hosted Intelligence still won after it
  switched to the local one, which has no such container. The server now checks the saved container
  at start: one its Intelligence does not have is logged as `saved_absent`, naming it, and ignored
  there, and a container is assigned automatically in its place. The saved choice is kept, not
  cleared, so pointing OpenBot back at the Intelligence it was chosen on uses it again; Admin shows
  the container actually in use.
- **Settings shows which AI OpenBot uses, and changes it.** Settings > General has an AI model
  section in OpenBot Desktop: the provider and how OpenBot signs in to it (a Claude or ChatGPT plan,
  an API key, a Google or xAI account, or your own address), and the model when setup named one.
  Never the key. Change AI connection stops OpenBot and opens the setup window at its AI screen,
  and OpenBot starts again with the new choice.
- **The window zooms, as a browser does.** The text was too small and nothing made it bigger.
  Command (Ctrl on Windows) with + or = zooms in, with - zooms out, and with 0 goes back to actual
  size, from 90% to 200%. On a Mac the View menu has Zoom In, Zoom Out and Actual Size. The level
  applies to every window, from setup to OpenBot itself, and is kept for the next launch.
- **Troubleshooting logs in one click.** Every setup failure, the Status window, and a new Get
  Troubleshooting Logs… item in the OpenBot menu and the tray now offer Copy logs and Save to a
  file. Both give one block of text: the version and build, the system, what failed, the container
  engine's version and disk use, its CPUs, memory and free disk as the back end's engine check
  measures them, and the end of OpenBot Desktop's log and the back end CLI's log
  (`~/.copilotkit/cli.log`). Keys, tokens, passwords (quoted `.env` values too) and email addresses
  are removed, along with account, organisation, user, subject and installation ids, and the home
  folder is written as `~`. The card suggests pasting the logs into the AI assistant you use and
  says what was taken out. Saved files go in the log folder as `openbot-troubleshooting-<time>.txt`.
- **Docker Desktop 29 pulls OpenBot's images from downloads.copilotkit.ai.** Its pulls there
  failed with 403 and went to GitHub, because the copy held only each image's Linux amd64 and arm64
  manifests, and Docker 29 also fetches the image's attestations and asks which artifacts refer to
  it. The copy now holds every manifest each image names, and answers that question with an empty
  list.
- **A release candidate's images are on downloads.copilotkit.ai too.** A fresh install of a
  candidate got 403 there for every image, because only the Latest stable release was copied.
  Downloads sync now copies a prerelease asked for by tag (its images and its own files, never
  `latest/`), and each scheduled run copies the images of every prerelease newer than Latest from
  the last 30 days. Drafts are never copied.
- **A back end start that fails on a nearly full disk says so, with the numbers.** Relaunching a
  used install whose back end's disk was nearly full said only "The back end stopped with an error
  partway through." Each start, update and setup now checks the engine first and logs what it has
  as `[local check]`, and a start that fails is checked again with the back end asked whether it is
  short of disk. The card then says, for example, "The back end's disk is nearly full. Podman has
  30.5 GB free of 1006.8 GB. OpenBot needs 40 GB. Free space on the drive that holds OpenBot's
  engine (C:), then Retry." On Windows, free disk is measured on that drive, which can run out
  while the machine itself shows hundreds of GB free, and the card never suggests
  `podman machine set`, which WSL machines refuse. In the few minutes after space was freed, while
  the back end still reports low disk, a start that fails, or a Retry that finds the back end
  running but not healthy, says "The back end is recovering from low disk space. Wait a few
  minutes, then Retry." where Retry said "The back end is running but not healthy."
- **An engine the back end doesn't run on is said at once on the Account step.** On a Mac whose
  Docker is another engine, such as OrbStack, the step checked again every 2 seconds for 15
  minutes, then said only "Couldn't check your CopilotKit account." It now says straight away what
  the back end needs, in its own words ("Docker Desktop or rootful Podman is required on macOS.
  This machine runs OrbStack."), with how to switch to Docker Desktop (`docker context use
  desktop-linux`) or Podman, and Try again. Only an engine that isn't running yet is waited for.
  The engine check before it (`docker info`, `docker image ls` and the container that measures
  free disk) now gives up on a command after 15 to 20 seconds, so an engine that stops answering
  no longer leaves the step on "Checking your CopilotKit account…" for good.
- **A file dropped on a conversation attaches.** Dragging a file, such as a screenshot, onto a
  conversation in OpenBot Desktop showed a plus cursor and attached nothing, because the window
  took the drop for itself. The conversation now takes it, as it does in a browser. A drop the
  window can't read says "Dropped file: couldn't be attached. Attach it with + instead."

### Conversations

- **Rename a conversation you started.** Its menu in the sidebar has **Rename conversation…**.
  Everyone in the conversation sees the new name, and an empty name brings back the one OpenBot
  chose. Only the person who started a conversation can rename it.
- **Allow a send, or anything else that asks, for the rest of a conversation.** Approving every
  message in a back-and-forth on Slack was tiring, and sending, deleting, sharing and posting
  offered only Allow once and Deny. Those cards now offer **Allow for this conversation** and
  **Always allow here** too, and paying and account-setting changes now ask with the same four
  answers instead of being handed to you. Allowed for the conversation, the same action by the
  same Bot runs again there without a card, and the line above the message box says so, with Turn
  off. Every such call is still on the audit trail. Admins can set each kind to ask every time, or
  to be done by members themselves, in Admin > Approvals. A password changed on a website is still
  yours to do.
- **A Bot's lookups come back, even in a big batch.** A Bot that asks an app for many things at
  once now has at most 5 of them out at a time, and the rest wait their turn, so the app is not hit
  with a burst it answers with timeouts and rate limits. A lookup the Bot already made in the same
  run, with the same details, is answered from the first result, which says it was already
  fetched, instead of going to the app again. A lookup that times out or that the app turns away
  for the moment (too many requests, or its own server error) is tried twice more over a few
  seconds before the Bot hears of it. Anything that changes something in an app is never retried
  on its own, because it may already have happened. A step that did not run now always tells the
  Bot the same thing: what happened, and to run it again if it still needs it or say in its answer
  that it could not get it.
- **Coming back to a conversation while a Bot is part way through its lookups no longer loses
  them.** A Bot that sent 20 lookups at once, opened again while 9 were still running, showed only
  the 11 that had answered, and the next message told the Bot the other 9 had been "interrupted
  before it could answer", so it said they had failed and could not say why. The conversation now
  stays joined to the Bot's turn while it is still working, shows the rest of the answers and the
  reply as they come, and holds anything you type until the turn is over. A message sent from a
  conversation that still missed some answers takes them from the stored conversation first;
  only a lookup that truly never answered is said to have no result.
- **The Bots OpenBot ships do the work instead of asking about it.** The Personal Assistant was
  told to ask whenever something was ambiguous and to ask you to sign in and wait, so it stopped to
  ask about choices it could make and sent a sentence where it should have handed you the browser.
  It, General Assistant and Knowledge now take the step in the same reply, use what they already
  have before asking, ask only when a wrong guess would be hard to undo or only you know the
  answer, try a failed call once more, and end with what they could not confirm. A Personal
  Assistant whose instructions you never changed moves to the new ones on the next start; one you
  edited keeps yours. The ten Bots in `examples/fintech/catalog` now run on their rules: those lived
  in the description shown under each Bot's name, which a Bot that runs here is never given, so
  one copied in ran on its output format alone. Each now has a one-line
  description and keeps its rules in its instructions.
- **A Claude Agent SDK Bot keeps your request and its tool results through a long task.** A tool
  result over 50,000 characters (a page of email, an app's tool list, a file read from the Bot's
  computer) reached the Bot as a 2 KB preview and the path of a file it could not open, so it showed
  "Blocked: Read file /root/.claude/projects/…" and lost the result, here and in every later turn.
  And a few such results put the conversation over what the Bot replays each turn, which then left
  out its oldest messages, your request first: the Bot said it could no longer see the task. A
  result up to 100,000 characters now reaches the Bot whole, a larger one stays whole in the
  conversation and the Bot can open the saved copy during the turn, and the replay always keeps
  your first message, cutting the results of earlier turns before it leaves out any message.
- **A Bot whose whole answer is something it drew now raises its "replied" notification.**
- **A Bot that runs its own agent reads your Gmail and finds your Slack channels again.** Such a
  Bot, like the personal starter Bot, can be sent only some of an app's actions in one request, and
  they were picked by matching the words of your message. With Gmail connected it could be sent
  sending and settings actions and nothing that fetches a message, so it said it could not read your
  mail and that an administrator had to add a tool. On Slack it could read a conversation it had the
  id of but not find a channel or a DM by name. Each app's actions that read now come first,
  alongside the ones your message asks for, so a Bot can search, list and read messages, threads,
  channels and people. Sending and deleting still ask you first. In OpenBot Personal a Bot is also
  told plainly that every action an app offers is already its own.
- **A Bot calls you "you".** Its instructions call the user "the person", and a Bot said that back,
  such as "which the person didn't ask for". Every Bot is now told to write "you".
- **A Claude plan has a model picker in the conversation again.** Signed in with a Claude plan,
  the picker never showed, because the server asked Anthropic for the plan's models with
  OpenBot's own harness token instead of the plan's sign-in, Anthropic answered 401
  (`{"type":"model-list-unreadable","source":"claude","status":401}` in the server log), and only
  the default model was known. The list is now asked for with the plan's own token, and the
  harness token is never sent anywhere but the harness.
- **A Claude plan, or Grok signed in from the Desktop, has a model picker even when the provider
  won't list models for it.** Anthropic documents its model list for API keys, not for a Claude
  plan's sign-in, and xAI the same for the Grok sign-in. When either refused, only one model was
  known and the picker stayed hidden. A Claude plan now offers Claude Opus 5.5, Sonnet 5.5 and
  Haiku 5.5, on Sonnet 5.5 by default as with an Anthropic key, and runs the one picked; Grok
  offers Grok 4.7 and Grok 4.3, on the model the Desktop set up. The server log says
  `{"type":"model-list-fallback","source":"claude"}` when this applies. A refused list no longer
  tells OpenBot Desktop that the Grok or Google sign-in has lapsed.
- **A message that couldn't reach the back end says so in plain words.** The conversation showed
  the raw request failure in red, such as `REST run request failed: {"error":"Failed to resolve
  Learning Container"}`. It now says "OpenBot couldn't reach its back end, so your message wasn't
  sent. Try again, or quit and reopen OpenBot." The original text goes to the browser console.
- **A Bot fills a form in one pass.** A Bot checking its work read every field that shows a
  placeholder (such as "company.com" or "City, State") as empty, however often it had filled it,
  so it typed the same values in again and then asked you to type them yourself. It now reads what
  is in the field. And a Bot's browser takes its actions one at a time, in the order they arrived,
  on any number of server replicas: a model that calls tools in parallel, such as Claude Opus,
  sent a form's fields together through a LangGraph Bot, the fields took the focus from each
  other, and values landed in the wrong field. A LangGraph Bot now runs its browser calls in the
  order the model made them. An action that never finishes gives way to the next after
  `BROWSER_TURN_LIMIT_MS` (50 seconds by default), and one stopped while it waits never runs.
- **A budget a Bot draws is in colour, with a bar of how the total splits.** Amounts that add up to
  a total, such as the "Build a trip budget" starter task, draw as one card: each part in its own
  chart colour on its swatch, slider and slice of the bar, a box to type it, its share, and the
  total in large bold type, all updating as you edit. It was grey sliders or number boxes and a line
  of black text. In the dark theme, the frame around an interface a Bot draws has lost its bright
  border.
- **The words that say a Bot is working pulse slowly instead of flashing.** "Thinking", a running
  step such as "Drew an interface" and "Asking Ana…" now fade gently to a little over half strength
  and back every 2.4 seconds, where a quick band used to flicker across them. With reduced motion
  turned on they stay still.

### Routines

- **Routines in the sidebar, with New routine.** One Routines page lists every routine across your
  Bots: the Bot, what it does, its schedule in words, its next run, how the last one went, and
  whether it is on. **New routine** makes one without asking a Bot: the Bot, what to do, when
  (every day, weekday, week, month or hour, at a time on your clock), where it posts, and a name.
  The clock beside + in a conversation's message box opens it for that Bot and that conversation.
  A schedule the form doesn't cover, such as every other Tuesday, can still be asked of a Bot.
- **Routines and check-ins finish what they start.** A routine or check-in had chat's 8 steps. It
  now has 24, plus 4 for each part of a routine written as a list, up to 48. A routine written as a
  list shows the Bot its parts numbered, and the run carries on until each is closed as Done,
  Blocked or Skipped, with a reason. A Bot that ends a step on a promise ("I'll fetch the rest now")
  with no call after it is sent back to do it, at most twice in a row. On its last step a Bot is
  told its tools are off, so it answers with what it has and says what it did not get to.

### Admins write policy in plain English

Each of these works the same way. An admin writes a sentence, the deployment's own model turns it
into the setting, and the setting is checked. A second model call, which never sees the sentence,
says what the setting does, and the change is replayed over what this OpenBot has recorded. Nothing
is saved until the admin saves it. The save is on the audit trail with the sentence it was written
from ("Written from: …"), and each draft is recorded too. With no model configured, the screen says
a model key is needed.

- **Boundaries.** Add rule and a rule's own page have **Describe the rule**: "Bots may not visit
  social media sites" becomes a CEL rule, still editable, with what it does read back under it. A
  rule is now checked before it is saved, and one that can't be read is refused with what is wrong
  (`A rule can't check "mcp.sever". mcp has server, tool and effect.`). Rules already saved are not
  checked again, so a broken one can still be removed. The preview runs as the rule is typed, and
  replays app calls as well as computer actions, so a rule about an app, such as
  `mcp.server == "salesforce" && mcp.effect == "write"`, no longer previews as changing nothing.
  Every save of the boundaries is on Audit as "Boundaries saved", with the rules added and removed.
  The shipped "Stay off social media" template also stopped dropbox.com and netflix.com; it now
  stops only the sites it names.
- **Team approval rules.** Admin > Approvals > Team rules has **Describe it in words**. A sentence
  such as "Let the sales assistant update opportunities in Salesforce without asking" becomes rule
  rows, each checked against this OpenBot's real apps, tools and Bots, and replayed over past
  decisions: "Would have changed 4 decisions: removes 3 asks, of which 1 a person had denied; adds
  1 ask." Every team rule save now records the rules before and after.
- **A Bot's actions in one app.** On a Bot's page for an app (Admin > Plugins > the app > the Bot),
  a sentence such as "Reads everything and writes drafts, but never sends or deletes" and **Choose
  actions** pick the exact actions. The page shows which actions turn off and on, and how that
  compares with what the Bot did recently. Nothing changes until **Save changes**, and the switches
  still work one at a time.
- **Guidance for auto-review.** Admin > Approvals > **Guidance for auto-review** takes guidance for
  the AI reviewer, such as "Any change to a deal worth more than $100,000 needs a person to approve
  it." Guidance that would switch safety off or let everything through is refused. It can be tested
  first, by replaying the reviewer with it over up to the last 25 requests people allowed or denied
  (one model call each, said before it runs), to see where it agrees with them. Built-in safety
  still decides first.
- **Network allowlist.** The Network policy dialog (Admin > Computers > Network) opens with
  **Describe the allowlist**: "Only Salesforce and Google Workspace" becomes entries that include
  the domains those vendors publish for allowlisting. Each entry is checked by the parser the
  computer's network filter uses, and the list is replayed over recent page visits ("this list
  would block 3 that are allowed today"). Only page visits are recorded, so connections made from
  the shell or by a page itself are not counted. Fixed with it: saving a policy that held a domain
  with a port, such as `intranet.example 8443`, dropped the port and allowed every port.
- **Permissions.** Admin > Permissions has **Describe it in words**. "Contractors can't use their
  own computer" becomes the organization, role and group switches it takes, with every member's
  permissions before and after, and what anyone who loses one used it for in the last 30 days. The
  switches are saved together, as one change.
- **Ask the audit trail.** Audit has an Ask box. A question such as "Gmail changes by a routine last
  week" becomes filters, by app, tool, effect, action and rule, shown over the trail's own rows.
- **What would happen.** Admin > What happened > **What would happen** reads a question such as
  "Could the Sales Bot send an email from Gmail when a routine runs it?" as one action, shown as
  fields to correct. **Check** then runs OpenBot's own controls on it, with no model, in the order
  they apply, and shows each one's verdict, which one decides, and a link to where it is set. Every
  computer action and app call on Audit has **Why?**, which runs the same check on what the row
  recorded and says when today's settings would decide it differently.
- **Audit names the rule that stopped an action.** A blocked row reads "Stopped by: Bots may not
  visit social media sites" when the rule has a name, with the rule under it cut to two lines and
  **Show full rule** to read the rest. A long rule used to make one row hundreds of pixels tall.

### Smaller changes

- A page a Bot's browser couldn't open, or that a boundary refused, is one line in the conversation,
  such as "Blocked: Open x.com", where it was an empty grey box saying "This turn did not open a
  page."

- An interface a Bot draws in a card, such as the "Build a trip budget" starter task, has one frame
  in the conversation. It had a second border around the card, with a gap between the two.
- Onboarding's OpenBot for Business step says what OpenBot for Business is before it asks for a
  demo: work sign-in, Bots shared in Slack and Microsoft Teams, and the controls and audit trail,
  beside the picture of running OpenBot yourself that the step showed before. Book a demo then
  opens the calendar in the step, and its cookie banner no longer covers it.
- The sidebar is solid again, without the frosted glass and the orb's colours behind it, and the
  app is set in Inter again rather than Atkinson Hyperlegible Next. Inter now loads as the page's
  own font, where the page had asked for an installed Inter and so fell back to the system font on
  a computer without one. The page's background is its earlier shade, and OpenBot's name at the top
  of the sidebar highlights on hover again, without the orb beside it.
- New Bot's first screen is as it was before 1.0.0: the simple Bot's form, with **Connect a custom
  agent** opening the list of frameworks, in their earlier order. LangChain keeps its own name and
  mark.
- The OpenBot version sits to the right of your name at the foot of the sidebar, where it was a
  line under it.

### Personal edition

- **Adding an app in Browse apps signs you in to it.** Add on an app you sign in to, such as Slack,
  GitHub or Gmail, turned the row to "Added" and signed nobody in, so a Bot then said the app wasn't
  connected. Add now adds the app and opens its sign-in in a new tab, as a Bot's Connect card does.
  Add on an app that takes a key opens its page with the key form. In either edition, an app that
  is added and not signed in to reads **Not connected** beside **Connect** in Browse apps, on
  Connections and on the app's page, where it read "Added" or showed Connect alone. The team
  edition's Add is still the admin's act and reads "Added, not connected" until the admin connects
  their own account. GitHub on Connections no longer reads Connected off the GitHub sign-in alone
  while its tools are not connected.
- **Settings > Learning says Waiting for your review only when a skill is waiting.** With
  **Approve new skills automatically** on, the heading showed while Learning was in progress and
  after it finished, though nothing waited. The section is now **New skills** until a learned skill
  waits for approval, and the team edition's **Waiting for an admin** follows the same rule.

## 1.0.0

**Before upgrading.** Two migrations run at start, and the database moves to
`0085_approval_rule_account`. `0084_brokered_accounts` creates a new, empty `brokered_accounts`
table, which fills as people open an app's page in Connections. `0085_approval_rule_account` adds
a nullable `account` column to `approval_rules`. No existing row is rewritten or backfilled,
nothing is dropped and no existing constraint changes. A person's existing connection to an app is
untouched, and calls through it run as before. Going back to 1.0.0-rc.1 or 0.3.4 after people
connect more than one account of an app is not seamless: a rule saved for one account applies to
every account of that app, and Disconnect can leave an extra account connected at Arcade, so
restore the backup taken before the upgrade instead. Four things change for an existing
deployment:
- OpenBot Desktop updates its back end to CopilotKit Intelligence 0.16.0-rc.10 at the next Start,
  saying "Updating the back end to 0.16.0-rc.10. Its data stays." With it, a first back end setup
  downloads all of its images through downloads.copilotkit.ai first, where its own images came
  straight from ghcr.io and Docker Hub, and a setup step that fails reports its own error, which
  OpenBot's log keeps (below).
- The Helm chart's bundled back end (the `intelligence` subchart) is 0.16.0-rc.10, from rc.9.
- The first time anybody opens OpenBot in a browser or in OpenBot Desktop after the upgrade, every
  built-in component description nobody has edited takes this release's wording, so Bots read the
  new Notice, Checklist, Record, Headline figures, Data table, Bar chart, Donut chart and Progress
  against target descriptions (below). Until then, Bots keep the old wording. A component whose
  description an admin saved, or that an admin published or unpublished, on Admin → UI components
  keeps what they chose. Each change is one row in Admin → Audit, "Update a component's
  description", started by this deployment. In the personal edition every built-in description
  follows, and Activity leaves these rows out.
- On OpenBot Desktop, a Bot on LangChain that follows the installer has "Powered by LangChain
  (LangGraph)" in its subtitle changed to "Powered by LangChain" at the next Start, keeping the rest
  of the subtitle, and a Bot picked in setup before 0.3.3 and named "LangChain (LangGraph)" is
  renamed "LangChain". A Bot whose connection you set yourself keeps its subtitle.

### Apps and connections

- **Connect more than one account of an app.** Once an app is connected, its page in Connections,
  and Admin → Plugins for an admin's own account, offers **Connect another account**, on Composio
  and Arcade. Pressing Connect again used to be refused with "You already have an account connected
  to Gmail. Disconnect it first if you want to connect a different one." With several accounts the
  page lists each by its address, with **Make default** and a Disconnect that ends only that
  account. An app whose team account is shared still has one account.
- **A Bot can use the account a request is about.** It is told the addresses of your accounts at
  that app; with none named it uses your default, the first you connected until you pick another.
  A name that isn't one of your accounts is refused, and nothing is sent.
- **An approval names the account** ("Research Bot wants to send email from … on Gmail"), and Always
  allow here saves the rule for that account only, shown as "from" and the address under the rule.
  Once you connect a second account of an app, your own rules that let Bots act on that app without
  asking stop applying, so Bots ask again for each account. Rules that ask or hand off, and team
  rules, still cover every account.
- **Apps that need a key say so before you connect** (on Composio). In Browse apps, an app you
  connect with a key reads "Needs a key from 1Password", and apps you sign in to are listed first,
  where the list was by name alone. Its Connections tile says the same until it is connected, and
  its page says "Needs a key from 1Password. Connect shows where to get one.", where it said the app
  "connects with a key you already have".
- **The key form says where the key comes from.** Above the boxes, Connect says "1Password doesn't
  offer a sign-in here, so it connects with a key from your 1Password account.", what to do at the
  app, and **Get a key from 1Password**, which opens the app's own page, for 33 of the most-used key
  apps and any app whose listing publishes a link. Box labels read in plain words ("Access token"
  for "Bearer Token", "Web address" for "Base URL"), and help text that named Composio says
  OpenBot.

### OpenBot Desktop

- **A back end setup that stops says why.** OpenBot's log now records how every back end setup,
  start, update and stop ended: how long it took, its exit code, what its report says went wrong
  and the end of its error output. A setup that stopped used to leave nothing in the log. The card
  says whether the back end stopped with an error partway, quit without saying why, or could not
  be run, where all three said "The back end could not start."
- When OpenBot Desktop is signed in with a model Learning can't use, Learn now in Settings →
  Learning says "Learning can't run on the model you signed in with. To use it, sign OpenBot in with
  an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.", where it told you to give the back
  end's Learning agent a model and key.
- **A Docker short of CPUs, memory or disk says which, and where to raise it.** When the back end
  refuses to set up for its resources, OpenBot Desktop names what is short with the back end's own
  numbers, such as "Docker has 0 GB of free disk. OpenBot needs 40 GB. Raise the disk limit in
  Docker Desktop > Settings > Resources, or free space in Docker, then Retry.", or the `podman
  machine set` command to run on Podman, where it said "The back end could not start." Setup's
  CopilotKit account step checks the engine first, and one with fewer than 4 CPUs, less than 4 GB of
  memory or less than 40 GB of free disk stops there with the same advice.
- **The first notification after OpenBot Desktop starts is raised**, for a Bot that needs you or
  replies while OpenBot is minimised or behind another window. The first one after each launch used
  to raise nothing, because the app was still checking that notifications were on. OpenBot's log
  now says whether each notification was shown, never what it said.
- **Setup says what is happening.** The screen shown while OpenBot runs says you can show or stop
  it from its icon in the system tray on Windows, where it said the menu bar everywhere, and no
  longer flashes Start's own steps before OpenBot opens. After you accept the terms, the account
  step says "Setting up your apps" while they connect, where it flashed "Sign in to CopilotKit".
  Opening OpenBot after a restart says "Starting the engine machine." while it starts OpenBot's
  Podman machine, and Start's steps say "OpenBot's services" where they said "Containers".
- **Install's bar is full only when it is done.** Once every byte has arrived and the last items are
  still unpacking, the bar keeps moving without filling and the line says "1.1 GB downloaded ·
  Unpacking the last item", where it showed a full bar beside "1.1 GB of 1.1 GB · 1 of 5 items
  remaining".
- The screen shown while OpenBot runs opens on "OpenBot is running", with its Updates section under
  Show OpenBot and Stop OpenBot, as on the stopped screen, where it sat above the heading.
- **App updates download from downloads.copilotkit.ai.** The update feed there names
  downloads.copilotkit.ai for the Windows installer and the Mac update archives, where they came
  from GitHub, and every signature is unchanged. If that download fails, OpenBot Desktop reads
  GitHub's update feed and downloads the same signed version from there, where the update failed.
  The log says where it came from.
- **A Bot with no folders says so in plain words**, as every Bot does after OpenBot restarts: "This
  Bot has no folders it can read right now. Folder access ends when you stop OpenBot. To give it a
  folder, use Choose folder in Settings → Computer." It said "No host folders are granted to this
  Bot."

### Teach a Bot

- **Teach a Bot says what happens after a recording saves**: "OpenBot learns a skill from it, and
  you'll find it in Settings, Learning. Once it's learned, ask any Bot to do it." A row under the
  recording follows it through Learning: **Learn now** before a run, "Learning from your
  recordings" during one, "Ready to review" with **Review**, and "Skill learned" with **Try it**,
  which opens Home with the task in the message box, not sent. A failed run, Learning with no
  model, or a refused Learn now says why, and **See your skills** opens Settings → Learning. With
  the page in the background and notifications allowed, a notification says when the skill
  arrives. It used to say only that the recording was saved to your Learning space.
- **Teach a Bot is one page.** Its title and one line on how sit above the browser, and Your
  recordings sits under it at the same width and scrolls on its own, so a long list no longer makes
  the browser smaller. The page was headed "Browser". Where the browser opens as a window on your
  desktop, the page is as it was.
- **The browser looks like a browser**: tabs along the top, a rounded address bar with a lock on
  https pages, and a search field in an empty tab, sized so the page fills it. While it starts it
  says "Opening your browser…", where the page showed no browser.
- **Record is one button** at the end of the toolbar. It opens **Record a task**, with the task's
  name, the Narration switch (its (i) says what narration is for) and **Start recording**, where the
  name field, the switch and Record sat in a bar above the browser. The narration line shows under
  the browser only while recording, or to say "No microphone found. Narration is off." on a
  computer with none. There, Record no longer asks "Narrate while you record?": it records without
  narration and asks the first time you record with a microphone.
- Your recordings links to Settings → Learning ("See what your Bots learned").

### Conversations

- **A Bot is told which apps it can use from its first message.** Its instructions name each app it
  holds and where it stands for you the way the app's page does, such as "Gmail (connected), Notion
  (needs connecting)". An app you haven't connected is never listed as one it can reach, and a tool
  it holds but isn't offered on a turn isn't called missing. It is told to look an app's tools up
  rather than say it has no access, and in the personal edition never to mention an admin. Bots are
  also told to say what they did in plain words ("I checked your Gmail profile") and never to name a
  tool, such as `GMAIL_GET_PROFILE`.
- **Bots answer in Markdown by default.** Ordinary questions, explanations, summaries and short
  lists come back as a reply. A notice card is kept for an alert that needs you to act, or for when
  you ask for one, and a chart, table or card is drawn when it makes the answer easier to use. Bots
  used to be told to answer with a component whenever an answer had structure, so ordinary answers
  came back as cards.
- **A figure can link to where it came from.** A bar, a progress row, a headline figure or a donut
  chart's legend row links to the record or search its figure came from when the Bot has that
  address, and opens it in a new tab (in OpenBot Desktop, in your own browser). Only web addresses
  become links.
- A chart whose figures are still arriving shows "Drawing the chart…" at the chart's own height,
  where it said "There is no data to chart." A chart that was stopped, or has no figures, still says
  so.
- **+ and Shift+N open a new conversation with To: empty** and the Bot menu open, in the personal
  edition and wherever there is only one Bot, where since 0.3.3 they started with your Bot picked. A
  Bot's own Message link still starts with that Bot, and Send with nobody in To: still keeps the
  message and says "Choose a Bot first."
- **The Bot's screen shows where it is.** In a conversation and in the panel beside it, the address
  the Bot's browser is on sits above the picture. While the Bot has control, a strip over the
  picture names it with **Take control**, where "The Bot has control." and Take control sat in a bar
  under the picture. The panel beside a conversation is narrower, and the full-size view is sized to
  the page.
- **A Bot that is working says so.** Its conversation says "Working" in the sidebar where its time
  was, and Home shows that the Bot is working, with the conversation's name and **Open**.
- A Bot's browsing names the site when it stayed on one, "Browsed example.com" or "Browsed 3 pages
  on example.com", where it said "Browsed 1 page".
- **Approvals for a folder or a Bot's own computer use the words of their step.** The approval
  card, Needs you and a task's waiting line say "Save a file todo.txt in share", "Read a file" and
  "Run a command", where they said "Write file on todo.txt in share". A file on the Bot's own
  computer is named by its path, and its save step reads "Saved a file".
- **A Bot's Activity names an action waiting for your approval the way its card does**, "Click
  the link “Python” on en.wikipedia.org" or "Send email on Gmail", where it read "Approve
  computer_click" with "write" beside it. Approval cards list what an action would send as
  labelled lines, where they showed raw JSON, and a click shows none. In Slack and Microsoft Teams
  the card says it the same way ("Research Bot wants to click the link “Python” on
  en.wikipedia.org"). A saved rule is titled "Click" or "Send email on Gmail" instead of its tool
  id, and the line under it reads "changes in share for Shop", where it read "write on
  host-grant-15407-… for shopper-bot".
- An opened "Looked for a tool" step lists the tools the Bot found by name ("Send email on Gmail"),
  where it showed their ids and the descriptions the search returned to the Bot.

### Personal edition

- Home no longer shows an empty Explore Bots box saying "Nobody has shared a Bot with you yet."
- In Activity, a Bot's call to an app you haven't connected reads "Not connected" with "Gmail isn't
  connected. Connect it in Connections.", or "No longer connected" when it needs connecting again,
  rows already recorded included. It read "The server didn't answer" with raw `[connect-app]` text
  under it, which Admin → Audit no longer shows either.
- Activity names a skill by its title ("Write a skill", where it said "Skill creator"), on older
  rows too. An app a Bot got when you pressed Connect in a conversation reads "Let a Bot use an
  app", "Allowed automatically", where it read "Approve a request for an app", as if somebody had
  approved it.
- An app's page names the setting that makes a Bot ask first by its name, "Always ask before making
  changes", where it said "Ask before acting".

### Smaller changes

- The sidebar floats as frosted glass over the colours of OpenBot's orb, the orb sits beside
  OpenBot's name, and the app is set in Atkinson Hyperlegible Next. The glass turns off with the
  system's reduce transparency or increase contrast setting, and a skin keeps its own look.
- Settings → General, headed "Preferences" before, shows your name and standing instructions as
  rows under About you, each opening a dialog to change it, where both were edited on the page. Dark
  theme, Skin and Message list emphasis sit under Appearance.
- Settings → Notifications shows a switch only for channels that are set up, where the rest showed
  as "Not set up". A choice saved for one is kept and comes back once it is set up. With none set up
  it says "Updates stay in OpenBot", with **How to set them up** for admins and anyone running
  OpenBot themselves, and that your admin sets them up for everyone else. In OpenBot Desktop it says
  they need OpenBot running on a server.
- The skill OpenBot ships as Make a coworker is called **Make a Bot**, and Write a skill's
  description says it saves a new skill rather than a `/` command. Their `/` names are unchanged.
- Activity and Admin → Audit say "Set up an app's sign-in" and "Check an app's sign-in", where they
  said "Register an OAuth client" and "Read an OAuth client".
- Your skills on a Bot's page lists each skill by its title ("Tide report"), where it showed
  "/tide-report".
- A notice card's supporting point that is itself a list is drawn as that list, without a stray
  dot and an extra indent beside it.
- A long link or path in a card's text wraps where it was cut off at the card's edge: in a notice,
  a checklist, a record, a quotation, a data table, an approval, and a choice card's summary and
  options. A choice card's summary is drawn as Markdown, as an approval's is, where it showed the
  raw text, such as `**two**`.
- When a bar chart's figures don't fit above their bars, every bar shows a shorter figure, such as
  "15K" or "3.7K", where they ran into each other. The exact figure shows when you point at it and
  is read out by screen readers.
- **New Bot** lists the frameworks a custom agent can run on under **Connect a custom agent** on its
  first screen, below the form, one line each with its logo, Claude Agent SDK, LangChain, Google ADK
  and AWS Strands first, all four above Cancel and Create Bot in OpenBot Desktop's default window,
  800px tall. Choosing one goes straight to its address, and Back returns to the list. They were
  behind a Connect a custom agent button.
- LangChain is called **LangChain**, with LangChain's own mark, where it said "LangChain
  (LangGraph)": in New Bot, a Bot's "Powered by" subtitle and its Runs on row, and OpenBot Desktop's
  note under a ChatGPT plan.
- Settings → Activity and Admin → Audit reach past the newest 50 events. **Show older events** under
  the last row loads the next page, and the count reads "Newest 50 events", growing as more load,
  until nothing older is left. They stopped at the newest 50 and counted them as if that were
  everything.
- Apps the broker lists in lowercase are named with capitals in Browse apps and when added, such as
  "1Password" where it said "1password". An app added before the upgrade keeps its name.
- Onboarding's Welcome says "Give work to Bots in plain words.", where it said "Hand work to Bots".
- Onboarding's Book a demo step has one button under the calendar, **Not now**, which moves on
  without booking, where Continue sat beside it. Once you book a time, it becomes **Continue**. If
  the calendar can't load, Book a call and Not now show as before.
- The Browse Google Maps starter task asks the Bot to list the walking directions from King's
  Cross step by step, where a Bot could reply with only the walking time and distance.
- A bar chart with any name longer than 12 characters lies on its side, largest first, with each
  name beside its bar (above it in a narrow chat) on up to two lines, the whole name on hover, and
  its figure at the bar's end. "Chart Hacker News" cut every story to a few letters ("2. Car
  unlo…"). Bars with short names still stand up as before.
- The marks for each turn on the left of a conversation show only where the window leaves room for
  them beside the messages, so they never sit on the first letters of a Bot's replies.

## 0.3.4

**Before upgrading.** One migration: `0083_learning_skill_approvals` creates the table
`learning_skill_approvals`, which records who approved a skill learned from a person's recordings
and whether sharing it was asked for. It starts empty and changes no existing row. The database
moves to `0083_learning_skill_approvals`. Six things change for an existing deployment:
- OpenBot Desktop downloads from downloads.copilotkit.ai first, and from GitHub, ghcr.io or Docker
  Hub only when that fails:
  - OpenBot's container images, and the Podman and Compose it installs.
  - A release's source archive and image list, and the lookup of the latest release for a new
    installation.
  - The back end's images when it updates or resumes a setup. Its node is set to pull from
    downloads.copilotkit.ai first: a new one from its first start, an existing one at its next
    download, unless it has a mirror setting of its own. A first setup's own back end images, and
    the k3s and k3d images its cluster starts from, still come from ghcr.io and Docker Hub.

  OpenBot Desktop's own updates still download from GitHub. A failed try at downloads.copilotkit.ai
  goes straight to the original. Nothing new has to be allowed through a firewall, but allowing
  downloads.copilotkit.ai for OpenBot Desktop, its container engine and its back end gives the
  faster path, and GitHub, ghcr.io and Docker Hub are still needed. Self-hosted Compose and Helm
  deployments are not affected.
- The personal edition has no memory (below). Memories and memory sources your Bots already have
  stay in the database but are no longer shown, used or synced. Upgrading deletes nothing, and a
  Bot's Reset still deletes them.
- In the personal edition, **Approve new skills automatically** in Settings → Learning is on. About
  ten seconds after the first start it approves and publishes every skill proposal already waiting
  in your Learning spaces, and your Bots start using them. It then runs every 15 minutes.
- At each start, the personal edition rewrites two things, with one audit row each, and writes
  nothing when there is nothing to change. A Bot that Learning settings carried over from a team
  deployment left out of Automatic Learning is taken back in. Skills you wrote on Settings → Skills,
  which were stored as nobody's, become yours. Skills OpenBot ships stay OpenBot's.
- On OpenBot Desktop, Automatic Learning runs on the model you signed in with, set at each Start,
  so its analysis is paid for by your API key or plan (below). `docker-compose.yml` passes a new,
  optional `OPENBOT_LEARNING_MODEL_TOKEN`, which only OpenBot Desktop sets.
- Going back to 0.3.3 after an admin sets **Who approves skills learned from people's
  recordings**, or after **Approve new skills automatically** is switched in the personal edition,
  makes every conversation fail on 0.3.3, which can't read the saved Learning settings. Restore the
  backup taken before the upgrade instead.

### OpenBot Desktop

- **Updates finish on a slow connection.** Before its back end updates, or resumes a setup an
  earlier attempt left, OpenBot Desktop downloads the back end's images itself, one at a time. A
  download stops only after three minutes with no new bytes, or an hour on one image, and the next
  attempt continues where it left off. Each image used to get the back end's own ten minutes, and
  on a slow line the update failed every time.
- **Downloads show how much has arrived.** Install shows its download in bytes ("1.2 GB of 3.4 GB ·
  1 of 5 items remaining"), where it showed only how many items remained. The back end's download
  shows a bar and its size under "Downloading the back end update" or, on a first setup,
  "Downloading the back end", also as a Back end download card on the Install and Connect your AI
  screens. A download that stops says so and that Retry, or the next Start, continues where it left
  off.
- **OpenBot opens when a back end update did not finish.** A back end that still answers on the
  release it had counts as ready: the window says which release it runs and that the update did not
  finish, and **Show OpenBot** opens it. It used to say "The back end is running but not healthy."
  and stop. The next Start tries the update again, also after Quit, where the back end used to
  refuse to start. A back end whose checks fail is still not healthy.
- **Downloads from GitHub keep trying when they stall**: OpenBot's own files at Install and at an
  update, and the Podman and Compose it installs. An attempt that gets nothing for 30 seconds is
  tried again, six attempts in all with longer waits between, about four minutes at most. A download
  that keeps arriving is never cut off. It used to give up after three attempts in about a minute
  and a half, and an update put the previous version back.
- **OpenBot keeps its address when you quit and open it again straight away.** Start waits up to 30
  seconds for its own ports to free up. It used to move OpenBot to another port, so a tab or
  bookmark on the old address stopped working. A port another program holds still moves.
- **Notifications go through the system.** OpenBot Desktop no longer offers to turn notifications
  on, because they are on. On a Mac, Enable notifications did nothing and the offer kept coming
  back. Clicking a notification brings OpenBot to the front at the conversation it is about, on
  Windows from the notification centre too, through `openbot://` links the app registers.
- **Setup says what Docker Desktop is doing.** When setup opens Docker Desktop, every setup screen
  says "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in,
  do that there. OpenBot comes back when Docker is ready.", and after 45 seconds that Docker may be
  waiting for you there. OpenBot comes back to the front once Docker answers, after Podman's
  password prompt or the Windows Subsystem for Linux step, and when Install fails or finishes. It
  used to stay behind Docker's window, saying only "Checking your CopilotKit account…".
- **Opening OpenBot Desktop after a restart starts what the back end runs on first**: Docker
  Desktop, or OpenBot's Podman machine on a Mac or Windows. It used to stop at Waiting for the back
  end with "The back end cannot start until the software it runs on is running."
- **Automatic Learning runs on the model you signed in with**: your OpenAI or Anthropic API key, or
  your Claude or ChatGPT plan through OpenBot. With any other sign-in, Settings → Learning says
  Learning can't run on it and what to sign in with instead, and a failed Learning run says why.
  Learning on OpenBot Desktop used to have no model and learned nothing.
- **Recordings reach OpenBot after it moves to another port.** The Recorder used to keep sending to
  the old port, and the recordings stayed in the browser.
- **A Bot's steps in a folder on your computer name the file and the folder** the same way on the
  approval card, on the step and in Activity ("todo.txt in share"). The card used to read "Write
  file on host-grant-…". A step you declined on the card reads "Blocked: Save a file", with the file
  and "You declined it.", where it read "Saved a file", also when the conversation is opened again.
  Opened, "Checked your folders" reads "Folders it can read: share." instead of JSON, and no folder
  step shows the folder's internal id.
- **The Status window and Settings → This computer name every part** of the back end: its setup
  container reads "Setup helper" and an earlier team install's identity service "Bot computer
  identity", where both said "Other part". The Status window says the back end is "On this
  computer" instead of its stack id, which is still in Copy diagnostics.
- At launch, OpenBot Desktop moves its window up when its bottom edge is past the screen's work
  area. On Windows it opened a little lower each time, until the sidebar's account row was behind
  the taskbar.
- Windows lists OpenBot Desktop's publisher as CopilotKit in Settings → Apps and in Programs and
  Features, where it said "copilotkit". Ctrl+Q in the window quits OpenBot, as the tray menu's Quit
  says, where it did nothing.
- On a Mac, onboarding keeps Back below the window's buttons, and its top strip moves the window.

### Automatic Learning and Teach a Bot

- **Review learned skills in OpenBot.** On Admin → Automatic learning, **Who approves skills
  learned from people's recordings** is **Admins** (the default) or **Each person, for their own
  Bots**. Admins review under **From people's recordings**, and a person sees what waits on
  Settings → Learning. A skill a person approves reaches only their own Bots until they press **Ask
  to share** and an admin approves it under **Sharing requests**. Skills published before the
  upgrade keep reaching the Bots they reached. See
  [Automatic Learning](docs/automatic-learning.md#reviewing-learned-skills).
- **Your recordings on Teach a Bot.** Teach a Bot lists your recordings, newest first, with how each
  ended, and one the Recorder sends later appears without leaving the page. The Recorder's popup
  links to it. The list needs Intelligence 0.16 with recordings switched on.
- **The personal edition has Settings → Learning**, with **Learn now** and **Approve new skills
  automatically**, which is on: it approves what OpenBot proposes from your recordings and
  conversations shortly after each start, every 15 minutes, and when you open the page. Turn it off
  to review each skill yourself.
- **Learned skills read in words.** Each is named in words where it showed its hyphenated name, and
  its steps show without the SKILL.md file name or the Recorder's notes such as "(tag=a)". Opening
  one of your skills lists the recordings it was learned from under **Learned from**. What a Bot
  uses is unchanged.
- A recording the Recorder can't send yet says it wasn't saved to your Learning space yet, and why.
  It used to read "Saving" for the half hour the Recorder retries.
- A recording made right after OpenBot's computer starts is saved. In the browser shown inside
  OpenBot, the computer's network filter used to turn the Recorder away until a page had loaded,
  and the recording was held ("Learning capture is paused") and tried again only every five minutes.
- Narration that can't hear you (no microphone, or the browser refused it) stays off after Stop
  and the next Record until you turn it on, and "We're capturing your voice" shows only while a
  recording hears you; otherwise it reads "Narration is on." Narration used to turn itself back on
  after Stop and say it was capturing your voice with nothing recording.
- Teach a Bot's description says to press **Record**, the button the page shows, where it said
  "Start recording".

### Apps and connections

- **An app's tools are named in words everywhere you read them**: Activity, Admin → Audit, a
  conversation's steps, approvals and a Bot's "What it can do" say "Get IMAP settings", not
  "Settings get imap", and "Fetch thread messages", not "Fetch message by thread id". "What it can
  do" lists every app's tools as commands, so Routines reads "Complete goal, Create goal". In the
  personal edition an app's page lists its tools by those names, in order, where it showed stored
  names such as `GMAIL_ADD_LABEL_TO_EMAIL`, each with the first sentence of what it does in plain
  words ("Permanently deletes a Gmail filter.", where it read "Tool to permanently delete a Gmail
  filter by its ID"). Admin's app page keeps the stored names.
- **Work apps are connected through OpenBot.** Connections, an app's page, the app directory, a
  conversation's connect cards and Admin → Plugins no longer name Composio or Arcade ("Browse
  Composio" is now "Browse apps", "Through Composio" is now "Through OpenBot"). Admin pages still
  name the setting to set, such as `COMPOSIO_API_KEY`. When connecting, re-checking or
  disconnecting fails with a message that names Composio, you read a plain sentence and the full
  message goes to the server log. The directory no longer lists Composio's own toolkits (Composio,
  Composio Search and Browser Tool); one already turned on keeps working.
- **A Bot can read a whole day of Gmail** connected through Composio. A listing returns sender,
  recipients, subject, time, labels and Gmail's snippet for up to 20 messages per call, with the
  token for the next page, and says how many of the matches it holds when there is another page. A
  message or thread read whole keeps its decoded body, Cc and Reply-To. Listings used to carry each
  message's raw MIME, tens of thousands of characters per email, so a Bot saw part of the first
  email and a large page failed as too large. For any app connected through Composio or Arcade, a
  list over the 20,000-character limit is cut between whole records, with a note naming the call
  that reads the rest, where it was cut mid-record.
- **A conversation's Connect card opens the app's sign-in on the first press**, Notion included,
  and says "Opening sign-in…" while it does. In the personal edition the first press used to only
  turn the app on, and Notion's card refused with "Notion has no tools to give yet". Messages that
  sent you to Plugins or to an admin now name Connections and the step to take.

### Conversations

- **A skill picked from the `/` menu reaches the Bot.** OpenBot gives the Bot that skill's
  instructions for that message, for built-in Bots and Bots at their own address, in a new
  conversation and in one with several Bots. The Bot used to get only the command and guess what
  the skill was, and a built-in Bot on a Claude plan answered "Unknown command" without asking the
  model. A command in the middle of a message, or for a skill the Bot doesn't have, does nothing.
- **After you answer an approval, the conversation shows the Bot working** until it has carried on
  and finished, and its reply arrives whole. If the Bot then reaches another action that needs your
  approval, it stops and asks in the conversation, and does nothing more until you decide. The
  conversation used to look idle while the Bot was still going, the reply could stop part way until
  the conversation was opened again, and a second approval was never shown while the Bot was run
  again and could reply without it. The action itself was not carried out.
- **Opening a conversation shows each reply once and whole**, also when you come back while the Bot
  is answering. A reply could appear twice in one bubble, and one the Bot was still writing stopped
  mid-word, both until a reload.
- **The Bot shows it is still working through a run of steps**: the step still running shimmers,
  and once every step has its answer "Thinking" shows under them until the reply starts. The steps
  used to sit still with nothing under them, as if the Bot had stopped.
- **A Bot signed in to a ChatGPT plan works with every app it has.** ChatGPT refused the whole
  request when one of the Bot's tools took an email address (HubSpot's and Google Calendar's, for
  example) or used a lookahead pattern, and the conversation ended with "Remote agent ended without
  a terminal event." OpenBot now sends every model only the parts of an app's tool description that
  OpenAI and Anthropic document as supported, and the app still checks what the Bot sends. Some
  tools that reached the model with no arguments named now have their arguments.
- **A run that ends without an answer says so**: "The Bot stopped before it finished answering. Try
  again.", and a model provider's refusal says which provider turned the request down, where the
  conversation showed "Remote agent ended without a terminal event."
- **In a conversation with several Bots, a Bot's question waits above the message box**, as it does
  with one Bot, and what you send next answers it, unless you @ another Bot. The Bot then replies in
  the conversation. The question used to never reach you there.
- In a new conversation, typing @ before the first message lists the Bots in To:, and with two or
  more, a first message addressed to one goes to that Bot only. @ used to say "No Bots in this
  conversation" until something had been sent, and the first message went to every Bot.
- **Notifications say what happened.** When a Bot set to notify you of everything replies while
  OpenBot is out of sight, a notification gives its name, "replied" and the first line of its reply,
  once its turn is over. If the turn ends waiting on you, the notification says the Bot needs you
  and opens the waiting conversation, where it opened the Bot's page. Neither appears while you are
  looking at OpenBot.
- **A Bot waiting on an approval, choice or form card shows under Needs you**, in its Activity and
  as needing input on a task's conversation, and you get its "needs you" notification. Nothing used
  to show it was waiting.
- Text a Bot writes into a card (a notice, a record, a checklist, a quotation, an approval, a
  table) is drawn the way its replies are: links can be clicked, and bold, lists and inline code are
  formatted. Cards used to show the raw markdown, such as `[Sender](https://mail.google.com/...)`.
  Titles and labels stay plain.
- The starter tasks in your first conversation are Chart Hacker News (a web search drawn as a bar
  chart), Browse Google Maps (the Bot's own browser looks up opening hours and walking directions),
  Triage my inbox (the two emails from the past 24 hours that most need you, changing nothing, with
  Gmail's connect card first if Gmail isn't connected) and Build a trip budget. Summarize email,
  Find weekend plans, Read a webpage and Try a browser task are gone.

### Personal edition

- **No memory.** The Memory rows on the Bots page and on a Bot's page are gone, and a Bot's
  check-ins move to its What it can do page. Bots are offered no memory tools and bring no memory
  into a conversation, check-ins no longer form memories, and connected apps are no longer read as
  memory sources. Settings → This computer, Settings → Setup and OpenBot Desktop's Status window no
  longer say the back end keeps memory (above).
- **Your skills show on a Bot's What it can do**, the ones you wrote on Settings → Skills, each with
  its switch, on for a Bot made a moment ago too. It read "No skills yet".
- **A Bot's page speaks to one person.** Setup names what runs the Bot ("Runs on LangChain
  (LangGraph)") instead of the address of the harness OpenBot started for it. Pinned, Hidden and
  the Bots list's Hidden section drop "Only your list changes." Reset reads "Delete your
  conversations with it and its scheduled work", and its notice no longer mentions other people's
  conversations or memories. Delete says you can still read your conversations with it, where it
  said "Deletes it for everyone."
- **An app's page speaks to you**: "Connect your Gmail account so your Bots can use it", "You sign
  in to Gmail in your browser. OpenBot never sees your password.", and summaries such as "Your pages
  and databases.". An app whose tools list only after sign-in says "Connect your Notion account
  above to list its tools.", where it printed raw `[connect-app]` text, which Admin no longer shows
  either. Where connecting apps isn't set up, it points to Settings → Setup, and notices after a
  sign-in no longer say to ask an admin.
- The New Bot sheet lists every app that is turned on, which every Bot gets, with nothing to untick.
  It listed only some of them as ticked boxes, often Routines alone.
- Settings → Setup no longer mentions memory or an admin: the Back end row reads "Keeps your
  conversations and skills", More apps compares with the apps OpenBot comes with, and its links name
  Keys and Computer.
- Settings → Browsers says a recording goes to your own Learning space in OpenBot's back end and is
  used only for your own Skills, evaluations and insights, where it said your organization's.
- Settings → Computer lists the Teach a Bot browser as "Your OpenBot browser", with Stop browser and
  Clear browser data, where it read "A Bot no longer here". Admin → Computers names whose OpenBot
  browser each one is.
- In Activity, what OpenBot gives the Activity report is one row naming what it reads ("your Bots'
  activity and what was refused"), where it was two identical rows that named neither. A routine a
  Bot creates, changes or deletes shows once, where the Bot's call to Routines was a second row.

### Smaller changes

- Settings → Setup says the Bot computer is Ready whenever the one shared computer answers (the
  personal edition's, or a team deployment's without `COMPUTER_SUPERVISOR_URL`), before a Bot has
  used it and after its browser has closed. It said "Not checked" and that a computer starts when a
  Bot first needs one.
- Onboarding's Welcome says what always asks (deleting, sending, sharing, posting) above the
  approvals switch, which is now "Always ask before making changes" there and in Settings →
  Approvals, with the same words in both.
- Every OpenBot for Business link in the app (Book a call on the self-host banner, Talk to us, Meet
  OpenBot for Business, and the New Bot and Bot Setup links) opens https://open.bot/business. On a
  single-user install, onboarding's Talk to us step is now Book a demo, with the OpenBot for
  Business booking calendar (Calendly) in the step. If it can't load within 20 seconds, the step
  offers Book a call, which opens open.bot/business.
- When OpenBot can't read its saved Learning settings, conversations carry on without Learning and
  the server logs it. Every conversation used to fail.
- In a narrow window, the sidebar closes when you pick a conversation, New conversation, Bots,
  Connections, Teach a Bot, or an item in your account menu, where it stayed open over the page.
- In a narrow window the message box keeps the same margin from the pane's edges as the
  conversation above it, and the starter tasks line up with its text, where both ran to the edge.
- Onboarding's name step leaves room above the orb, so the header with the step dashes no longer
  cuts off its top.

## 0.3.3

**Before upgrading.** Five migrations add columns: `0078_routine_title` adds a nullable
`routines.title`, `0079_tool_unclassified` adds `mcp_tools.unclassified`, false on every existing
row, `0080_listing_revision` adds `mcp_servers.listing_revision`, 0 on every existing row,
`0081_goal_recurring` adds `responsibilities.recurring`, false on every existing row, and
`0082_routine_goal` adds `routines.goal_id`, empty on every existing row, and
`routines.goal_by_title`, true on every existing row. The database moves to `0082_routine_goal`. Eight things change for an existing deployment:
- A goal's tools are named for goals. `create_responsibility`, `list_responsibilities`,
  `update_responsibility`, `report_responsibility_progress`, `run_responsibility`,
  `pause_responsibility`, `resume_responsibility` and `complete_responsibility` are now
  `create_goal`, `list_goals`, `update_goal`, `report_goal_progress`, `run_goal`, `pause_goal`,
  `resume_goal` and `complete_goal`, and `create_trigger` takes `goalId`. The old names are gone, so
  update any Bot instructions, skills or goals that mention them. API routes and the database are
  unchanged.
- At the first start, the saved tools of OpenBot's own apps, Routines and Google Drive (where it is
  added), are brought up to this release's, and every Bot gets Routines' seven new goal tools
  (below). After that, a start changes them only when a release does.
- An app tool whose action is archive, and any app tool its app marks destructive, asks with
  **Allow once** or **Deny** every time, whatever your settings (below). This starts at once, with
  nothing to refresh.
- At the first start, every app of your broker (Arcade or Composio) is listed again once, as
  **Refresh tools** does, so an action its app says nothing about is recorded as a fresh install
  records it: an ordinary change (below). Nobody has to press anything, and the start doesn't wait
  for it. Actions the broker flags destructive, and delete or archive names, still ask every time.
  If the broker can't be reached, an app keeps its actions, which ask as before, and OpenBot keeps
  trying every few minutes and at the next start.
- Existing goals keep their state, but a goal that one of its Bot's routines runs, or that an event
  wakes, now counts as repeating, so its runs no longer complete it (below). An existing routine
  runs a goal when its instruction names the goal's id, or the goal's whole title in quotes. A goal a run already
  completed stays completed, and its routine now says so each time it fires.
- The audit trail records a person's denial as the action's own refusal (`computer.action_refused`
  or `mcp.call_rejected`), and an approved computer action as one `computer.action_allowed`, where
  it wrote up to three. A Bot's actions in folders on OpenBot Desktop are `computer.action_*` events
  (actions `host/read_file`, `host/write_file` and so on), where each was two
  `configuration.changed` rows. OpenBot giving a Bot an app's tools is one `configuration.changed`
  row per Bot and app, where each tool had one. Counts taken from the export or a log collector
  change. Rows recorded before the upgrade keep their old shape.
- A Bot you run at your own address that hands `ask_person` or `message_bot` back to OpenBot
  unanswered now has OpenBot carry it out: the person is asked, or the message is delivered. A Bot
  that calls OpenBot's tools itself is unchanged. Any Bot at its own address is never sent more than
  128 tools in one request, whatever its provider takes: the app tools least like the request are
  left out.
- An existing personal edition keeps its Bots. On OpenBot Desktop the Personal Assistant and the
  Bot picked in setup stay two Bots, and the Personal Assistant is no longer rewritten from the
  package at each Start. The picked Bot's subtitle says "Powered by" and its framework where it
  repeated the framework's name, and a picked Bot named "LangGraph" becomes "LangChain (LangGraph)".
  An OpenBot Desktop installation still on 0.3.1 that becomes the personal edition with this release
  keeps its Bots and gets no Personal Assistant, where 0.3.2 added one.

### Bots ask before archiving or deleting in your apps

- **Archiving asks as deleting does.** An app tool whose action is archive, such as HubSpot's
  `HUBSPOT_ARCHIVE_CONTACT`, archiving a Slack conversation or archiving mail in Gmail, asks with
  **Allow once** or **Deny** every time. Listing archived items, reading archive settings and
  unarchiving don't ask. Archiving used to ask only where any change would.
- **So does any tool its app marks destructive**, whatever it is called: an MCP server's
  `destructiveHint`, Composio's destructive tag or Arcade's destructive flag, such as
  `Attio.RemoveFromList`. The flag used to make no difference to asking.
- **You're asked once.** Bots are told OpenBot asks before these, and a destructive tool's
  description says so, so a Bot no longer asks you itself first.
- **An action its app says nothing about is an ordinary change.** An Arcade action that publishes
  no behaviour flags, such as every AirtableApi and GithubApi action, or a Composio action with no
  label, asks only where any change would (**Ask before making changes**, or a rule). Check-ins,
  tasks and memory still never call one on their own. On an app's page for a Bot, such an Arcade
  action no longer says "destroys things". An app listed before this release is listed again at the
  first start (above).
- **Settings → Approvals says what always asks**, above its switches: payments, passwords and
  security settings are handed to you, deleting, sending, sharing and posting in your apps and on
  websites ask first, and so do edits and commands in a folder on your own computer. A Bot's own
  computer is its scratch space, so what it does there asks only when your settings or rules say
  so. The page said every delete asked first, though a Bot deleting a file on its own computer
  asked only when your settings did. Onboarding says the same about your apps and a Bot's own
  computer, and Bots are told it.

### Goals and routines

- **Ask a Bot for a goal in a conversation and it sets one up.** It used to say it had no goals
  tool and set up a routine instead. Every Bot has the goal tools in Routines, all but
  `report_goal_progress`. A goal made this way reports into the conversation it was asked in, or
  another the person names, and shows on the Bot's Goals page. Creating, changing, running, pausing,
  resuming and completing a goal ask first while **Ask before making changes** is on.
- **Bots say goal**, the word every screen uses, and no longer tell you they "marked the
  responsibility complete". The tools are renamed (above), `create_trigger` sends you to the goal's
  card on the Bot's Goals page, and a goal's steps in a conversation read "Created a goal",
  "Checked goals", "Marked a goal complete" and so on, also in conversations from before.
- **A goal that repeats stays active after its runs.** A goal a Bot sets up to repeat ("every
  morning"), one a routine runs and one an event wakes are no longer completed by one of their
  runs. Each run records its result, and only you end the goal, in a conversation or on its card.
  Its first run could complete it, which left the routine nothing to run. A routine that runs a goal
  you completed or paused now says so, where it ran nothing and said nothing. Editing a goal, on its
  card or by asking a Bot, no longer clears the events that wake it.
- **A routine records the goal it runs.** A Bot making a routine for one of your goals passes the
  goal, and a routine whose firing runs a goal is linked to it then. That link, not the routine's
  wording, makes the goal repeat, lists it under Scheduled and gives the routine its title. A goal
  titled "Email" was taken as run by any routine that mentioned email, so its runs could never
  complete it.
- **A goal's run waits for a busy conversation.** A run that starts while its conversation is in
  use, such as **Run now** while the Bot is still answering there, waits and then runs. After about
  9 minutes it gives up with "This goal's conversation was busy for about 9 minutes, so the run
  never started and nothing was done. Run the goal again when the conversation is free." It failed
  at once, with the platform's 409 error as its reason.
- **A goal that runs only when asked** is counted "on demand" on a Bot's page and listed under On
  demand on its Activity page, where it was counted and listed as scheduled. A goal a trigger wakes
  says so ("Wakes on webhook"), where it said "Runs when asked".
- **A goal a routine runs is listed with it.** On a Bot's Activity page it sits under Scheduled and
  says when it runs ("Every day at 08:00 (UTC), from its routine"), where it read "Runs when asked".
  Each of its runs is named "Run of" and the goal's title, where it carried the goal's own title.
- **A routine can have a title.** A Bot asked to name a routine ("call it Morning briefing") gives
  it that title, up to 100 characters, where it said it couldn't. The title heads the routine's row
  on the Routines page, with its schedule under it, and names it in a Bot's Activity. A new routine
  a Bot makes to run one of your goals carries the goal's title unless you named it, where it went
  by the instruction the Bot wrote for it. Bots are told a routine's id is for their tools only, and
  not to read it out.
- **Bots tell you a routine's next run on your clock**: a Bot that creates, changes or lists a
  routine is told "Saturday, November 7, 2026 at 9:00 AM UTC, 6 minutes from now", where it was told
  "2026-11-07T09:00:00.000Z", so it no longer says a run due in minutes is tomorrow.
- **A Bot page's Activity list reads in words.** A routine's schedule reads "Every day at 09:00
  (UTC)", as on the Routines page, where it read "Repeats on 0 9 * * * (UTC)". Each title stays on
  one line with an ellipsis and shows whole on hover, and a routine's row carries its whole
  instruction, where it was cut at 120 characters. A goal's summary, an error, a question, a
  follow-up and a delegated task show as plain text, without Markdown marks.
- **OpenBot's own apps keep up with the release.** At every start the server brings the saved tools
  of Routines and Google Drive (where it is added) up to date with the release it runs, so a tool a
  release renames, rewords or adds reaches an existing installation without anybody pressing
  **Refresh tools**. A start where nothing changed writes nothing, and which Bots have an app, and
  which apps are on, stay as they were. Apps from MCP servers are not refreshed at start, and
  Composio and Arcade apps only once, at the first start after this upgrade (above).

### Questions reach you, and answers show as they happen

- **A question with no answers to pick from**, such as which city you're in, reaches you with a
  field to type the answer. It was refused before you were asked, and the step read "Blocked: Asked
  you", as on the "Find weekend plans" starter.
- **A Claude Agent SDK Bot's question reaches you** above the message box, and your answer goes back
  to the Bot. It showed only as a step, and what you typed back was lost. Its messages to another
  Bot are delivered the same way.
- **Your answer's work streams in the conversation, with Stop.** When a Bot asks you something in a
  conversation and you answer there, its work on your answer appears step by step and can be
  stopped. It showed "Personal Assistant is reading your answer…" (with the Bot's name), with no
  steps and no Stop, until the turn was over. An answer sent the moment the Bot asks always answers
  it, where it could go as a new message and leave the question, and its "1 thing needs you" badge,
  open. A question a routine, a goal or another Bot asked is still answered in the background.
- **A step you declined stays declined** after you write again, and the Bot is told you declined
  it. It turned into "Saved file" on your next message, and read as done when the conversation was
  opened again. A blocked step says what was tried, its target and why ("Blocked: Save file",
  "notes.txt · You declined it."), and a step that never ran because the Bot stopped to wait for you
  reads "Not done. The Bot stopped to wait for you on another step.", where it read as done.
- **The first-use starter tasks step aside** while a Bot waits on your answer, where they covered
  the bottom of its question.

### Claude Agent SDK Bots

- **They answer after you decide** a step they asked about (**Allow once**, **Deny**, **Don't do
  it** or **I did it myself**), also when they asked for several steps at once or you decided more
  than five minutes later. A long browser task is no longer cut off five minutes in: the limit is
  five minutes without progress. Any Bot is told which of the steps it asked for never ran.
- **They answer what you write while one of their steps is still open**, such as after Stop or a
  reload, and your message stays in the conversation. They carried on as if you had said nothing,
  and your message was missing when the conversation was opened again.
- **A step Claude Code refuses before it runs**, such as a table sent with broken data, no longer
  ends the turn in silence. The Bot goes on to retry or answer in words.
- **They answer once when their stream from Claude breaks partway** and Claude Code recovers. The
  Bot used to answer a second time under its first reply, show the same reply twice, leave a
  cut-off fragment above the answer, or lose the answer and keep only the fragment. A fragment can
  still show while the answer arrives, and is gone when the turn ends.

### Activity and Audit

Activity (Settings → Activity in the personal edition) and Audit (Admin → Audit):

- **A denied action reads Blocked.** A Bot's computer action or app call that a person denied
  shows as Blocked ("A person denied it when asked.") and is listed under Blocked, where it read
  Allowed. The person's answer reads "Denied by a person", "Allowed once by a person" and so on.
- **One row per action.** A computer action that failed or was stopped shows once, as "Did not
  happen", and Computer actions lists blocked, failed and stopped actions as well as allowed ones.
- **A Bot's folder actions on your computer are computer actions.** Reading, saving or running
  something in a folder reads "Read a file", "Save a file" or "Run a command", with the file or
  command under it, and is listed under Computer actions. One you denied reads Blocked and is
  listed under Blocked. Giving a Bot a folder reads "Give a Bot a folder" with the folder and the
  Bot, and taking it away or stopping folder access reads "Take a folder from a Bot" or "Stop folder
  access".
- **Activity leaves out OpenBot's own working**: choosing tools for a run ("Choose tools for a
  run", "96 of 96 tools"), written on every turn; which Bot a message went to ("Choose a Bot for a
  message"); the components a build publishes; and the two "Start the computer" rows at every
  start. They are gone from every view of Activity and from its export. Admin's Audit still lists
  them.
- **Rows say what they were about in words**, such as "Save a file" and "Set up Learning", where
  they showed "write_file" and "Change a setting". Admin shows the stored name on hover, and the
  export keeps it. In Activity, what a row acted on is in words too: a tool call's app ("Gmail"), a
  component by its gallery name ("Activity report") with why it was refused, a skill by its name,
  and a saved key by its provider and key ID, where they showed stored names and ids.
- **Bots are named, never shown by id**, here and on the Computers page. A Bot hidden from the
  sidebar is named, a deleted Bot reads "A Bot no longer here", and hovering a Bot no longer shows
  its id. The export keeps the ids.
- **The table fits a 1000-pixel window**, OpenBot Desktop's default: what an action acted on sits
  under it, and who started it under the Bot, so Decision shows without scrolling sideways.
- **The personal edition's page is titled Activity**, as its sidebar entry is, where it was titled
  Audit and spoke of "this deployment's policy". Admin keeps Audit.
- **What OpenBot does by itself is started by OpenBot**: giving every Bot Routines' tools at a
  start, such as the new goal tools at this upgrade's first start, giving every Bot an app's tools
  in the personal edition, turning on Routines, and publishing a build's new components (Admin
  only). These read as started by a person. Activity reads "Started by OpenBot" for them, and for
  every other row OpenBot started, where it read "Started by this deployment", which Admin keeps.
  Giving a Bot an app's tools is one row per Bot, "Give a Bot tools", with the tools and the app in
  words, where each tool had its own "Change a setting" row.
- **A Bot's Activity page links to "Every action this Bot took"**, which opens this page narrowed
  to that Bot until you clear the filter. The link shows in the personal edition, and for admins.
  The page also says it lists the Bot's tasks, routines and goals.

### OpenBot Desktop

- **A new installation starts with one Bot**, the Personal Assistant, running on the framework
  picked in setup. It started with the Personal Assistant and a second Bot named after the
  framework. Its subtitle says what runs it ("Everyday life. Powered by LangChain (LangGraph)."),
  and under its name it says what it does ("Help with email, your calendar, research, planning and
  everyday errands."). Its Setup page changes its name, its subtitle, what it does and its
  Instructions, each on a row of its own. After a change of AI provider it moves to the new
  framework, even after you rename it, and the "Powered by" part of its subtitle names the new one,
  keeping any words you wrote around it. Its Setup page says "OpenBot runs this Bot, so it can use
  its tools without a key." A personal edition started with
  `scripts/start.sh` starts with the Personal Assistant subtitled "Everyday life. Powered by
  OpenBot.", which can be changed the same way.
- **Bots can read folders on your computer.** Press **Choose folder** on a Bot's row under Folders
  on this computer in Settings → Computer. A folder is read-only. The desktop app asks in its own
  dialog before each file change, and before each command unless Settings → Approvals says
  otherwise. Every folder chosen and every call is recorded in Activity, and access ends when
  OpenBot stops. **Choose folder** was refused with ""Local computer access" isn't part of OpenBot
  Personal, so that wasn't done." An OpenBot that OpenBot Desktop didn't start, such as one started
  with `scripts/start.sh` or a team deployment, says "Needs OpenBot Desktop" there, where it said
  the desktop app was offline.
- **Check for updates works on a signed release.** It says "OpenBot 0.3.3 is up to date." (naming
  the version you run) or names the newer one with **Update and restart**. The setup window's
  Updates section said signed updates were not configured. You can also ask from **Check for
  Updates…** in the tray menu, under About OpenBot in the OpenBot menu on a Mac, and from **Check
  for updates** on the Version row of Settings → This computer. A build that doesn't update itself,
  such as an internal build, says so up front ("This version of OpenBot doesn't update itself.
  Install a released version of OpenBot to get updates."), with no button.
- **A log file you can send.** OpenBot Desktop keeps a log file on every platform: each Start,
  Stop, update, container command and update check, and every error, with a UTC timestamp.
  Settings → This computer and the Status window show its folder under Logs, with **Open log
  folder**. It stays on your computer, rotates at 5 MB keeping four older files, and hides keys,
  tokens, passwords, cookies, sign-in codes and email addresses. It used to keep no log file.
- **Conversations on a Claude or ChatGPT plan get a title** in the sidebar, from the plan's own
  model, as the built-in Bots' answers are. With no model key nothing titled them, so each showed
  the start of its first message. A Bot you brought yourself is never run to title one.
- **The setup window offers a saved sign-in only when there is one.** "Use a saved ChatGPT
  sign-in", "Use a saved OpenAI API key" and "Use a saved Anthropic API key" show only when one is
  saved. On a computer with nothing saved they were offered anyway, and Start then failed.
- **The ChatGPT sign-in's own pages show, not a reset connection.** "This sign-in link is out of
  date" and "OpenBot already has this sign-in" came up as a reset connection when the browser's
  request was long, as it is with many `localhost` cookies. And a browser that came back before
  the sign-in was listening was told "OpenBot already has this sign-in" while the sign-in never
  finished; the sign-in now waits for it.
- **The setup window's sign-ins show whose account they are**: CopilotKit's logo on the CopilotKit
  sign-in, Google's and xAI's marks in the "Connect your AI" list, a cloud icon beside "Any
  OpenAI-compatible endpoint", and each provider's mark on its "Sign in with" button. Google's
  button reads "Sign in with Google", where it read "Sign in with Google Gemini".
- **The Claude plan sign-in** says to approve the request in your browser and paste back the code it
  shows, where it said nothing is typed in the window. The link under xAI's API key field reads "Get
  an xAI API key", where it read "Get a xAI API key".
- **The Windows installer shows OpenBot's orb** down the side of its Welcome and Finish pages, in
  the header of its other pages and as its icon, where it showed NSIS's stock artwork. The
  uninstaller has the same icon.
- **On Windows, folders read `C:\Users\you\OpenBot`** under Installed in and in the desktop app's
  approval dialogs, where they read `\\?\C:\Users\you\OpenBot`.

### Personal edition

- **Sign out is gone where nobody signs in**: every personal edition, OpenBot Desktop included,
  and any deployment with `OPENBOT_SINGLE_USER`. Pressing it said "No identity provider is
  configured." and left you where you were.
- **OpenBot, not "this deployment".** An app's page under Connections, Add credential under Keys
  and the Computer page's update dialog say OpenBot where they said "this deployment". Admin keeps
  "this deployment". In both editions, messages anybody can see say OpenBot too, such as "Voice
  calls are unavailable. Check OpenBot's voice configuration."
- **Settings → Setup no longer lists Slack and Teams**, which said "Needs setup" and counted in the
  number beside Setup in the Settings sidebar.
- **A Bot names the app card's real button**: Turn on (then Connect, if the card offers it),
  Connect, Set up for an app that takes a key, or Set it up. It always said to press Connect, which
  the card doesn't show for an app that has to be turned on first.
- **The Activity report works.** A Bot asked for one drew "Not shown: Activity report", saying an
  admin had to give it the data, and the personal edition has no admin. OpenBot now gives the report
  what it reads when the app loads, including the first load after the upgrade, and a refusal says
  "It can't read the data it needs." Its figure for each Bot is the number of rows Settings →
  Activity lists for that Bot. In both editions the report names each Bot and says what was refused
  in words, where it showed ids, and one request writes one row, where a refused one wrote up to
  three.

### The Bot's browser

- **A click, key press or typing that can't finish says why**: the page refused to send its form,
  something covers the element, it is hidden or turned off, or the page is still loading. The Bot
  was told the element was "not on the page any more", and tried the same thing again.
- **A dropdown keeps the Bot's choice.** A Bot that opened a dropdown, typed its choice and pressed
  Enter keeps the choice. Enter put the dropdown back to the option it showed when opened, such as
  "Choose one", so the form was sent without it.
- **A token in a page's address no longer counts as changing a credential.** A Bot filling in an
  ordinary form on a page whose address carries a signature or token after its path (an S3
  presigned link's `X-Amz-Credential=`, a sign-in's `access_token=`) is no longer handed to you. A
  password field, a Change password button or a security page's path still hands it to you.

### Smaller changes

- A check-in's next run is counted on the server's clock, the clock that decides when it is due. It
  was counted on the database's clock, so with the two clocks apart a check-in came that much
  earlier or later than its interval: a database a few milliseconds ahead put a 4-hour check-in a
  few milliseconds past 4 hours out.
- Asked which AI model it runs on, a Bot whose model you pick in the composer names the one the
  model picker shows, such as "GPT-6.1 Terra", and the new one after you pick another, where it said
  it couldn't see its model's name.
- Asked which framework it runs on, a Bot names what runs it, whatever its subtitle says: OpenBot
  for a Bot that runs in OpenBot, the framework picked in OpenBot Desktop's setup, or the framework
  picked from **New Bot**'s list, where it said it didn't know. An agent you already run is told
  none.
- On a Claude or ChatGPT plan, Auto-review and the choice of which Bot an untagged message goes to
  run on the plan. Auto-review asked you about every change it should have judged, and such a
  message went to your default Bot unless it named an app only one Bot has. Auto-review still asks
  you when the plan errors, gives no clear answer or does not answer in time.
- A Bot that runs at another address, on a framework such as OpenBot Desktop's starter Bot or one
  you run yourself, is never sent more than 128 tools in one request, counting the ones your browser
  adds. With an OpenAI key the starter Bot now answers, where every message failed with "Error code:
  400 - Invalid 'tools': array too long". OpenBot's own tools, Routines and web search come first,
  then the app tools closest to what you asked. On a Claude or ChatGPT plan, choosing which tools a
  message needs now runs on the plan, where it failed and every tool was offered.
- The sidebar shows the OpenBot release the server runs, such as "v0.3.3", in small grey type under
  your name at the bottom left. In OpenDots it is under your name in the account menu and the phone
  drawer. Nothing shows when the server has no version, as in development.
- A Bot made with **New Bot** says what runs it under its name: "Powered by OpenBot" for one that
  runs in OpenBot, "Powered by" and the framework for one on a framework from the list, and nothing
  for an agent you already run. Its subtitle was empty. LangGraph is called "LangChain (LangGraph)"
  in that list and in OpenBot Desktop's setup window.
- In an interface a Bot draws, such as the "Build a trip budget" starter task, a total adds up the
  numbers you type, where it joined them as text ("Total $10025080"). A number box you clear counts
  as zero.
- The "Find weekend plans" starter task asks the Bot to check each event's date and any price on its
  source page, and to leave out what it can't confirm.
- A Bot's step reads in words from the moment it starts, whatever the tool: "Drawing an interface",
  then "Drew an interface", where it showed "render_ui", and "Web search" for a tool with no label
  of its own, where it showed "web_search" until the Bot's next step joined it.
- A Bot that can't be reached says so by name: "Couldn't reach Personal Assistant. Check that it's
  running and that its address on its Setup page is right, then try again." The conversation showed
  the connection error, such as "ECONNREFUSED: Unable to connect. Is the computer able to access the
  url?", which now goes to the server log.
- When the model provider refuses a turn, the conversation says so in words, names the provider and
  says what to do, such as "OpenAI didn't accept the API key. Check that it's set, correct and still
  active, then try again." It showed the provider's error, such as "Error code: 400 - Invalid
  'tools': array too long", which now goes to the server log. A Claude Agent SDK Bot's refusal no
  longer reads as its answer.
- A Bot's step that asked for a tool the Bot doesn't have reads "didn't work" and opens to "This Bot
  asked for a tool it doesn't have, so it carried on without it." It opened to the error written for
  the model, listing every tool the Bot has by its raw name.
- A table, chart, card or question a Bot couldn't draw says so in its own card ("Couldn't show the
  data table.") and says to ask the Bot to try again. It showed "Waiting for complete table data…"
  or an empty card for good, also after a reload.
- When a Bot's turn fails partway, after steps such as using its computer, the conversation says so
  under the turn, as it does for a turn that fails at once. It ended on the steps with nothing said.
- A reply that arrives while OpenBot Desktop's window is covered, or while the tab is in the
  background, is drawn in full. It stayed cut off mid-sentence until the window was back in view.
- A notice a Bot draws labels its badge "Good news", "Heads up" or "Problem", where it showed the
  tone's own name, such as "positive".
- With reduced motion turned on in the operating system, a step a Bot is still running shows its
  words, in the same muted tone as a finished step. It showed only its ▸, or nothing.
- Pressing + starts a new conversation with your Bot picked, the default Bot in the personal
  edition and the only Bot wherever there is just one, where To: started empty and you had to pick
  it. With several Bots in the team edition, + opens the To: picker with the caret in it every time,
  where a second press left it closed. You can write the message before choosing a Bot, and Enter or
  Send with nobody in To: keeps the message, opens To: and says "Choose a Bot first."
- A renamed Bot's conversations go by its new name in the sidebar, the conversation header and the
  lists you pick a conversation from, including conversations started before the rename. They kept
  the name the Bot had when each began.
- The sign-in dialog that **Open private sign-in** opens no longer leaves large empty gaps above
  "Use a saved login" and "Enter your login". Its fields sit just below the sentence that
  introduces them, in the dialog and on the sign-in page.
- Settings → Components gallery, and each component's page, say what it shows, such as "Shows what
  your Bots have been doing and what was refused, read from OpenBot's own records." They showed the
  text written for the model ("Show what this deployment has actually been doing..."). In the
  personal edition the intro says every Bot can use all of them, where it said an admin controls
  them.
- Turning off an app you added from Composio's or Arcade's directory, or by its address, takes you
  back to Connections (Admin → Plugins for an admin), where you can add it again. Its page said "Not
  an app. There is no app with that name." An app always listed there, such as Notion, still stays
  on its page, off.
- OpenBot Desktop offers **Sign in with Unbiased AI** on the Connect your AI screen. Signing in opens
  Unbiased AI's approval page in the browser, where a person signs in or creates an account, and
  OpenBot receives an API key for the `pareto` model on Unbiased AI's OpenAI-compatible gateway. The
  key is stored on this computer the way a typed endpoint key is, and an Unbiased AI API key can be
  pasted instead. See [Model provider OAuth](desktop/PROVIDER_OAUTH.md#unbiased-ai).

## 0.3.2

**Before upgrading.** There are no migrations: the database stays at `0077_channel_opening`.
Fourteen things change for an existing deployment:
- OpenBot Desktop's setup window no longer has **Runtime updates** (moving to a release by its tag,
  verifying a baseline, staging, applying and **Restore previous release**). An installation now
  moves only to the app's own release, on Start, with a database backup first (below). Pinned
  builds (internal and candidates) move too, where 0.3.1 left them as they were. An installation on
  a newer release than the app is still never moved back.
- OpenBot Desktop installs the personal edition, and an existing installation becomes the personal
  edition on its next Start (below). Each person's Bot computer files and sign-ins are carried over
  once into the one shared computer, never over anything already there.
- OpenBot Desktop updates a local back end installed by an older app to 0.16.0-rc.9 on Start, saying
  "Updating the back end to 0.16.0-rc.9. Its data stays." If that fails, Start carries on with the
  back end it has, and tries again the next time. The app carries the back end's CLI from commit
  48a3863 (`copilotkit` 4.34.0-pre.48a3863), which installs that release.
- OpenBot Desktop's Start rewrites `~/OpenBot/.env`: it removes `OPENBOT_BROWSER_URL`,
  `OPENBOT_BROWSER_CONTAINER_URL`, `BROWSER_PORT` and `OPENBOT_BROWSER_ABSENT`, writes
  `OPENBOT_PUBLIC_URL=http://127.0.0.1:<app port>`, `OPENBOT_THIS_MACHINE_CONTAINER_HOST` and
  `COMPUTER_LOOPBACK_RELAYS`, and writes `INTELLIGENCE_API_URL` and `INTELLIGENCE_GATEWAY_WS_URL`
  with `127.0.0.1` where they said `localhost`. The server no longer reads `OPENBOT_BROWSER_ABSENT`.
- A Windows installation of OpenBot Desktop from an earlier release has no updater, so install this
  release by hand once. Later releases arrive in the app (below).
- Claude Agent SDK Bots no longer have Claude Code's own tools (Bash, Read, WebSearch, Agent and the
  rest). They act only through the tools OpenBot gives them, as every other Bot does (below).
- A Bot registered by its own AG-UI or Mastra address is no longer run to name its conversations:
  OpenBot names them itself, as that Bot, on the deployment's model, as it does for built-in Bots.
  Such Bots no longer receive `forwardedProps.copilotkit.ui`, the catalog of components the chat can
  draw (about 100 KB a turn). They still get the `render_ui` tool and its guide. An agent of your
  own that read that field no longer finds it.
- A routine a Bot creates without naming a time zone runs in the person's time zone, when the
  browser sent it, instead of UTC (below).
- In the personal edition, every Bot can ask every other Bot for help. The per-Bot handoff settings
  are hidden, and taking one away is refused with "In OpenBot Personal every Bot can ask your other
  Bots for help."
- `docker-compose.yml`: the Bot computer gets the `NET_RAW` capability, so `ping` works under
  Podman as it did under Docker, and `host.docker.internal`, `OPENBOT_EDITION` and
  `COMPUTER_LOOPBACK_RELAYS`. The server gets `OPENBOT_THIS_MACHINE_HOST` from
  `OPENBOT_THIS_MACHINE_CONTAINER_HOST`. `COMPUTER_SUPERVISOR_CONTAINER_URL` set empty gives the
  server no supervisor; unset, it is `http://supervisor:4300`, as before.
- The Helm chart's bundled back end (the `intelligence` subchart) is 0.16.0-rc.9, from rc.5. Its
  Job that installs Learning's queue waits up to 15 minutes for the back end's PostgreSQL, up from 5
  (`intelligence.learning.queue.migration.activeDeadlineSeconds: 900`). `--reuse-values` drops this
  chart's defaults, so an upgrade run with it keeps the 5 minutes: pass the value, or drop the flag.
- The Helm chart now sets Automatic Learning's model itself (below), so an upgrade that sets
  `intelligence.learning.agent.model` is refused: use `config.learning.model`.
- Three Teach a Bot changes need the Recorder from this release: a recording is said to be saved
  only once the back end has all of it, the first page reached after pressing Record is recorded,
  and the Recorder's statuses name OpenBot's back end.
- A personal edition set up with `start.sh` under v0.3.1 starts on this release. Its package is now
  called `openbot`, and the server would have refused the Personal Assistant it seeded as `personal`
  as another package's Bot and stopped. `brand.yaml` takes `tenant.former_ids`: a deployment set up
  under one of them keeps its Bots, conversations and deployment name. See
  [configuration](docs/configuration.md#brandyaml).

### Starter tasks

- Your starter Bot offers five tasks to try: connect an app, build an interactive answer, search
  the web, read a page in its browser, and add a task to a demo checklist. The suggestions stay in
  your first new starter-Bot conversation, including after an upgrade, and never appear in later
  conversations.

### OpenBot Desktop starts on Windows

A Windows installation of 0.3.1 never finished starting. Now:

- The back end's CLI is given Podman's root connection by name, which Podman accepts where it
  refused the named-pipe address.
- The CopilotKit account step waits, up to 15 minutes, while setup is still installing Podman,
  instead of failing with "Couldn't check your CopilotKit account. Try again."
- Moving an installation that never started (every Windows one from 0.3.1) to this release no
  longer makes an empty database while backing up, and so no longer loops on "Start fresh". With no
  database, nothing is backed up or restored.
- A port counts as taken when anything answers on it. On a Mac, a server listening on every address
  no longer looks free.
- Upgrading or uninstalling no longer fails because the bundled CLI's `node.exe` is still running:
  the installer stops it and waits up to 30 seconds for it to exit before replacing it. The 32-bit
  installer could not see the 64-bit process before.

### OpenBot Desktop has one way to upgrade, with a backup and a way back

When the installation is not on the app's own release, Start stops OpenBot, backs up the database,
sets the previous version's files aside, lays out the new release, downloads its images and starts
it, saying "Updating OpenBot from X to Y. Your Bots, sign-ins and data stay as they are." Any failure
puts the files and the database back and starts the previous version: "OpenBot couldn't update to Y,
so it's still on X, with your data as it was." If the app stopped part way, the next Start puts
things back first. The database is restored even while something else holds a connection to it.

- The line under Start's rows names the step running now: "Stopping OpenBot.", "Backing up
  OpenBot's database.", "Downloading OpenBot Y.", "Installing OpenBot Y.", "Starting OpenBot Y." or
  "Putting OpenBot's database back.", and after a rollback "OpenBot is back on X." On Windows it used
  to say "Stopping OpenBot." for a whole Start.
- Setup lays out only `docker-compose.yml` and the list of images: no source for the server, app or
  worker, nothing installed on the computer itself, and no "Recorder" or "Your browser" rows.
- The first Start after an app update no longer fails updating the local back end while Quit had it
  stopped: it starts the back end first and updates it once it is up.
- OpenBot left running behind the app (an installer closed the app without Quit, or it crashed) is
  no longer shown as current when it is older than the app: the window stays on setup, and Start
  upgrades it. One on the app's release is shown and run by the app, so the menus no longer say "Not
  running", Quit stops it, Stop and Restart work, and so do local folders and the watch that sends
  the window back to setup when the server stops answering.
- Installing shows a progress bar with how many items are left, instead of each image's size and
  speed, and no time elapsed.

### OpenBot Desktop tells you when a newer version is out, and Windows updates itself

OpenBot Desktop on a Mac or on Windows checks at launch and every six hours while it runs, and shows
a bar in OpenBot's own window, "OpenBot 0.3.2 is available.", with **Update and restart** and a close
button. The setup window offers the same, with **Not now**. Closing either hides the offer until a
newer version comes out, across reloads and restarts. **Update and restart** downloads the update
and checks its signature while OpenBot keeps running, then stops OpenBot and restarts the app, and
that Start moves your OpenBot to the new release (above). On Windows the installer then runs with a
small progress window and no questions, and starts the new version; your installation and settings
stay as they were.

Before, only the Mac app's setup window offered an update, checked once at launch, and **Not now**
lasted until the app was next opened; the Windows app never updated itself. The app reads its updates
from `downloads.copilotkit.ai`, and from GitHub only when that does not answer. Internal and
candidate builds have no updater and show nothing, and a self-hosted OpenBot (Helm or Compose) never
checks.

### OpenBot Desktop installs the personal edition

One computer is shared by your Bots, and you start with the Personal Assistant. Before, it
installed the team edition, with its admin screens, the fintech example's Bots and a computer for
each Bot. It runs no supervisor and no bundled Bot containers, so an installation downloads three
fewer images. The Bot framework picked during setup is a second Bot beside the Personal Assistant.
See [Personal edition](docs/personal-edition.md#openbot-desktop).

- **New Bot** works on a deployment with no managed Bot, Desktop included: a Bot can be made from
  instructions alone, where Desktop said nobody could make a Bot at all.
- A Bot computer whose Compose network was recreated is replaced onto the live network, instead of
  failing with "network not found".

### Teach a Bot works inside the OpenBot Desktop window

- **The browser is in OpenBot.** Desktop no longer opens a separate Chrome or Edge window: in the
  personal edition, the browser you teach in runs on your one computer and shows in the page. The
  note explaining why it was not your own browser is gone.
- **Narration stays on the device.** In the Desktop window, what you say is turned into text on
  the computer: by the Speech framework on a Mac, which asks once for speech recognition ("Your
  voice never leaves it."), and by Windows' own speech recognition on Windows.
- **Narration says only whether it is on**: "Narration is on. We're capturing your voice." or
  "Narration is off.", on every deployment. The longer explanations (no microphone, permission
  denied, unsupported browser) are gone.
- **Recordings are saved.** The back end's gateway address was handed to the Recorder as
  `ws://localhost:<port>`, which it refuses, so every Desktop recording was kept in the browser as
  not saved. The server now hands out `localhost` as `127.0.0.1`, on any deployment, and Desktop
  writes its back end's addresses that way.
- **Saved means saved.** A recording is said to be saved to your Learning space only once the back
  end has all of it. One still on its way says "Saving"; one the back end refused, such as one sent
  to a back end with Trajectories turned off, says it wasn't saved and is kept in the browser to be
  sent again later.
- **The first page is recorded.** A page reached while Record was still starting, such as an
  address typed right after pressing it, is recorded as the first step, and network capture starts
  on the page the tab is really on.

### Signing in from OpenBot Desktop

- **Outside sites open in your default browser**, `window.open` included, and come back to
  `127.0.0.1`. Desktop writes `OPENBOT_PUBLIC_URL`, so apps that sign in with their own OAuth, such
  as Notion, can connect, and `TRUSTED_ORIGINS` lists `127.0.0.1` first.
- **The CopilotKit sign-in can't get stuck.** While it waits, setup shows "Check that the page shows
  this code:" with the code, an **Open the sign-in page** link that reopens the approval page, a
  note for an account that lands on the CopilotKit dashboard after choosing an organization, and
  **Cancel**. The back end's own sign-in prompt does the same. Before, an account in several
  organizations waited forever.
- **No "access data from other apps" prompt on a Mac.** The back end's CLI and every container
  command use OpenBot's own Docker configuration, with your context, proxies and plugins but none of
  your saved registry logins, so Docker Desktop's credential helper no longer makes macOS ask, and
  setting up the back end no longer times out behind that question. Everything OpenBot downloads is
  public.
- **A covered window keeps running.** On a Mac, a window opened behind others (at login, or after
  switching away) stayed blank and ran no setup step until uncovered. It now keeps running.

### Claude Agent SDK Bots use only OpenBot's tools, and start however much they hold

- A Claude Agent SDK Bot acts only through the tools OpenBot gives it, with its approvals and
  boundaries; Claude Code's own tools are off. A tool it finds with tool search can be called.
- A Bot holding several apps (HubSpot, Notion and Google Calendar, for one) failed to start with
  "Argument list too long", because its prompt and tool list went on Claude Code's command line. They
  no longer do. If Claude Code can't start at all, the conversation says "This Bot couldn't start, so
  it didn't answer. Send your message again, and restart OpenBot if it keeps happening."

### Bots work in your day and reach what is on your computer

- The browser sends the person's time zone with every run, and Bots are told "Today is <day>,
  <date> in the person's time zone, <zone>". Without it they use UTC.
- A Bot can set up a routine however many apps it holds: the routine tools are never moved behind
  tool search.
- A Bot registered at `127.0.0.1` or another loopback address on the computer running OpenBot is
  reached through `OPENBOT_THIS_MACHINE_HOST` (unset by default; Desktop sets `host.docker.internal`).
  The address you typed is what is checked and kept. A value with a scheme, port or path stops the
  server at boot. `COMPUTER_LOOPBACK_RELAYS` (`<port>=<host>:<port>,…`) relays a computer's own
  loopback ports, and a malformed value stops the computer at start.
- Notion, and any app that lists its tools only under a person's own sign-in, gets its tools when
  the first person connects it. Before, it showed Connected with no tools until an admin pressed
  **Refresh tools**.

### Skills each have their own page

- Skills (Admin → Skills, and Settings → Skills in the personal edition, which was "Skills for every
  Bot") lists each skill as one row with its name, what it does and how many Bots offer it, and the
  row opens the skill's own page. There, each Bot has a switch, the skill's name, instructions and
  tools can be edited (the tools as one row per app), and deleting asks first. **New skill** is a page
  of its own, and opens the skill once saved.
- The `/` menu, the chip it puts in the message box and the badge on a sent message show a skill's
  name instead of its command. The message still carries the command, so a renamed skill keeps its
  badge. On the home page, `/` offers the skills of all your Bots, and a message that uses one goes
  to a Bot that offers every selected skill, with the skills' instructions; when none does, it is
  refused with "No Bot offers all the selected skills. Choose different skills or a Bot with @." A
  Bot picked with `@` gets the selected skills it offers, and the others are left out. The routing
  audit records the Bot that receives the message. The placeholder `summarize` command is gone.
- In the personal edition every Bot offers every skill: the skills there are, each new skill, and
  every skill for a Bot made later. Each Bot is given them once, so a skill switched off for one Bot
  stays off.
- A skill can ask for web research (`@research/search`, `@research/fetch`). Saving one was refused
  with "No tool by that name has been seen here".

### Every screen names the part of OpenBot it means

- No screen names the back end's own product any more; it is all OpenBot. OpenBot Desktop's setup
  window names the parts it installs and starts (the front end, the back end, the database, your
  Bots and the computers they work on), and its progress rows, errors and Status window say "the
  back end": "Waiting for the back end", "Stopping the back end". In the app, Settings, This
  computer shows a "Back end" section, Setup's first row is "Back end", Memory marks a memory "Kept
  in the back end", Automatic learning says "the skills OpenBot proposes" and "Manage Learning in the
  back end dashboard", and the server's errors that reach the browser name the back end. The
  Recorder's disclosure says recordings go to the learning part of OpenBot's back end. Env var names
  (`INTELLIGENCE_API_URL` and the rest), logs and the docs under `docs/` and `charts/` are unchanged.
- The Status window and Settings, This computer list each part by what it does: "Front end and
  Bots", "Background jobs", "Database" and "Bot computer" under "App", and "Conversations, memory and
  learning" under "Back end". Docker's names stay in Copy diagnostics. The menu bar and tray no
  longer have the item that opened the back end's own dashboard.
- A Bot's responsibilities are its goals, on every screen that shows them: "Goals", "New goal", "No
  goals yet", "Create goal", and "Worked on a goal." in the conversation.

### The Helm chart takes an Anthropic key and a model router's address

`secrets.anthropicApiKey` (or `anthropic-api-key` in your own Secret) reaches the server as
`ANTHROPIC_API_KEY`, the way the OpenAI key does. A new `config.model` block names the provider
(`BOT_PROVIDER`), the Bots' default model (`BOT_MODEL`) and a model router's endpoints
(`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`), each set only when given, and a provider the server would
silently ignore is refused at install.

- Automatic Learning follows the keys: with an Anthropic key alone, its agent runs
  `anthropic/claude-sonnet-5-5` on it; otherwise it stays on `openai/gpt-5.5` and the OpenAI key,
  as it does whenever the keys are in a store the chart can't read. `config.learning.model` names
  another, as `provider/model`. The chart sets that model through the agent's Secret, so it refuses
  `intelligence.learning.agent.model`.
- The agent reads its model when it starts: after changing `config.learning.model`, or adding or
  removing a key, restart the `openbot-intelligence-learning-agent` Deployment.
- The chart README's upgrade section says what to do when the Learning queue Job runs out of time,
  and why to give your values again rather than `--reuse-values` after a failed revision.

### OpenBot runs on CopilotKit 1.85.0

`@copilotkit/runtime`, `react-core` and `shared` move from 1.83.0, and `@copilotkit/learning` from a
patched 0.0.1. AG-UI stays 1.0.2, the version CopilotKit 1.85.0 itself pins. A run keeps its
conversation until its last events reach the back end, so a failed run's error is no longer lost,
and lets go of it itself when it ends, so the next run, such as the one that carries a command's
result back to a Bot, starts at once. With product telemetry on, each run's analytics context
reaches the back end. Generated interfaces write A2UI's version as `1.0`, and the ones a Bot drew on
0.3.0 and 0.3.1, written `v1.0`, still draw when their conversation is reopened.

### Smaller changes

- A conversation's failed last run shows its error again after a reload or when you come back to
  it. A stopped run is not a failure.
- A Bot knows that an answer it got from another Bot with `message_bot` is that Bot's. Asked to
  quote what Knowledge said, General Assistant quotes it, instead of saying it never arrived or
  calling the words its own.
- Every Bot knows its own name. "Ask the Knowledge Bot for one sentence on Helm", sent to Knowledge,
  is answered by Knowledge; a Bot that tries `message_bot` on itself is told nothing was sent,
  before any approval is asked.
- A new conversation's sidebar name no longer waits a minute when the summary runs before the
  conversation's first run has reached the back end. That miss is retried in 15 seconds, and no
  longer logs `THREAD_NOT_FOUND`.
- On a narrow window, such as Desktop's, the Computer sheet and a Bot's details sheet show the
  conversation's waiting approvals at their top, where the approval used to sit hidden behind them.
  Answering there answers in the conversation.
- Approvals and a Bot's questions are drawn as one kind of card: each answer is a row saying what
  it does, the first is picked, and one button sends the pick and is named for it. Keys 1 to 9 pick
  a row and Enter sends it, on the newest card waiting and never while you are typing. A Bot's
  approval takes words instead in a last row ("Tell the Bot something else…"), which replaces the
  reason field, and a Bot's question in "Answer something else…". Answering folds the card into one
  line with the answer; an app's approval then folds away into the conversation's line for that
  action.
- The model picker under the message box is a CPU icon, with the model and its thinking in the
  tooltip. For a model with thinking levels it opens on two columns, the models and the levels, and
  stays open after a model is picked so its thinking can be picked next.
- Save sits on the right of its form, with Cancel (or "Don't save", "Don't create") before it:
  Profile, Passwords, app consent, a Bot's proposed skill or Bot, and Automatic Learning.
- The personal edition's home page has a **Meet OpenBot for Business** link at the top right, which
  stays closed for the session once you close it.
- A quotation's source no longer starts with a comma.
- The notifications prompt over the message box has the message box's background.
- After a person hands a Bot's browser back, the Bot no longer has to take a snapshot before it
  opens another page. Only clicking, typing, pressing keys and scrolling on the page the person
  left still wait for one. The wait no longer survives a restart, so the first page a new
  conversation opens after OpenBot was quit and reopened no longer fails with "Take a fresh browser
  snapshot after handback before acting." A conversation never shows that instruction, which is
  meant for the Bot.

## 0.3.1

**Before upgrading.** There are no migrations: the database stays at `0077_channel_opening`. Ten
things change for an existing deployment:
- On OpenBot Desktop, the first Start after the app updates to this release moves the installed
  OpenBot to it too. Until now an installation kept the release it was installed at until you moved
  it under Runtime updates. While the old release keeps running, Start checks the installation
  against its release's published manifest and downloads the new release and its images; then it
  stops OpenBot, backs up the database, installs the new release and starts it, which can take a few
  minutes. A move that fails is undone, database included, and the old release starts. Pinned builds
  (internal and candidates), and an installation already on a newer release than the app, are left
  as they are (below).
- OpenBot Desktop installations signed in to CopilotKit with no Composio key get one at their next
  Start: the bundled CopilotKit CLI asks CopilotKit for this installation's own Composio project,
  and the key goes to the app's protected store, never to `.env`. Apps, unavailable on Desktop since
  0.3.0, become available. A `COMPOSIO_API_KEY` in `~/OpenBot/.env` or the environment, or an Arcade
  choice, still wins, and then nothing is asked (below).
- When nobody has picked a model, built-in Bots now answer on `BOT_MODEL` while the provider lists
  it, and otherwise on the middle of the provider's current line: the newest model of each line,
  ordered by price, and the one in the middle (on 2026-11-05, `gpt-6.1-terra`, `claude-sonnet-5-5`,
  `gemini-3.8-flash` and `grok-4.7`). With no `BOT_MODEL`, that replaces the tenant package's
  `default_model` (`gpt-5.6-terra` in the bundled packages) or, on Anthropic, `claude-sonnet-5-5`.
  On OpenAI's own API, `BOT_MODEL` now applies to built-in Bots, where it used to be ignored. A
  `BOT_MODEL` the provider doesn't list gives way to the middle: a ChatGPT plan given `gpt-5.5` runs
  the plan's middle model. Behind a gateway in `OPENAI_BASE_URL`, the configured model stays the
  default while the gateway lists it, and until the provider's list has been read the configured
  model is used. The Bot framework picked at setup, when it is OpenBot's own LangGraph or Claude
  Agent SDK harness, is sent the same model on every run (below).
- Nothing writes a `BOT_MODEL` on your behalf any more, so an unset one means the middle of the
  line. `docker-compose.yml` gives the picked harness an empty `BOT_MODEL` when it is unset, rather
  than `gpt-5.5`. OpenBot Desktop no longer writes `BOT_MODEL=claude-sonnet-5-5` for an Anthropic
  key, and takes out the one it wrote at the next Start; a model chosen on a Desktop setup screen
  (an OpenAI-compatible endpoint's, or a Google or xAI sign-in's) is still written and stays the
  default. The harness answers on the model the server sends each run, and only when the server
  sends none, because it has not read the provider's list, on the provider spec file's model for it
  (`gpt-4o-mini` on OpenAI).
- The server now reads the provider's model list (a plan's own, through its harness) and
  `https://models.dev/api.json` when it starts and every six hours after, whether or not anybody
  picks, and again at once, at most once a minute, when a provider refuses a model as unknown or
  unsupported. A refresh that fails keeps the last good list. `OPENBOT_MODEL_CAPABILITIES_URL`
  points at a mirror of models.dev, or `off` reads none, and then the default is the configured
  model while the provider lists it.
- With `OPENBOT_SINGLE_USER=true` (OpenBot Desktop and the personal edition among them), the one
  person is offered every model the provider lists, with no switch and no allowlist. Admin →
  Providers shows neither, and a model allowlist saved earlier no longer applies.
- In a team, people pick among the models an admin allows under Admin → Providers → Allowed models,
  plus the default, and "Let people choose a model" is gone. Until an admin allows one, people get
  the default and see no picker: a team that let people pick before upgrading has no picker until
  models are allowed there, and one whose list already holds models now shows them, whatever the old
  switch said. A pick on a model no longer allowed, or no longer listed by the provider, runs on the
  default and is kept for when it is offered again. "Only allowed models" still refuses a run on any
  model not allowed, the default included, so with it on, allow the new default (above) or runs
  nobody picked a model for are refused.
- A Bot's commands now run in one interactive bash on its computer, one for each Bot a person uses,
  instead of a fresh `bash -c` each (below). `cd` and exported variables carry over to the next
  command. A command's stdout and stderr come back together as its output, with `stderr` empty, as a
  terminal shows them. Something a command starts in the background with `&` keeps running after the
  command returns, even while it still prints; such a process used to hold the command open until
  its time limit stopped both. Two commands from the same Bot and person run one after the other,
  and the wait counts against each one's time limit. Commands see `TERM=xterm-256color`, and
  `PAGER=cat`, `GIT_PAGER=cat` and `GIT_TERMINAL_PROMPT=0` unless `COMPUTER_SHELL_ENV` passes
  others.
- Upgrade the server and its computers together. A computer from 0.3.0 has no terminal for the
  Computer panel's new Terminal tab to connect to, and refuses every pointer move made with no
  button held, which the live screen now sends as you hover.
- The Python LangGraph and Pydantic AI Bots set no upper bound on `google-genai`, so an image of
  either built from source since 3.0.0 came out on 2026-11-06 installed it, and 3.0.0 sends Gemini
  requests to `/v1` instead of `/v1beta`. Both now hold `google-genai` at 2.34 or later and below 3,
  and the Google ADK Bot names the same range, so Gemini is called on `/v1beta` as before.

### A Bot's commands run in one live shell you can watch and take control of

The Computer panel has a Terminal tab beside the Screen: a real terminal where you watch each of the
Bot's commands typed and its output stream, in colour. Whoever may watch a Bot's screen may watch
its terminal. Take control gives you its keyboard, as it does the browser's, and the Bot waits until
you hand back, then carries on in the same shell. The panel opens on the view the Bot last worked
in, the terminal after a command and the screen after a page; a tab you pick, or a command you click
in the conversation, holds until the panel closes.

- **The Bot gets what it got before.** Each command's output and exit code come back within the same
  time limit (120 seconds unless the Bot asks for up to 600) and the same 64 KB of output, and
  approvals and policy for commands are unchanged. What changes is under Before upgrading.
- **Commands in the conversation and in Activity are terminal blocks**: the prompt and the command,
  the last lines of output with "Show all N lines" for the rest, and how it ended, as "Exit 0",
  "Exit 1", "Running", "Blocked", "Declined" or "Done by you". Clicking one opens the Computer panel
  on its terminal.
- **A shell left busy is not typed over.** If you hand back with something still running in the
  foreground, the Bot's next command is not run and the Bot is told why. A command the Bot sends
  unfinished (an unclosed quote, bracket or here-document) is abandoned at once with exit code 2,
  instead of waiting out its time limit.
- **The shell ends** when the computer is stopped or reset, or after an hour nobody used or watched
  it, and a new one starts when it is next needed.

### Taking over a Bot's screen feels like using your own browser

- **Clicks land at once.** Your browser sends at most one pointer position per screen refresh and
  adds scrolls together, and the Bot's computer replaces a waiting move with the newer one instead
  of playing every move before your click. Clicks, keys and pastes are never merged or dropped, and
  land in the order you made them.
- **The picture is the page as it is now.** The computer sends the next frame only once the last has
  gone out, with at most two on their way to your browser, and a newer frame replaces one still
  waiting, so a slow connection no longer shows frames seconds old. The once-a-second screenshot
  stops while the full-size live view is open, and a hidden tab draws nothing until you come back.
- **Keys and the mouse behave as on your own page.** Hovering is a hover, not a drag with the left
  button held. Letting go of the mouse outside the screen lets go on the page, and releasing Command
  releases the keys held with it. Emoji type as text, Firefox scrolls normal distances, and the
  cursor is an arrow rather than a crosshair.
- **A missed input is a note, not an error screen.** One key or click that doesn't land shows a
  short note in the corner for a few seconds, and the screen stays live. One missed check of who has
  control no longer pauses your input; two in a row do, and the computer still refuses input from
  anyone not in control. A click made the moment the screen appears is held until the connection to
  the computer opens, not lost.

### OpenBot Desktop moves your OpenBot to the app's release when it starts

An updated app used to keep running the OpenBot it was first installed with, so server fixes never
reached an existing installation. Now Start moves a stable app's installation to the app's own
release, through the same path as Runtime updates, and says "Updating OpenBot from v0.3.0 to v0.3.1.
Your Bots, sign-ins and data stay as they are." while it runs. A modified installation is refused
before anything stops.

- A move that fails before OpenBot stopped changes nothing, and the next Start tries again. One that
  fails after is undone, the database restored from its backup, and the old release starts with a
  note saying so. Start does not try that release again by itself; Runtime updates can.
- Stop or Quit during a move stops it, and the next Start recovers it as any interrupted update.
- Runtime updates, and this move, download only the images this installation runs: eight for 0.3.0,
  where the release names nineteen. Staging an update no longer fails on an Apple silicon Mac with
  "no matching manifest for linux/arm64/v8" over the all-in-one `openbot` image, which Desktop never
  runs and which 0.3.0 published for x86-64 only.

### OpenBot Desktop gets your apps from your CopilotKit sign-in again

0.3.0 started every Desktop installation without a Composio key, so apps were unavailable unless you
put your own `COMPOSIO_API_KEY` in `~/OpenBot/.env`. The Account step now connects your apps once
you have signed in ("Connecting your apps…"): the bundled CopilotKit CLI, with its own sign-in,
makes or reuses this installation's Composio project, and the app keeps the key in its protected
store. If that fails, the step says so, with Connect apps to try again and Continue to go on without
apps, and every Start tries again by itself without ever stopping Start. An installation signed in
under 0.3.0 gets its key at its next Start, without signing in again.

### Signing in with ChatGPT in Desktop setup no longer ends on "localhost refused to connect"

- A browser tab that comes back after the sign-in finished (from "Open the sign-in page", or from
  approving again at OpenAI) gets an OpenBot page saying OpenBot is signed in and the tab isn't
  needed. OpenBot answers that address for 15 minutes after a sign-in ends, then gives the port up,
  and gives it up sooner to a new sign-in or to the Codex CLI.
- Starting a sign-in again no longer fails with "port is already allocated". The earlier sign-in is
  stopped first, and so is one you leave by picking another provider, Change, Escape or leaving the
  screen, whose tab then says the sign-in ended rather than "You're signed in". Quit stops it too.
- A tab left over from an earlier attempt can no longer end the attempt in progress: it is told its
  link is out of date.

### Pick the model and thinking effort for every Bot, from the provider's live list

The composer's model picker is now a text button naming the model and its thinking effort ("Claude
Sonnet 5.5 · High"), and its list adds a Thinking group with the levels the model in use accepts,
its default marked. A model is only ever shown, saved and sent the levels it takes, and switching to
a model that doesn't take the chosen effort clears it. The pick is still kept per person and
conversation, a change applies from the next message, and a new conversation saves both before its
first message.

- **Who picks from what.** One person on their own machine picks from every model the provider
  lists. In a team, people pick among the models an admin allows under Admin → Providers → Allowed
  models, which lists each with its maker's mark and thinking levels, and see no picker until one is
  allowed (above).
- **More Bots and every sign-in.** It is offered for the Bot framework picked at setup when it is
  OpenBot's own LangGraph or Claude Agent SDK harness, and on OpenAI, Anthropic, Google and xAI keys
  and sign-ins, any OpenAI-compatible endpoint, and ChatGPT and Claude plans, each listed from its
  own source (see The model list in `docs/configuration.md`). A Bot on any other framework, or a
  harness somebody brought, still picks its own model.
- **Fixed: every message failed on a ChatGPT plan** with "The 'gpt-5.5' model is not supported when
  using Codex with a ChatGPT account". A plan now runs only a model its own list offers.
- **Out of credit says so.** A provider refusing because the account is out of credit or at its
  spending limit now reads as that, naming the provider and quoting it, on built-in Bots (which
  showed "Forbidden" or a retry count) and on the LangGraph harness (which asked you to sign in
  again, and flagged the sign-in as failed). Any other refusal from the provider ends the harness's
  run with the provider's own words, where the run used to stop with no answer.
- Admin → Providers names who serves the model: OpenAI, Anthropic, Google, xAI, ChatGPT plan, Claude
  plan or OpenAI-compatible endpoint, with Google, xAI and Claude marks beside OpenAI's and
  Anthropic's. Each run logs one `run-model` line with its Bot, run id, model and effort.
- `CHATGPT_CODEX_CLIENT_VERSION` (default `0.167.0`) is the Codex client version the LangGraph
  harness names when it reads a ChatGPT plan's list.

### Every step a Bot takes with one of OpenBot's own tools reads as words

Each tool OpenBot itself gives a Bot is named in words chosen for it, in the present while it runs
and the past once done ("Using a skill", then "Used a skill"; "Saved a memory"; "Checked existing
Bots"), where most showed words split from their identifier ("Copilotkit load skill", "Remember
personal fact"). That covers skills, memory, follow-ups, check-ins, responsibilities, asking a
person or another Bot, subtasks, the browser, and files and commands on the Bot's computer or yours.

### The Mastra Bot's image installs from a lockfile

The Mastra Bot was the one Bot image built from version ranges with no lockfile, so two builds of
one release could ship different code, and a build could fail on a package npm had only just
published. It now installs from `agent-mastra/bun.lock` with `--frozen-lockfile`.

## 0.3.0

**Before upgrading.** Forty things change for an existing deployment:
- Migrations `0066_recorder_extension`, `0067_recorder_activity` and
  `0068_recorder_organization_session_expiry` add six tables for the OpenBot Recorder and each
  person's own Learning space (`recorder_connect_codes`, `recorder_connections`,
  `recorder_trajectory_bindings`, `learning_person_spaces`, `learning_skill_sharing`,
  `learning_open_skills`), then nullable columns on the first two. Nothing existing changes, and
  they stay empty until somebody uses Teach a Bot, connects a browser or changes Settings →
  Learning.
- "Teach a browser workflow" is gone, with its routes under `/api/demonstrations`, its instant
  Skill draft, "Save and use with this Bot" and "Run on a schedule". Skills saved from it stay, as
  ordinary Skills, and its recordings stay in the database, unread. Record in Teach a Bot or in a
  Bot's browser replaces it (below).
- Routines is now always on, in every edition. At start, OpenBot adds the Routines app if it is
  missing and gives its tools to every Bot, including Bots made later. It can no longer be removed,
  and a Bot's Routines tools can no longer be taken away (both answer 403). An MCP allowlist never
  refuses it.
- With `BOT_PROVIDER=anthropic` and no `BOT_MODEL`, Bots move from `claude-sonnet-4-5`, which
  Anthropic retires on 2026-11-30, to `claude-sonnet-5-5`, and choosing Anthropic in Desktop setup
  writes `claude-sonnet-5-5`. A `BOT_MODEL` you set is left alone.
- A Bot that deletes, sends, shares or posts, on a schedule too, now waits for approval every time,
  in both editions. An Always allow saved for one of these, including one given on a private-share
  card for a send, no longer applies. Through an app, removing something and a scheduled send now
  ask every time, and paying an invoice or order, running payroll, and upgrading, downgrading or
  changing a paid plan are handed to the person.
- A hosted computer's browser now runs headed by default (full Chromium on the computer's own
  virtual display), which uses a little more memory. `COMPUTER_BROWSER_MODE=headless` (Helm:
  `computers.browserMode: headless`) keeps headless.
- A computer now closes browsers nobody is using when its memory reaches 85% of its limit (in the
  `openbot` image that share counts the database and the API server too), and a Bot's background
  tabs after ten minutes untouched. `COMPUTER_MEMORY_HIGH_PERCENT=0` and `COMPUTER_TAB_IDLE_MS=0`
  (Helm: `computers.memoryHighPercent`, `computers.tabIdleMs`) keep the old behaviour. Helm's
  `computers.browserIdleMs` and `computers.maxBrowsers` now take effect on `sandbox` computers, and
  wherever a value rendered in exponent form (an hour as `3.6e+06`) or was `0`.
- Bots now share one computer per person. Migration `0069_isolated_bots` adds
  `agent_profiles.isolated`, off for every existing Bot. The supervisor stops the old per-Bot
  containers when it starts and leaves their volumes for you to remove. A private Bot's logins move
  to its owner (with the supervisor, its files too); people sign in again once to public Bots, and
  on Helm `sandbox` to every Bot. Helm's computer memory defaults rise to a 2Gi request and an 8Gi
  limit.
- Computers the supervisor or Helm `sandbox` runs are replaced or restarted the first time each is
  used after upgrading, to take a token of their own (and, under the supervisor, the permissions
  package installs need). Files and sign-ins are kept.
- A single-user OpenBot now refuses a request addressed to a host name no setting names and, run on
  your own machine with no address beyond it configured, any other machine. Set
  `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or `TRUSTED_ORIGINS` to the address other machines use, or
  configure sign-in. A page on another origin that calls OpenBot from a browser must be listed in
  `TRUSTED_ORIGINS`.
- A Bot's endpoint no longer receives `Authorization` or `x-*` headers from the person's request. A
  remote Bot that read one must be given it as one of the Bot's own headers.
- In the `openbot` image, `sudo apt-get` and the other package commands are refused. A Bot uses
  `sudo openbot-apt install <package>`, as its tool description now says.
- Migration `0054_memory_on_intelligence` adds two columns to `personal_memories`. On a deployment
  entitled to Intelligence memory, the memory sweep then copies existing reviewed, switched-on
  memories into Intelligence, a few people at a time each minute; it is idempotent and safe to
  interrupt. Memories awaiting review, paused or forgotten stay local until that changes.
- With nothing saved under Admin → Automatic Learning and no
  `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`, the server assigns the project's `openbot` Learning
  container once it exists (below). A saved setting, including off, is never changed;
  `OPENBOT_LEARNING_AUTO_ASSIGN=false` (Helm: `config.learning.autoAssign: false`) prevents it.
- Migration `0055_default_opt_outs` adds `default_opt_outs`, where a person's removal of a default
  memory source or check-in is recorded. Each app a person connected with their own account
  then becomes a memory source for each of their Bots that can read it (below). Only removals from
  now on are recorded: a source somebody deleted before the upgrade comes back on that Bot's next
  turn for them (one turned off and kept stays off). `OPENBOT_MEMORY_SOURCE_DEFAULTS=false` (Helm:
  `config.memory.sourceDefaults: false`) prevents it.
- Migrations `0071_proactive_check_ins`, `0072_check_in_read_labels` and `0075_individual_check_ins`
  add the check-in tables, `mcp_tools.declared_read`, and `proactive_settings.subject` and
  `source_link`, and let a Bot hold more than one check-in. Background research already set up keeps
  running as a check-in on everything the person connected (below). It now reads only apps they
  connected with their own account, is skipped when the Bot can read none of them, and what it finds
  reaches them through Needs you and one message an hour instead of a message per suggestion. No
  check-in is switched on by itself unless `OPENBOT_PROACTIVE_DEFAULTS=true`.
- Migration `0070_memory_dedup_per_bot` rebuilds one unique index on `personal_memories` to include
  the Bot that formed the memory (below). It keeps every row. While it rolls out, a server still on
  0.2.0 fails to save a newly formed Bot memory until it is replaced; nothing else is affected.
- OpenBot Desktop now sends OpenBot's product usage events by default (below). This release showed
  no notice of it; a later release says so on the first setup screen. Launching it with
  `DO_NOT_TRACK=1` or `COPILOTKIT_TELEMETRY_DISABLED=1` turns them off with the rest of its
  telemetry.
- Migration `0060_app_access_requests` adds one table, `app_access_requests`, which keeps people's
  requests that an admin switch on an app, grant it to a Bot or connect a Shared app's team account.
  It starts empty.
- Migration `0073_entra_scope` adds a nullable `mcp_servers.entra_scope`. Servers without it behave
  as before.
- Migration `0074_single_user_identity` adds the `brokered_identities` table and lets
  `pending_authorizations.action` be null. **A single-user deployment on Composio connects each of
  its apps once more after upgrading.** At its next start it gets its own user id at the broker
  (below), and its connections recorded under `dev-local-user` are removed from OpenBot, because no
  broker can move a connection to another user id. Nothing is ended at Composio, since other
  OpenBots on the same key may be using those accounts. Deployments that sign people in keep their
  ids.
- Behind an `OPENAI_BASE_URL` that is not OpenAI or Azure, the built-in Bots now reach most
  `openai/...` models through Chat Completions instead of the Responses API (below). A gateway that
  serves only the Responses API needs `COPILOTKIT_OPENAI_API=responses`.
- Interfaces a Bot drew before the upgrade (A2UI 0.9) no longer draw when a conversation is
  reopened. The messages around them stay.
- With both `COMPOSIO_API_KEY` and `ARCADE_API_KEY` set and no `OPENBOT_BROKER_PROVIDER`, the server
  now refuses to start. Set `OPENBOT_BROKER_PROVIDER=composio`, or unset the Arcade key. Migration
  `0058_arcade_provider_backfill` also marks Personal any Composio app that holds accounts but had
  no account mode, which the server used to refuse to call.
- With both `CPK_INTELLIGENCE_API_KEY` and `INTELLIGENCE_API_KEY` set, the server now uses
  `CPK_INTELLIGENCE_API_KEY`. If that one is left over from an older project, remove it.
- A source checkout with no `COMPOSIO_API_KEY` and no Arcade key now has `scripts/start.sh` create a
  Composio project and write its key to `.env`, with `.env.openbot-installation-id` naming the
  installation to CopilotKit. Keep that file across restarts and never copy it to another
  installation.
- OpenBot Desktop for Mac installed from v0.2.0 or earlier cannot update itself. Install a signed
  `.dmg` from this release by hand once; the app it installs offers later releases itself. Building
  the Desktop app from source now needs Rust 1.90 or newer.
- Migrations `0061_suggestion_superseded` to `0065_owner_shared_audience` only add to existing
  tables: a `superseded` status for `proactive_suggestions`, an empty `action_policy.labels`
  (existing boundary rules show as "Custom rule" until named), an index on `work_items`, and the
  nullable `mcp_servers.owner_grants`, `plugin_grants.granted_as` and
  `shared_use_approvals.approved_as`.
- On one shared computer (Helm `computers.mode: shared`, or no supervisor), each person's files for
  each Bot now live in `computers/<person id>~<Bot id>` on the workspace volume (below). Files saved
  before the upgrade stay at the root, where no Bot sees them; move them into a folder to keep them.
- Migration `0056_sign_in_code_step` widens the check on `sign_in_requests.status` to allow
  `code_required`. Upgrade a server and its computers together: an older computer has no
  `/sign-in/code`.
- A "Never submit a form" boundary rule added before this release still reads `key == "Enter"`, so
  Shift+Enter, Control+Enter and Space get past it. Add the preset again, or change `key == "Enter"`
  to `intent == "activate"` in your copy (and in `AGENT_COMPUTER_POLICY` if you took the line from
  `.env.example`).
- The built-in safety rules now hand a refund to the person. A Bot that issued refunds on its own,
  for example with `SHOPIFY_CREATE_REFUND`, hands each one back to you instead.
- With `OPENBOT_SINGLE_USER=true`, an address with no scheme (such as `example.com:3010`) in
  `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or `TRUSTED_ORIGINS` now stops the server starting instead
  of only warning. Write it with its scheme so it is judged by its host.
- A Bot on the Claude Agent SDK harness starts a new Claude process for every turn instead of
  keeping one per conversation, so each turn starts a little later (about a second or two), and a
  conversation past about 100,000 tokens now leaves out its oldest messages.
- Picking the Bot for an untagged message from home now calls `claude-haiku-5-5` (Anthropic) or
  `gpt-6-luna` (OpenAI) on the deployment's key, and falls back to the Bots' model when the provider
  refuses it. `ROUTER_MODEL` names another. Behind `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, or
  with a model allowlist that leaves it out, routing stays on the Bots' model.
- Admin → Enterprise controls is gone: `/admin/enterprise` opens the Admin overview, and its
  switches are on Permissions, Providers, Identity providers, Computers, Plugins, Automatic learning
  and Audit (below).
- OpenBot Desktop no longer connects to a hosted or self-hosted Intelligence. An installation set
  up that way opens at the first screen and sets up Intelligence on this computer, keeping its
  install, database and Bots; its conversations stay in the old Intelligence.
- On a Podman machine an earlier OpenBot Desktop made, local Intelligence will not start until you
  stop the machine, run `podman machine set --rootful` and start it again. OpenBot's data stays.
- The Helm chart now installs its own Intelligence. A release on managed Intelligence or one of its
  own needs `--set intelligence.enabled=false`; until then the chart refuses the upgrade,
  `--reuse-values` included. `routines.enabled` now defaults to `true`, and a changed value under
  `secrets` restarts the server.
- Migration `0077_channel_opening` adds a nullable `channels.opening`.

### Teach a Bot: do a task once in your own browser, and your Bots learn it

The OpenBot Recorder is a Chrome and Edge extension that records a task while a person does it and
sends it, masked in the browser first, straight to Intelligence as a trajectory in that person's
own Learning space. Every Bot they use then gets the Skills learned from it (next section). OpenBot
hands out a pass for each recording and is told only that one is running: its name, when it started
and how many steps it has. **Teach a Bot** in the sidebar is where a person starts, in every
edition, and it carries a red dot named for the recording while any of their Recorders records.

- **On OpenBot Desktop, and in the personal edition**, Teach a Bot opens your installed Google
  Chrome (or Microsoft Edge where Chrome is missing) as a window on your desktop, in an OpenBot
  profile of its own, with the Recorder in it and already connected as you. The page takes you
  through three steps: what it does, the task's name and narration, then **Open browser and
  record**. Stop from the Recorder's mark at the top of a recorded page, which asks whether to save
  or discard, or with Stop on the page, which says what was saved. Without Chrome or Edge (a Flatpak
  build does not count), Desktop shows a browser inside the page instead and says why.
- **On hosted OpenBot**, Teach a Bot is the computer's Chromium shown in the page, with tabs, an
  address bar, back, forward, reload and Record. It runs on a computer of its own (a supervisor's
  or a Sandbox), only you can see or use it, and it reaches the open web, OpenBot and the
  Intelligence gateway, never anything else inside the deployment. Where every Bot shares one
  computer, Teach a Bot is hidden.
- **In a Bot's own browser**, with nothing to install: open the Bot's screen full size, take control
  and press Record. Only you are recorded: handing control back, or the Bot's request ending, stops
  the recording, and the Bot acts again only after it. Each recording gets its own Recorder
  connection, ended at Stop. Record works where each person has a computer of their own (the
  supervisor, which OpenBot Desktop and laptops use, or a Sandbox) and in the personal edition.
  Where every Bot shares one computer (Helm `shared`, or `AGENT_COMPUTER_URL` with no supervisor),
  it is refused and the panel says why: another Bot's shell could read the Recorder's connection
  there.

What a recording holds is said before the first one, in the Recorder, in Settings → Browsers and in
Teach a Bot: every tab you use until you stop (each shows that it is recorded, with a button that
leaves that site out of this and every later recording), the pages and what is on them, your clicks
and typing, the request and answer of a step that saves something, the conversation with an AI
assistant on the page that speaks AG-UI (OpenBot's own chat included, your messages too), and your
narration once you turn it on, turned into text on your own computer. Passwords, one-time codes,
secret fields, card numbers, email addresses, keys and sign-in tokens are masked in the browser
before anything leaves it; names, phone numbers and amounts are not.

**Settings → Browsers** connects the Recorder in the browser you are using and lists every browser
connected as you, a Bot's browser during a recording included, each with a Disconnect that signs
its Recorder out at once. A connection also ends when your sign-in ends (signing out, signing out
everywhere, an admin removing you or requiring SSO, your organization's session ending) or after it
goes unused as long as a sign-in lasts, and a recording kept for a person who never connects again
is deleted unsent after 7 days. Connecting to another OpenBot, or as another person, always asks
first. The Recorder is not yet in the Chrome Web Store or Edge Add-ons; until it is, OpenBot Desktop
does not add it to your everyday Chrome or Edge.

### A personal edition for one person on one computer

`OPENBOT_EDITION=personal` runs OpenBot for one person on their own machine, without the screens
that govern other people. Unset, or `team`, is OpenBot as before. `scripts/use-personal-edition.sh`
writes its settings into `.env`, and `scripts/start.sh` then starts one computer, no Bot containers
and one Personal Assistant, which runs inside the server. The server refuses to start, naming the
variable to change, unless `OPENBOT_SINGLE_USER=true`, no sign-in provider or
`OPENBOT_ORGANIZATION_AUTH_URL` is set, and `AGENT_COMPUTER_URL` names the one computer with no
`COMPUTER_SUPERVISOR_URL` or `COMPUTER_SANDBOX_NAMESPACE`.

- **Ordinary changes run without asking.** Ask before making changes is off until the person turns
  it on, at onboarding or in Settings → Approvals, and a choice already saved is kept. Paying and
  buying are handed to them, and deleting, sending, sharing and posting ask, as in the team edition
  (below).
- **Web search works from the first start.** The personal edition adds Parallel Search, Parallel's
  free web search with no key, once, so every Bot, including ones made later, can search the web and
  read pages; queries and the addresses of pages a Bot reads go to Parallel. Turned off, it stays
  off (`personal_default_apps` in `enterprise_settings` remembers it). Startup does not wait for it:
  offline, the server asks Parallel for its tools again in the background and on each start until it
  answers.
- **Connections is the one place for apps.** One press connects an app and gives every Bot every
  tool it lists, writes included; an app cannot be taken from one Bot. A Bot that needs an app not
  yet connected offers Connect in the conversation, which turns it on and opens its sign-in.
- **Fixed, with no screen to change them:** local computer access, Slack and Teams, Team Bots,
  Isolated Bots, SSO, action recording, model and MCP allowlists and Skill sharing are off, and the
  computer is never stopped for being idle. Values a team deployment left in the database are not
  read.
- **The menu is Bots, Connections and Settings.** Settings holds saved logins, keys, Skills,
  Computer and Activity. Admin becomes OpenBot for Business, a short list of what the team edition
  adds, and the API behind team-only screens answers 404 (people, identity providers, enterprise
  controls except `/api/admin/enterprise/me`, the admin learning and check-in settings, SCIM, SSO).
- **Teach a Bot works here too.** `scripts/start.sh` starts your installed Chrome or Edge with the
  Recorder in it, as OpenBot Desktop does (`scripts/stop.sh` stops it), and starts the one computer
  as yours (`COMPUTER_PERSON_ID`), so Record works in your Bots' browsers.

See `docs/personal-edition.md`.

### OpenBot Desktop runs CopilotKit Intelligence on your own computer, set up from the app alone

OpenBot Desktop now sets up OpenBot for one person with CopilotKit Intelligence on the same
computer: Account (sign in to CopilotKit and accept the Intelligence evaluation licence), Install,
AI and Start. Install starts on the first click and shows each image's size and speed. The installer
carries a CopilotKit CLI preview (`copilotkit` 4.33.1-pre.256cc68, pinned in
`desktop/intelligence-cli.json`) that installs Intelligence 0.16.0-rc.5, a release candidate and the
same release the Helm chart installs, and its Node, checked against pinned digests. The CLI runs the
Intelligence; sign-in shows OpenBot's own page when the CLI offers it. OpenBot opens once
Intelligence is ready with a valid licence, and the app warns five days before the licence expires.

- **Only this Intelligence.** No hosted or self-hosted option, organization sign-in or Bot picker.
- **OpenBot runs in containers**, from the published `openbot-server` image, not as Bun processes
  the app installed. New installations are Compose project `openbot-desktop`, apart from a source
  checkout's; an earlier one keeps its project and data.
- **A new Podman machine is rootful**, as Intelligence needs. On Windows, setup turns on WSL 2 with
  one prompt and a restart, and says when the machine cannot run it.
- **Settings → This computer**, in the Desktop app only, shows each part's memory, with Restart,
  Stop and Copy diagnostics. Stop and Quit stop Intelligence too, if the app created it.
- **Apps need your own `COMPOSIO_API_KEY`** in `~/OpenBot/.env`.

### Deleting, sending, sharing and posting always ask first

In both editions a Bot now asks before it deletes or removes something, sends to other people (a
scheduled send too), shares or posts, whatever Ask before making changes, a rule or Auto-review
says. The card offers Allow once or Deny: Always allow is not offered, and the server refuses one.
Paying and buying are still handed to you to do yourself, and now also cover an app tool named for a
transfer of money, a payout, withdrawal, charge or order, paying an invoice or order, a payroll run,
an app subscription, or upgrading, downgrading or changing a plan, and buttons such as Transfer,
Place your order, Send $20, Upgrade, Change plan, and Subscribe for a paid plan. Moving a
repository or ownership is not a payment.

The four are recognised only by what the action is called: an app tool's first verb
(`GMAIL_SEND_EMAIL`, `GOOGLEDRIVE_DELETE_FILE`), so marking a comment as spam, liking a post,
cancelling a scheduled send or a request named for the web's POST method
(`STRIPE_POST_V1_PLANS_OVERVIEW`) is neither a send nor a post; or a browser button whose label
starts with the action (Delete, Send, Share, Post) or is exactly Remove, Comment or Reply. Removing
somebody's access asks as sharing. An app call with an email address in `to`, `cc` or any argument
named for attendees, invitees or guests is a send, so a meeting invitation asks through every
calendar app, and so are Cmd+Enter or Ctrl+Enter, and Enter in a box for a message, reply or
comment. Drafts, edits, labels, events with no guests, a Bot's memory, and files and commands on its
own computer stay ordinary. An action whose tool or button doesn't name it (an unlabelled icon,
trashing mail by relabelling it) isn't caught: Auto-review, Ask before making changes or a rule
covers those.

You are asked once: a connector send asks on the send itself, not on a private-share card first,
and a Bot OpenBot runs is told not to put its own approval card in front. See `docs/approvals.md`.

### Each person's Bots share one computer, and a Bot can have its own

Every Bot used to have a computer of its own: on a laptop or Desktop a container per Bot running all
the time, and for a public Bot one set of logins shared by everyone who used it. Now all the Bots a
person uses run on that person's one computer, each with its own browser profile and folder, so a
login belongs to the person and the Bot. Tick **Isolated** when making a Bot, or in its Setup, to
give it a computer of its own; everyone who uses that Bot shares it and whatever is signed in there,
which its Setup says. Admin → Permissions → Isolated Bots decides who may: on for everyone
by default, or limited to roles and groups. A Bot whose owner loses the switch runs on the owner's
computer from its next run, and its Setup says why. A deployment with one shared computer (Helm
`shared`, or no supervisor) cannot isolate a Bot, and the checkbox says so.

The Bots on one person's computer are not kept from each other: a command any of them runs, a public
Bot somebody else made included, can reach anything on that computer. Admin → Computers says so; a
Bot that must be kept apart is made Isolated. Removing a person or deleting an isolated Bot leaves
its computer until an administrator resets it there, which signs every Bot on it out.

With the supervisor on a shared network (Compose), a computer whose container name is longer than
DNS allows (63 characters, which a longer `COMPUTER_NAMESPACE` reaches) is now reached by its short
container id. Before, it started healthy and the server could not reach it.

### OpenBot answers only its own pages, and a single-user install only its own machine

- **Other websites.** The CopilotKit runtime answered CORS for every origin, so a page on any
  website could use OpenBot through your browser. It now answers only OpenBot's own origins (the
  public and app URLs, `TRUSTED_ORIGINS`, and on a single-user install the app's port on loopback
  and on each configured host) and the Recorder. A request that changes something, and every
  WebSocket, from another site's page is refused with 403 in every auth mode. Requests with no
  `Origin` and no `Sec-Fetch-Site` (webhooks, the worker, Bots calling back, the mobile app, CLIs)
  are unaffected, and `/api/auth/*` keeps Better Auth's own check.
- **Single-user installs** (`OPENBOT_SINGLE_USER=true`, OpenBot Desktop among them) admit the
  administrator only for a request addressed to `localhost`, a loopback address or a configured
  URL's host, which stops DNS rebinding; in a container, or once an address beyond this machine is
  configured, any IP address too. Run on the person's own machine with no such address, only a
  caller on that machine is admitted, and `app/serve.ts` and the Vite dev server answer only that
  machine. OpenBot's images set `OPENBOT_IN_CONTAINER=true`, so containers keep admitting callers
  through the container engine.
- **Computer tokens.** Each person's computer and each isolated Bot's, under the supervisor or Helm
  `sandbox`, now holds its own token derived from `COMPUTER_TOKEN`, so a Bot that reads its
  computer's token can open that computer and no other. The one shared computer is unchanged.
- **A Bot's endpoint** no longer receives `Authorization` or any `x-*` header from the request of
  the person running it. The Bot's own key and the deployment's agent token are still sent.

### Bots offer check-ins and tell you when something needs you

Background research is now check-ins, and a Bot asks before it starts one. After it reads something
that keeps changing (a document, a project page, your inbox), it can offer a check-in on that one
thing: a card in the conversation with Turn on, Not now and how often (once a day unless you pick
twice a day, every four hours or every hour). Nothing runs until you accept. A Bot can watch several
things, each listed by name on its Memory page.

A check-in only reads, only in apps the person connected with their own account (never a Shared
app's team account or the deployment's own key), and only what is new since the last check-in that
read everything. When something needs the person it raises an item saying why and where it came
from; when nothing does, nothing is sent. The person hears at most once an hour, with every Bot's
items in one message: in Needs you with a badge and a browser notification, by phone push, and on
Slack, Teams or SMS where they already talk to a Bot. Work on it opens a task in a new conversation
with that Bot, which asks before every send or change. Dismiss keeps an item from coming back from
any of their Bots for 30 days.

Settings → Notifications holds a Check-ins switch for all of a person's Bots and "Something needs
you", where these messages go. Admin → Check-ins turns them off for everyone, sets the daily limit
(24 a day per Bot for each person) and shows counts per Bot. `OPENBOT_PROACTIVE_DEFAULTS=true`
switches on an hourly check-in on everything a Bot can read the first time a person talks to it
alone.

### Each app on a Bot says whether you can use it, and you can ask an admin for the rest

A Bot's page now says, for every work app the Bot holds, what that app is for the person looking:
ready, not connected yet, needing reconnecting, waiting on the team account or on an admin's
approval of who the Bot reaches, not switched on or not set up, or not given to this Bot. On
somebody else's Team Bot it also says whose account the app runs on. Each state comes with the one
step that fixes it: Connect or Reconnect your own account, or Request access where only an admin
can help.

In a conversation, a Bot that needs an app it cannot use puts the same card in front of you instead
of a sentence, including, through a new `show_app_access` tool every Bot holds, an app that is
switched off or not granted to it. The card reads the app's state when it is drawn, so it never
offers a step already taken. Connect on it opens the vendor's consent in a new tab, so the
conversation stays where it was, and it says connected only once the server lists the account. Each
app's card is drawn once per turn.

Admins see waiting requests at the top of Plugins, a count on each app's row and a Requests section
on the app's page. Approve switches the app on and grants the Bot the app's read-only actions in one
press (or says what has to happen first), and Dismiss closes the request. A person may have 20
requests waiting at once.

An account the vendor has lost now reads as lost once a call finds out: a Composio account the
vendor no longer holds is removed so it can be connected again, and a Google Drive or Notion
connection whose refresh token is refused is withdrawn, with Reconnect on the card. Without a
`COMPOSIO_API_KEY`, Connections no longer lists Composio apps nobody could connect.

### Every Bot gives parts of its work to subagents

A Bot, built in or an AG-UI agent somebody brings, can hand a piece of its work to a subagent: a
fresh run of the same Bot, as the same person, with the same tools, approval rules and standing
instructions, that sees none of the conversation and hands back only its answer. Bots are told to
use subagents only when a request falls into several independent parts that each need a lot of
reading (up to five for one answer), to do a single question or search themselves, and to keep
decisions and the answer. A subagent never waits on the person: an action that needs approval is
handed back, and the Bot asks in the conversation. A subtask is a step in the Bot's work line beside
its searches ("Searched the web, read 5 pages and ran 2 subtasks") and opens to its task, its
answer and its steps; one that stopped before an approval says Handed back. OpenBot runs the tool
itself, so a remote agent needs no change.

### People can pick the model a built-in Bot answers on, per conversation

A brain icon in the composer opens a searchable list of models, read from the provider, or from the
gateway in `OPENAI_BASE_URL`, filtered to chat models and to the model allowlist. It is offered in a
conversation with one built-in Bot, and on a new conversation before its first message. The pick is
kept on the server per person and conversation (migration `0076_model_selection` adds a nullable
column), every run there uses it, routines too, and the allowlist and usage records judge the
picked model. Off by default in the team edition: an admin turns on "Let people choose a model"
under Admin → Providers. Off, every run uses the configured model and saved picks are kept. Always
on in the personal edition. Bots on their own framework, and built-in Bots on a ChatGPT or Claude
subscription, keep their own model.

The composer is now two rows: the message box, then attach and the model on the left, dictation and
send on the right. It draws no focus ring, and opening a conversation puts the caret in it.

### OpenBot Desktop installers are signed and at fixed links, and the Mac app updates itself

Each release carries OpenBot Desktop for Mac (Apple silicon and Intel), signed with a Developer ID
and notarized so macOS opens it without Open Anyway, and for Windows x64, code-signed. The newest
stable release's are at `https://downloads.copilotkit.ai/latest/` and
`https://github.com/CopilotKit/OpenBot/releases/latest/download/`, as `OpenBot-mac-arm64.dmg`,
`OpenBot-mac-x64.dmg` and `OpenBot-windows-x64-setup.exe`. A release becomes Latest only once its
signed installers are on it, so these never give an unsigned build or a candidate.

The Mac app checks GitHub's Latest release when it opens and offers **Update and restart**. Nothing
downloads until you press it, and an update not signed with OpenBot's update key is refused.
Windows has no updater. A release candidate is a GitHub prerelease, linked by its version; its app
has no updater and always runs its own release, laid over the folder's installation, data kept.

### An installation moves to a newer release only when you ask, with a backup first

A normal start changes nothing: each installation keeps its release until you move it. In the
Desktop setup window, **Runtime updates** takes a release tag, checks the move is allowed and
downloads the release while OpenBot keeps running; once you accept the downtime it stops OpenBot,
backs up the database, swaps the files and starts the new release, and puts the previous one back if
that fails (with **Restore previous release** when the database changed). In a source checkout, `bun
scripts/update.ts local plan` and `apply` do the same for Docker Compose or host processes, and
`scripts/start.sh` will not start a checkout whose update was interrupted. On Kubernetes, `bun
scripts/update.ts kubernetes plan`, `apply` and `gitops` move a Helm release to the new chart and
image digests, keeping its values, pausing scheduled work and running your backup command first.
Each checks the release's published `release-manifest.json` against a policy you keep, so they start
from a release that published one: this one onwards, not v0.2.0. The server answers `/release` with
its version, commit and repository to a caller on its own machine, and the chart adds
`routines.suspend`. See `docs/desktop-updates.md`, `docs/local-updates.md`,
`docs/kubernetes-upgrades.md` and, for a fork, `docs/upstream-upgrades.md`.

### Arcade can be the deployment's app provider instead of Composio

Set `ARCADE_API_KEY` and an admin can enable Arcade's apps from `/admin/plugins/arcade`, give their
actions to Bots, and let each person connect their own account, as with Composio. A deployment uses
one provider at a time: with both keys set, `OPENBOT_BROKER_PROVIDER` (`composio` or `arcade`) says
which, and switching is refused while the other still holds connections. An app's page says how many
permissions its actions ask for, and warns when Arcade has not said which only read, so every call
will ask for approval. Each Arcade provider needs an OAuth app of your own. On every deployment, an
action whose name no model accepts is listed on its app's page instead of failing the app, and a
call to Composio or Arcade from a screen gives up after 10 seconds. Migrations
`0057_arcade_provider`, `0058_arcade_provider_backfill` and `0059_skipped_tools` add
`pending_authorizations`, `mcp_tools.vendor_name` and `mcp_servers.skipped_tools`. See
[Arcade](docs/plugins/arcade.md).

After a consent, Arcade sends the person to its project's user verifier, which must be this
deployment's `/api/plugins/arcade/verify`. A single-user install points it there through Arcade's
API before each Connect and reads it back, so several on one key take turns. A deployment that signs
people in treats the project as shared and never changes it: until it names this deployment, Connect
is refused before any consent screen, with the exact address to set in Arcade's dashboard, which the
server also names at start. See [Arcade](docs/plugins/arcade.md#the-verifier-url).

An Arcade app has Connect, under Connections and on a Bot's app card, which asks Arcade for
everything the app's actions need in one consent; the action list still approves one action at a
time. Every Arcade connection is recorded in OpenBot, and a Bot's call needs it, as on Composio. A
consent that exists only at Arcade is recorded, with no new consent, when the person opens the app
under Connections or presses Connect. A call Arcade refuses shows the Reconnect card, and Reconnect
asks for the whole app again with no Disconnect first. The connection is cleared only when Arcade
holds nothing for the app, so actions already approved keep working. See
[Arcade](docs/plugins/arcade.md#connect-asks-for-the-whole-app-and-each-action-can-still-be-approved-alone).

### First run takes three clicks at most, and Settings → Setup says what is missing

- Onboarding is an animated Welcome with the Ask before making changes switch (as in Settings →
  Approvals); then, on a single-user OpenBot (`OPENBOT_SINGLE_USER=true`, Desktop included), Talk
  to us, whose Book a call opens CopilotKit's booking page; then the person's name, unless sign-in
  gave one. The step is saved as they go, so a reload or browser Back keeps it.
  `/api/capabilities` gains `localEvaluation`, true in single-user mode.
- A conversation offers notifications once, after the person's first message.
- New Settings → Setup, for admins and single-user installs, reads the new `GET /api/setup`: whether
  Intelligence, the model key, the Bot computer, more apps, and Slack and Teams work, with the page
  or variables that close each gap. The Settings sidebar counts what an admin can fix. Check again
  asks again, at most every 10 seconds; no computer is woken to answer.

### A Bot's owner can give it their own apps

The owner of a Bot can let it use an app they connected themselves, without an admin: from the app
card ("Let Research Bot use your Gmail?"), under Your apps on the Bot's page, or on the New Bot
sheet. Calls under such a grant use the asking person's own account, even on a published Team Bot.
By default this covers apps each person connects for themselves, and Routines; an admin decides per
app, can let owners give a Shared app's team account, and can take away the "Give apps to their own
Bots" capability. Once an app a Bot stopped for is ready, its card sends "Gmail is ready now. Please
carry on." and the Bot resumes; an admin sees the fix itself, such as "Turn on and give it to
Sales".

### Each person's recordings teach every Bot they use, and they choose whose Bots learn too

Every recording joins the person's own Intelligence Learning container, `user-` and 32 hex digits
derived from their OpenBot user id. OpenBot makes it when they first connect a browser, with the
credential that makes the `openbot` container: a service token on a CopilotKit local evaluation
install, or a CopilotKit CLI login against managed Intelligence (Intelligence's runtime key
cannot). Without one, a missing space cannot be made, and the Recorder says Learning will not see
the recording. A run now gets the Bot's own learned Skills, then the person's own, then any another
person opened; on a name clash the Bot's own wins, then the person's. A missing or unreachable space
never fails a run, and Automatic Learning off, or the Bot excluded, still means no learned Skills.

**Settings → Learning** chooses who else's Bots use a person's Skills: only their own (the
default), every Bot in the deployment, or Skills they open one by one. Opening any needs **Admin →
Automatic learning → Skill sharing**, off by default; while it is off nothing is shared, and each
person's choice is kept for when it is turned on.

For recordings to reach Intelligence it needs Product Trajectories (in its licence, and
`FF_LEARNING_TRAJECTORIES`), people's browsers must reach `INTELLIGENCE_GATEWAY_WS_URL`, and the
address the Recorder reaches OpenBot at (`OPENBOT_PUBLIC_URL`, else `BETTER_AUTH_URL` or the app's
own) must be https, or http on `127.0.0.1` or `[::1]`. `OPENBOT_RECORDER_EXTRA_EXTENSION_IDS`
trusts other Recorder builds (a fork, another signing key): each 32 letters from a to p, comma
separated, and any other value stops the server at boot. `OPENBOT_BROWSER_URL` runs people's own
browsers on a separate computer, as OpenBot Desktop and the personal edition do. A computer puts
the Recorder from `OPENBOT_RECORDER_DIR` (its image sets it) in the browsers it opens, and without
it refuses to open a person's browser. A tenant package can no longer name a Bot `person-` and 32
hex digits, the shape of a person's browser. Audited as `recorder.connected`, `recorder.revoked`,
`recorder.connect_refused`, `recorder.bearer_refused`, `recorder.trajectory_refused`,
`recorder.sign_out_failed`, `learning.sharing_changed`, `learning.skill_opened` and
`learning.skill_closed`.

### A Bot's screen is a browser you can work in

A Bot's screen, opened full size, now has tabs, an address bar, back, forward and reload above the
page. Take control and the bar is yours, from the keyboard too; while the Bot has control it shows
where the Bot is, read only. Taking control now records who took it, so on a shared Bot only that
person can use the bar or record.

- **What you type stays yours.** After you hand back, the Bot reads a field you filled as "filled
  in by the person", never its value, in its page snapshot, its page text and its screenshots.
- **A Bot's request for help shows in the conversation**, with its reason and Take control, and
  folds into one line once answered. After you hand back, the Bot is told what you did and says what
  it does next; if it still stops without a word, the card says so and offers Carry on.
- **Clear browser data**, beside reload in a Bot's browser and in your own, asks "Clear this
  browser?" and deletes its profile: cookies, saved passwords, history and site storage, so it
  starts signed out of everything. OpenBot's own Passwords stay. Only the person holding a Bot's
  control can clear its browser. Audited as `computer.browser_cleared`.
- Leaving a conversation while you hold a Bot's control no longer leaves it blank: the Bot's reply
  after you hand back is there when you return.

### Enterprise controls moved onto the Admin pages each part governs

What people may do is on a new Permissions page; the model switch, the model allowlist and model
usage are on a new Providers page; Require SSO and SCIM are on Identity providers; the network
policy and stopping idle computers are on Computers; the MCP server allowlist is on Plugins; Skill
sharing is on Automatic learning; Action Recording and the OpenTelemetry export are on Audit. An old
link to Enterprise controls opens the Admin overview. The model allowlist is now picked from the
provider's own list, searchable, with the configured model marked; a model the list lacks, such as a
remote Bot's, is added by its `provider/model` name.

### A message sent from home opens its conversation at once

Pressing send on the home page opens the conversation straight away, showing the message, while a
Bot is picked and the conversation is made behind it. The real conversation replaces it if you are
still there, and Back opens it if you left. A start that fails returns you to home with the message
in the box and the reason under it. Picking the Bot for an untagged message now runs on a lighter
model (see Before upgrading), and a message that names its Bot with `@` no longer waits for the
audit record of that choice.

### Built-in Bots know today's date, and a run always ends with an answer

Built-in Bots are told today's date (UTC), so "this quarter" or "last week" no longer starts a guess
or a `date` command that waits for approval. The last step a built-in Bot's run is allowed is sent
with no tools, so a Bot that spent its steps searching answers from what it found instead of
stopping with nothing said. Every Bot is told to draw a table or chart once, with its result.

### The Helm chart installs CopilotKit Intelligence with OpenBot

By default (`intelligence.enabled: true`), one `helm install` with `secrets.licenseToken` and
`secrets.modelApiKey` is the whole product: Intelligence 0.16.0-rc.5, a release candidate,
self-hosted on its own PostgreSQL, Redis and object store. Its bootstrap creates OpenBot's project
and `openbot` Learning container, with a runtime key the chart generates, and nobody signs in.
Automatic Learning, on `secrets.modelApiKey` with `openai/gpt-5.5`, and trajectories are on. The
server carries the browser's socket to Intelligence's gateway (`INTELLIGENCE_GATEWAY_PROXY=on`), so
one `kubectl port-forward` reaches everything.

- With the bundled database the chart generates the database password, `secrets.keyEncryptionKey`
  and `secrets.computerToken`, reads them back on upgrade and keeps them on uninstall. `helm
  template` (Argo CD) cannot read them back, so set them there.
- Every workload that reads the database waits for it and its migrations, so `--wait` works on a
  first install.
- The Ingress, and a `LoadBalancer` server Service, carry the tag
  `aws-apn-id-058264219587=pc:avjdxr516uh0mgsqob730tzgy`, which credits CopilotKit through AWS
  Partner Revenue Measurement. No setting turns it off.

### A Bot asked by another Bot answers in its own name

The asked Bot is told who it is and which Bot asked, and gets your conversation as quoted context.
Its answer appears in your conversation word for word under its own name, not retold by the Bot
that asked. Bots are matched the way people say them ("the Knowledge Bot"). An answer for a busy
conversation waits without using up its retries, and one never delivered is audited as
`agent.handoff_failed`.

### Fewer "Verify you are human" pages

Sites behind Cloudflare challenged a Bot's browser on sight, and opening one could restart the
computer and leave the person a blank page to solve.

- A hosted computer runs headed Chromium on its own virtual display by default, behind the same live
  screen. Headless Chromium is what bot checks catch first, and a computer still run headless no
  longer calls itself `HeadlessChrome`.
- The computer no longer restarts on such a page. Images and Desktop run Bun 1.4.3, which fixes the
  connection crash behind it, and the network filter connects to one checked address at a time.
- When the computer or its browser restarts while a Bot waits for a person, the page the request was
  raised on is opened again, through the usual network and page rules, so the person who takes
  control has the check to solve.
- Web Bot Auth, off unless switched on: with `WEB_BOT_AUTH=on` (Helm: `config.webBotAuth: "on"`) and
  an https public URL, every request a Bot's browser sends is signed, with a key derived from
  `KEY_ENCRYPTION_KEY` unless `WEB_BOT_AUTH_KEY` gives one, published at
  `/.well-known/http-message-signatures-directory`. Register the deployment once with Cloudflare
  (docs/configuration.md) for sites that let signed agents through. Every site a Bot visits then
  sees the deployment's URL. `on` without an https public URL stops the server at start.
- On Helm, `computers.egressProxy` sends every computer's traffic through a proxy, such as a
  residential or ISP one, with its URL in a Secret. Off by default; elsewhere `EGRESS_PROXY_DEFAULT`
  does the same, as before.

### A computer closes browsers nobody is using when its memory runs high

A computer's only limits were a count of browsers and half an hour untouched, so a few heavy pages
could take its container past its memory limit, and the kernel then killed processes whichever Bot
was busy (on Kubernetes, every browser at once). A computer now reads its memory as the kubelet
does, before it starts a browser and once a minute. At 85% of its limit it closes browsers one at a
time, least recently used first, until it is under 75%. Never closed: the one being started, the
most recently used, any used in the last minute, a person's own browser, and a Bot's whose wheel a
person holds or has been asked to take. A Bot whose browser was closed starts again on its next
step, still signed in. In the `openbot` image the share counts the database and the API server,
which this protects; a computer outside a container closes nothing for memory. Each close is logged
as `computer-browser-closed-for-memory`. `COMPUTER_MEMORY_HIGH_PERCENT` (Helm:
`computers.memoryHighPercent`) sets the share, and `0` switches it off.

A Bot's background tabs, such as a sign-in popup's opener, are closed after ten minutes unused. The
page the Bot is on, a person's own browser and a Bot whose wheel a person holds keep theirs.
`COMPUTER_TAB_IDLE_MS` (Helm: `computers.tabIdleMs`) sets the time, and `0` keeps them.

Through Helm, `computers.browserIdleMs` and `computers.maxBrowsers` now reach the computer as
written (an hour rendered as `3.6e+06` and was ignored, and `0` was dropped), and all four settings
now reach `computers.mode: sandbox` computers too.

### A Bot can install packages on its computer, and gets no other root

On a computer the supervisor runs (laptop, Desktop, Compose), package installs failed: the container
dropped the permissions `apt-get` needs even as root. It now keeps those few (changing file owners
and switching user) and no others. In the `openbot` image (one container, and every Helm computer
pod), the Bot's user could run `apt-get`, `apt`, `dpkg`, `apt-key` and `apt-cache` through `sudo`,
and an apt option runs any command as root, where the deployment's secrets are. `sudo` now runs only
`openbot-apt`: `sudo openbot-apt update` and `sudo openbot-apt install <package>`, package names
only (`-y` is accepted and changes nothing). `/app`, the API's code and the page it serves, is no
longer the Bot's user's. A Bot's tool description says which to use, by whether its shell is root.

### The Bot's screen opens only when there is something to watch

- Reading, writing or listing a file and running a command no longer open the Bot's screen beside
  the conversation; only work on the screen does. An action refused by a policy, a switch or a
  network rule closes the screen it opened, unless an earlier action in the run opened it; one that
  was allowed and failed keeps it.
- In a conversation, a Bot is no longer offered computer tools that the Cloud browser use, Cloud
  computer use or Cloud network access switches (Admin → Permissions) would refuse, so it
  stops reaching for one and spending the turn saying it was refused.
- Opening the Computer panel shows the screen at once. It could stay on "Waiting for the Bot's
  screen" while the Bot browsed.
- The full-size screen has a close button, including while you have control; closing leaves control
  where it is. While you hold it, the small view says so on an amber band, and that the Bot waits
  until you hand it back.

### The Computer panel's Activity lists every command and file step

Activity was written by the page's own tool handlers and kept only until the tab closed. It is now
read from the conversation, so it lists every command the Bot runs and every file it reads, saves or
lists, with what it printed, once each: run at once, after you allowed it, or not at all. A
conversation opened again shows the same list. A step you declined, on an approval request or the
Bot's own approval card, reads "Declined" with "You declined it."; one you did yourself shows as
done by you; any other step not done says why in your words rather than the sentence the Bot is
told, and its line in the conversation says the same. A step shows a time only if the page saw it
run. Resetting a computer from Admin clears the Activity of every Bot that ran on it, and on that
browser a reload or another tab no longer brings it back.

### Following a link is judged as opening its address

A Bot's click on a link to another page now opens that address, judged exactly as
`computer_navigate` is: a read, with the same allowlist, policy, approval and audit. As a click it
was a change, so the built-in payments requirement handed a Bot back to the person for following a
link to `/purchase-orders/...` while typing the address went through. Buttons, same-page `#` links,
`javascript:` and `mailto:` links, links in an iframe and links with no address are still clicked. A
rule on the link (`element.name`) still applies, and one on where pages open (`page.url`) now does
too. Snapshots carry each top-page link's absolute address as `url`. Stop cancels a followed link,
even while it waits for approval, and a link from a page that has since moved on is refused as
stale.

### Memory lives in CopilotKit Intelligence

A deployment entitled to Intelligence memory now keeps its people's memories there: Intelligence
holds the content and ranks recall, and memories another app on the same project formed for a
person appear in their Memory page and reach their Bots. OpenBot still records each memory's
provenance, review state and which Bot or source it came from, and applies those rules to
everything Intelligence returns, so a Bot-formed memory still reaches only the Bot that formed it.
Without Intelligence memory nothing changes: OpenBot's own tables remain the store.

### Each app you connect becomes a memory source for your Bots

Connected-app memory sources used to wait for somebody to set them up, one Bot and one app at a
time. Now, when a Bot takes a turn for a person, each app the person connected with their own
account that the Bot can read becomes a memory source for that Bot, except on a Team Bot somebody
else published, where their accounts need their consent. Sources read as the person, their facts
reach that Bot only, and imported facts wait for the person's review, as with a source made by
hand. Shared apps and apps that need no account are not added. Turning a source off keeps it off,
and removing one is remembered, through a Bot reset too. `OPENBOT_MEMORY_SOURCE_DEFAULTS=false`
(Helm: `config.memory.sourceDefaults: false`) stops new ones for the whole deployment; nothing
already saved changes.

### Automatic Learning assigns its `openbot` container, and creates it where it can

Automatic Learning was on by default but collected nothing until somebody assigned a container.
Now, with nothing saved under Admin → Automatic Learning and no
`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`, the server assigns its Intelligence project's `openbot`
container as soon as it exists (it checks at start and every ten minutes until then), records that
in the audit log, and Admin says so. A saved setting, including off, is never changed.
`OPENBOT_LEARNING_AUTO_ASSIGN=false` (Helm: `config.learning.autoAssign: false`) turns this off.

The server first creates it with the runtime key, which Intelligence after 0.15.1 allows. On
0.15.1 and earlier, OpenBot creates it with a credential that can:
- `bun scripts/setup-learning.ts`, which `scripts/start.sh` now runs on every start without a
  prompt, uses a CopilotKit CLI login, even with no project selected, once the login's organization
  and project match the runtime key's. On Windows it starts the CLI through `cmd.exe`.
- The server creates it at start, and from a "Create the openbot container" button under Admin →
  Automatic Learning, with a CLI login on its machine or `INTELLIGENCE_SERVICE_TOKEN` with
  `INTELLIGENCE_PROJECT_ID` (a service token counts only on a CopilotKit local evaluation install).
  It refuses to start with only one of those two.
- The Helm chart runs a setup Job on each install and upgrade when `config.learning.setup` names a
  CLI-login Secret or a service-token Secret.

Without one, Admin and the server log say what to run.

### OpenBot can send product usage events

OpenBot can now send usage events to CopilotKit through the telemetry channel the CopilotKit
runtime already uses: when a run a person, routine, subagent or Bot-to-Bot hop started begins and
ends, and how (a stop reads `cancelled`, a headless turn's deadline `timeout`); use of connections,
approvals, Bot and routine setup, the computer and Learning sharing, read from the audit log; and
when an answer is seen on screen or copied, which the browser reports to
`POST /api/telemetry/product-events`. Runs the runtime makes for itself (naming a conversation,
suggestions) are not counted. A person appears only as a pseudonym keyed with
`KEY_ENCRYPTION_KEY`; no names, prompts, tool arguments, results or URLs are sent. Nothing is
stored and there is no migration.

A server sends these only with `OPENBOT_PRODUCT_TELEMETRY=1`. OpenBot Desktop sends them by default;
this release showed no notice of it, and later releases say so on the first setup screen.
`OPENBOT_PRODUCT_TELEMETRY=0`, `DO_NOT_TRACK=1` or
`COPILOTKIT_TELEMETRY_DISABLED=1` turns them off. The CopilotKit runtime's own events now carry
`app_id=openbot`, and this deployment's ID only while product telemetry is on.

### Naming a conversation and offering suggestions run the Bot with none of its tools

The CopilotKit runtime names a new conversation by running its Bot again on a title prompt, and
answers its suggestions route by running the Bot on what the caller sent. Both runs held every tool
the Bot had, out of the person's sight; with subagents, a naming run was seen starting one that
acted with all the Bot's permissions and kept going after Stop. Both now run with none of the Bot's
tools, and a remote Bot's naming run is sent no signed run, so a callback from it is refused. A
person's own runs, the subagents they start, headless turns and hops keep every tool.

### Capabilities and Connections sit beside Bots in the sidebar

The sidebar's Skills entry becomes two. **Capabilities** (`/capabilities`) holds Skills and Memory
as tabs, and Memory leaves Settings. **Connections** (`/connections`) is one searchable list of the
apps your Bots use as you: apps you connect, apps on the team account (marked "Team account") and
your GitHub and Slack links, those in use first, each with its own page. GitHub's page holds your
link and the repositories whose events can start a responsibility. The reset for what you let
shared Bots use moves to Settings → Approvals, as **Shared Bots**. `/skills`,
`/settings/connected-accounts` (and any app beneath it) and `/settings/memory` redirect to the new
places, keeping their query, so a consent begun before upgrading still lands.

Settings, Admin, Connections, Capabilities and each Bot's pages now share one column width, 768px
(it was 630px). The audit log stays wider.

### A Bot can send, draft and reply in Gmail

OpenBot left out every Composio action that takes a file, including those where the file is
optional, so Gmail's send, draft, reply and update-draft never appeared. They are now offered
without the optional file; a call that passes one anyway is refused with a message saying to try
again without it. An action that needs a file, such as a Google Drive upload, is still left out.
For an app that is already on, press Refresh tools on its page in Admin, then grant the new actions
to a Bot.

### Generated interfaces use CopilotKit's standard catalog on A2UI 1.0

With generative UI on, a Bot builds an interface from CopilotKit's standard catalog on A2UI 1.0
instead of the 18 A2UI 0.9 basic components: 65 components for layout, text, inputs, tables,
charts, media and composites such as entity cards and image grids, including the A2UI basic
components. They take OpenBot's colours, radii and font, in light and dark. Four are left out: Map
needs a map library OpenBot does not ship, and Favicon, LinkCard and Citation would send every
linked domain to Google's favicon service. None is listed in the components gallery or can be
turned off per Bot. Granted gallery components are unchanged, and `OPENBOT_GENERATIVE_UI=false`
still switches it all off, on the server too. Code and markdown blocks in a generated interface
are drawn like a reply's: highlighted in light and dark, with the same copy and download buttons,
tables and document links.

### OpenBot runs on CopilotKit 1.83

OpenBot now runs on CopilotKit 1.83.0 (`@copilotkit/runtime` and `@copilotkit/react-core`, from
1.77.0) and AG-UI 1.0.2 (`@ag-ui/core` and `@ag-ui/client`, from 1.0.1).

Behind an `OPENAI_BASE_URL` that is not OpenAI or Azure, the built-in Bots now call the endpoint's
Chat Completions API (`/chat/completions`), which every OpenAI-compatible endpoint serves, instead
of the Responses API. A model that takes tools only through the Responses API (`gpt-5.6` and later,
the default `gpt-5.6-terra` among them, and the `-pro` and `-codex` models, also under a gateway's
`openai/` name) still gets the Responses API: OpenBot sets `COPILOTKIT_OPENAI_API=responses` for
it at start and logs `openai-api`. A value you set always wins: `responses` or `chat` picks one API
for every model, and any other value is an error when a built-in Bot runs. On Chat Completions,
Responses-only features such as reasoning summaries are dropped without an error. Deployments on
OpenAI or Azure are unchanged.

### Company systems behind Microsoft Entra, reached as the signed-in person

An admin can add an MCP server by URL with an Entra scope (`entraScope`), and each call then goes
out with a token Entra issues for the person asking, through the on-behalf-of exchange: from the
Entra token their app sent, or otherwise from their stored Microsoft sign-in, which routines and
check-ins use. Apps listed by client id in `MICROSOFT_OAUTH_ALLOWED_CLIENTS` can call OpenBot's API
with a person's Entra token for `MICROSOFT_OAUTH_API_SCOPE`; a token issued to any other app is
refused. Unset, no app can. A value that is not a client id stops the server at start. See
[Company systems behind Microsoft Entra](docs/configuration.md#company-systems-behind-microsoft-entra).

### Each single-user OpenBot has its own Composio and Arcade identity

Every single-user OpenBot is `dev-local-user`, and that was also the user id it filed connections
under at the broker. So two single-user OpenBots on one `COMPOSIO_API_KEY` were one Composio user:
each listed and used the other's accounts, a disconnect in one ended the account in both, and a call
that named no account could run in whichever was connected last. Each now has its own id at its
broker, `dev-local-user:` and a random part, given at its first start with that broker and kept in
its database, so restarts and replicas agree. Threads and memory stay with `dev-local-user`. See
[configuration.md](docs/configuration.md#authentication).

### Shopify and other Composio apps on a server-to-server grant can be connected

Composio publishes some apps, Shopify among them, with only `OAUTH2` and `S2S_OAUTH2`, so they were
hidden from the picker and refused at enable. Set `COMPOSIO_<SLUG>_CLIENT_ID` and
`COMPOSIO_<SLUG>_CLIENT_SECRET` (for Shopify, `COMPOSIO_SHOPIFY_CLIENT_ID` and
`COMPOSIO_SHOPIFY_CLIENT_SECRET`) to the OAuth client you registered with the vendor, and the app
can be enabled and connected. Because the credential is the deployment's, such an app connects
only as a Shared app: an admin connects it and grants it to Bots, and a personal Connect is
refused. See [rotating the client](docs/configuration.md#rotating-a-composio-apps-own-client).
Without them, nothing changes.

A Shopify store connected with a key is now checked with `SHOPIFY_GET_SHOP_DETAILS`. The check used
`SHOPIFY_COUNT_BLOGS`, which needs a scope a store app with only order and product scopes lacks, so
a working key was reported as rejected.

### A Bot sees the images its tools return

An image a tool returned, such as a Gmail attachment fetched through Composio, reached the model as
a storage link it could not open. The server now downloads it and puts the picture in front of the
model beside the tool's answer: https only, only from Composio's file storage hosts, never from an
address that is not public, at most 8 MB each and the newest four in a run. A picture that cannot
be downloaded, such as one whose link has expired, is replaced by a sentence saying it is missing.
Each picture is sent again on every later step, so expect more input tokens.

### A built-in Bot can hold hundreds of tools

A built-in Bot whose run would send more than 50 tools no longer sends all of them on every step.
Its own tools stay in front of the model, and an app's tools wait behind one search tool: the model
searches in a few words and calls what it found from its next step. Every call still goes through
the grant, the approval rules and the audit trail. A question that needs an app's tool makes one
more model call than before. A run at or under 50 tools is sent exactly what it was.

A run that would still send more than 128 tools at once, counting room for a search's answer, is
refused before the model is called wherever search is on or the model is reached through Chat
Completions, which refuses more itself. The person is told why, and the audit log records it under
Blocked as "Too many tools for its model".

### Public-web research works with Exa and Firecrawl, not only Parallel

Four catalogue entries give a Bot web search and page reading without its browser: **Exa Search**
(free, rate-limited), **Exa Search (API key)**, **Firecrawl** (free) and **Firecrawl (API key)**,
beside the two Parallel entries. In the team edition none is granted to a Bot until an admin does
it. See [docs/web-research.md](docs/web-research.md).

- **Research guidance follows whichever provider a Bot holds**, and a Bot holding more than one
  uses the one the person asks for.
- **A Bot holding a research provider searches without being asked** when an answer depends on
  facts that change, such as current figures or recent events, and stops after a search or two.
- **The conversation does not name the provider.** Research calls show as "Search the web" and "Read
  web pages".
- **Skills declare roles.** The shipped `research-public-web` skill now names `@research/search` and
  `@research/fetch`, which match every granted provider's search and fetch tools. A role grants
  nothing.
- **Exa and Firecrawl list their reads**, so every other tool they offer is treated as a write.
  Exa's deployment key is sent in its own `x-api-key` header.

### A run of tool calls folds into one line

A Bot's consecutive tool calls, research and browser steps now fold into one line that says what was
done, such as "Searched the web and read 2 pages" or "Used 5 tools", with an icon for each kind of
step. It names the step in progress while the Bot works and counts steps that were blocked or
failed. Opened, it lists each step, and each step opens to what it was given and what came back.
A lone call keeps its own line, and approvals, connection requests and anything drawn as an
interface stay outside the fold.

### A source checkout sets up Composio from your CopilotKit login

With no Composio key, `scripts/start.sh` uses your CopilotKit CLI login to create or reuse one
Composio project for the installation and writes `COMPOSIO_API_KEY` to `.env`; `bun run
setup:composio` runs that step alone. If it fails, OpenBot starts with apps unavailable. A key you
set always wins, and a deployment on Arcade is left alone. OpenBot Desktop, a server, a container
or a Helm release still needs the key set.

### The server image runs the routines worker too, and Compose can run OpenBot from it

The published `openbot-server` image now also carries the routines worker (`bun
../worker/src/index.ts`), so the API, the app and the worker can run from one image.
`docker-compose.yml` has `server` and `worker` services built that way behind the `openbot` profile
(`docker compose --profile openbot up -d`), publishing the app on `APP_PORT` and `SERVER_PORT` on
loopback only; `scripts/start.sh` and a plain `docker compose up` do not start them.
`INTELLIGENCE_BROWSER_GATEWAY_WS_URL` gives the browser a different gateway address from the
server's where it needs one. The image also carries the computer's egress rules, which the server
imports; without them it exited at start when run as the API, in 0.2.0 too.

### Bots answer with components when an answer has structure, and answers are wider

Built-in Bots, and remote Bots through the standing role OpenBot sends them, are now told to use a
component when an answer has structure: a chart for figures, a checklist or table for steps, a
record card for one thing's details, a card to choose from for a decision. Short replies stay plain
text. Code in replies, tool results and group chat is highlighted in light and dark. A coding Bot's
Claude Code steps get cards of their own (a command with its output, an edit as a diff, its to-do
list), and a step that failed or was refused no longer shows as done. The answer column is 768px
wide, up from 672px; skins keep their own widths.

### A new Bot starts from its name, and OpenBot knows yours

New Bot opens a sheet on the Bot itself: a name, optional instructions and who can see it. Create
Bot makes one that runs here; Connect a custom agent goes on to the frameworks, and choosing one
goes to its address, which Continue checks before anything is created. The To: list of a new
conversation has New Bot at its top, which makes a Bot and adds it without losing the message.
Settings has a Profile form for your name (`PATCH /api/me/profile`), the home screen greets you by
it, and Bots that run here are told it on each run. The frameworks list Claude Agent SDK, Google
ADK, Google Antigravity and LangGraph first.

### The Desktop app opens the Docker Desktop you already use instead of installing Podman

On a Mac or Windows PC with Docker Desktop installed but quit, setup installed Podman beside it. It
now opens Docker Desktop and uses it when it has run on that computer before; one never opened is
left alone and the computer gets Podman as before. Each installation keeps the engine it was set up
on, because its images and database are there, and Start brings that engine up, so an installation
reopened after a restart no longer stops with "podman is installed but not answering". Linux is
unchanged.

### Bots on other frameworks answer from the whole conversation, in their role

OpenBot sends a Bot the whole conversation on every run, behind its role and a summary of the tools
it holds. Several harnesses dropped part of that. Each now gives the model the conversation as
OpenBot sent it, with the current role and tools summary, so a restart or another replica no
longer changes what the Bot knows, and a changed grant reaches it on the next run. Only that role
and summary are its instructions: any other system message, such as a skill you pick, reaches it
labelled as part of the conversation.

- **Claude Agent SDK.** After its container restarted, or the conversation sat idle for 30
  minutes, it answered only the newest message, and it never received its role or tools summary.
  A long conversation now sends its newest messages, up to about 100,000 tokens, and tells the Bot
  that older ones are left out. Built-in Bots on a Claude subscription run through this harness and
  get the same limit.
- **Agno.** It was sent only the newest message, so it never remembered an earlier turn, and it
  never received its role or tools summary. A long conversation is cut the same way, at 100,000
  tokens or half the model's window. A tool result that reaches a restarted harness or another
  replica is answered from the conversation instead of failing the run.
- **Google ADK.** After about 20 idle minutes it saw only the newest message. It kept only the
  first system message OpenBot sends, so it never had its tools summary, nor its role when personal
  memory came first. A tool result that reaches another replica or a restarted harness now carries
  on from the call, so the tool runs once; that replica used to call it again (a message sent
  twice) or end the run with nothing said.
- **LangGraph.** It dropped the first system message, usually its role, so it often answered as a
  plain assistant, and a running harness kept an old tools summary. After you approve something it
  stopped to ask about, it now carries on from the conversation; it used to stop without answering,
  or answer with none of the conversation.
- **Mastra.** It now receives the context the app sends with a run, such as a component catalogue,
  after its role, and a skill's instructions and your personal memory, which it never saw.
- **Strands.** It never received its role, its tools summary or a skill's instructions, so it
  answered as a plain assistant. Its role and summary are now its instructions on every run, so a
  new role or grant applies on the next message without a restart.

The Agno, ADK and LangGraph harnesses also no longer keep a copy of every finished conversation in
memory for the life of the process.

### Google Antigravity can be a Bot

OpenBot Desktop's setup and the New Bot sheet offer Google Antigravity, from the new
`openbot-agent-antigravity` image. It works only with Google's models: it reads `GOOGLE_API_KEY` (or
`GEMINI_API_KEY`) and `GOOGLE_GENERATIVE_AI_BASE_URL`, stays on Google whatever `BOT_PROVIDER` says,
and takes `BOT_MODEL` for the Gemini model (default `gemini-3.6-flash`). Checking the address of the
deployment's own Bot, or of the framework picked in Desktop setup, now sends the deployment's token
as a run does and stops at the first event, so a working Bot is no longer reported as refused or
broken. It answers from the whole conversation OpenBot sends, in its role and with the summary of
its tools, after a restart too; a change to either starts its session again, and a long conversation
is sent from its newest messages with a note that earlier ones are left out.

### A Bot's turn rides through a network blip without losing its conversation

Headless turns (routines, responsibilities, background research, wake-ups, group turns) and
Bot-to-Bot handoffs renew a lock on the conversation. Any failed renewal used to stop a headless
turn, which is retried from the start, so a blip could make a Bot send an email twice; a handoff
ignored failures and kept writing, even after the person started typing. Now both stop only when
Intelligence says the lock is another run's (409), or when no renewal has landed for nearly the
lock's 120 seconds. A handoff to a paused or disallowed Bot is refused before it takes the lock.

### The Helm chart pins by digest, mounts a tenant package, and takes a Composio key

- `image.digest` (`sha256:` and 64 hex characters, from a release's `container-images.json`) runs
  every workload as `repository:tag@digest`.
- `config.extraVolumes` and `config.extraVolumeMounts` mount volumes on the server and the routines
  and computer-culler CronJobs, so a tenant package from a ConfigMap needs no custom image.
- `secrets.composioApiKey`, or `composio-api-key` in `externalSecrets.data` or
  `secrets.existingSecret`, reaches the server alone as `COMPOSIO_API_KEY`.

Unset, the chart renders as before.

### Each Bot on a shared computer has its own files

A computer many Bots share kept one folder of files, so a note one Bot saved was a file every other
Bot could read. Each person's use of each Bot now gets its own folder, where its commands start. It
is on for Helm's `shared` computer and the Compose `agent-computer`;
`COMPUTER_SEPARATE_WORKSPACES=on` turns it on for the all-in-one image. A command can still read
other folders: keep people apart with `computers.mode: sandbox`.

### Every chart says where its figures came from

A chart a Bot draws ends with what its figures were read from and when they are from ("Sources:
World Bank · As of 2025"), or "From the Bot's own knowledge. Not checked against a source." Bots are
told to look up figures that change over time before charting them. Slack and Teams replies carry
the line.

### OpenBot has a new look, and plainer words

Pages sit in a panel inset from a darker frame shared with the sidebar, in a lilac palette with a
plum dark mode, and share one spacing, row and empty-state design. Each Bot is an orb in its own
colors, and a conversation opens with its Bot's orb, name and role. The app says **Bot** everywhere
("agent" only for an outside program you connect), **admin**, and **conversation** rather than
channel, with shorter text that says what to do next. Text written for the model is unchanged.

### Boundaries are named rules, the audit log is a table, and a Bot's page is shorter

- Admin → Boundaries lists named rules ("Bots may never…"). A new one starts from a template or a
  blank rule, and each opens to a page with what it has stopped lately. Adding a credential is a
  page too, not a dialog.
- Admin → Audit is one filterable table, newest first, with the full date and time, blocked rows
  red and actions that did not happen amber. Search and the Outcome, Bot and Started by filters
  narrow the events loaded.
- A Bot's page shows at most three things running or scheduled; the full lists move to its Activity
  page. A conversation's gear panel gains Pin and Delete, and Home's @ menu opens at the caret.

### Each person can pick a skin: OpenDuet, OpenDots or OpenMuse

Settings → Preferences → Skin changes how OpenBot looks for you, not what it does: OpenDuet (one
phone-width column), OpenDots (a rail, a sidebar of Bots, the Bot's computer beside the chat) or
OpenMuse (one Bot at the centre). Each draws an open-source template's layout over OpenBot's own
features and keeps the name from `brand.yaml`. The choice is saved on your account. Template
features with no OpenBot server, such as OpenDots' Spaces, are left out.

### A sign-in's verification code is asked for after the password

The private sign-in form asked for a username, a password and "a verification code, if the site
asks for one" all at once, so a person had to guess whether a code was coming and type it before
the site had sent it. The form now asks for the username and password alone. If the site, once it
has the password, shows a one-time-code field, the request waits in a new `code_required` state and
the form asks for that code on its own. A wrong code asks again, a code nobody enters expires with
the request, and the person can still take over the browser or cancel. The Bot is told only how it
ended, never the code, and a saved login never stores one. The step is audited as
`computer.sign_in_code_requested`, and a failed code as `computer.sign_in_failed` with
`step: "code"`.

### The safety rules judge what an action does, not words that happen to be in it

The built-in safety rules (credentials, security settings, paying or moving money) hand an action
to the person whatever the other rules say. They now read it more accurately:

- What a Bot types is no longer read, only the field, the page and the button. A CRM note about a
  customer's purchase orders, or a source field reading "Business Wire", was stopped as moving
  money in the middle of a form. A card number field, a checkout page or a new password field still
  goes to you, whatever is typed.
- A news wire (business, news or press wire) no longer counts as wiring money. Wiring money still
  does.
- A field the Bot left empty no longer counts. A note on a Shopify order was handed to you because
  the action has a `billing_address` field nobody filled in.
- A refund now counts as moving money. `SHOPIFY_CREATE_REFUND` and other refund actions used to
  pass straight through.

### A page visit an approval rule covers asks you

With an approval rule that asks before a Bot opens, reads or scrolls a page, the Bot was told the
action "was not started from a conversation that can ask you", did nothing, and said it could not
get an approval in this chat. The visit now waits on the approval card in the conversation, as a
click or a command does: Allow opens the page and the Bot carries on, Deny tells the Bot it was
declined. Page visits no rule asks about still go straight to the computer.

### A Bot can choose from a dropdown

A Bot could not set a native `<select>` in its browser, such as a CRM's Industry or Stage. Typing
into one waited until it timed out and was reported as a field that had gone from the page, so the
Bot took a fresh snapshot and tried the same thing again. Typing into a dropdown now chooses the
option whose label (or failing that, value) matches the text, ignoring case, and the page sees the
same change a person's choice makes. Text that matches no option is refused with a message saying
so. A page snapshot lists each dropdown's options (up to 50) and the one it shows.

### A Bot carries on after a browser step fails

When a click, typed entry, key press, command or file write the Bot made on its computer failed or
was refused, the Bot's turn ended on the spot and it said nothing more. The failure now reaches the
Bot as a result, so it can take a fresh snapshot, try another way, or tell you what stopped it.

### Boundary rules catch two spellings that used to get past them

- Enter or Space with a modifier is an activation. `computer_key` names keys the way Playwright
  does, and the browser submits a form on `Shift+Enter` as on Enter, but only the bare `Enter`,
  `NumpadEnter` and `Space` counted as `intent == "activate"`. Now `Shift+Enter`, `Control+Enter`,
  `Shift+Space`, `\n` and `\r` do too. The shipped "Never submit a form" rule (the Boundaries preset
  and the `AGENT_COMPUTER_POLICY` example in `.env.example`) now refuses a keypress on
  `intent == "activate"` instead of `key == "Enter"`.
- `page.host` drops the root dot a host can end with, so `https://intranet.example.com./` no
  longer slips past `page.host == "intranet.example.com"`. The port stays.

### A Bot's question waits above the composer, with the answers it expects

When a Bot stops to ask you something, the conversation it asked in now shows the question and why
in a drawer above the composer, however far you scroll, and what you send there is your answer. A
Bot can put one decision or up to six in a question, each with the answers it expects (which time
zone to use, say); the drawer takes them one at a time, an option or your own words, and a reply
from the composer answers the whole. Dismiss puts a question down unanswered, with nothing sent to
the Bot (also `POST /api/approvals/questions/:id/dismiss`).

### Each browser on a computer is held to its own network policy, and Google loads behind it

The computer's network filter now asks every browser whose it is. Before, browsers' connections
arrived anonymous and were judged by every policy on that computer, strictest first, so a Bot
allowed to reach a service was refused because another browser on the same computer was not. A
shell command's connections are judged as before. Google's pages also load in a browser behind the
filter: they never finished loading (Chromium restarts the request when Google asks for client
hints, and the restart was lost), and every browser behind the filter now launches with that
restart switched off.

### OpenBot Desktop installs and starts more reliably

- A new Desktop install of v0.2.0 stopped at start with `Cannot find module
  '../../../agent-computer/src/egress'`, because Desktop did not lay out `agent-computer`. It does
  now, and lays out again, keeping settings and data, an installation an earlier Desktop left
  without it.
- Opened from Finder or the Dock, the app could stop at Start with `bun: command not found` in its
  log. Every process Desktop starts now has the directory of the Bun it runs first on its `PATH`.
- The window keeps answering while Desktop downloads software: bringing it forward, or the setup
  page loading again, no longer shows a spinning cursor until the download ends.
- A new installation made after the old one's folder was deleted no longer silently reuses what that
  one left in the container engine: each Bot's workspace files and browser profile, with its website
  sign-ins (only the database was checked). Start lists those volumes and stopped containers and
  offers **Start fresh**, which deletes exactly those and then starts; to keep them, restore the old
  folder. A container from it that is still running blocks the deletion. An installation with its
  saved key keeps its data as before.

### The approval card for an app's call appears in the conversation

When OpenBot stops a Bot to ask about an app's call (sending an invitation, deleting a file), the
approval card now appears in the conversation where the call is, as soon as the run stops. It used
to appear only on the Bots page, while the conversation showed the call still running.

### A skill in a new conversation's first message reaches the Bot

A `/` skill picked in the first message of a new conversation showed its chip, but its instructions
were left out, for every kind of Bot. The first message now carries them, as later ones did.

### Conversations go by your first message until named, and are named on Anthropic too

Until a conversation is named, the sidebar and every skin show your first message as plain text,
not the Bot's reply with its Markdown, and search matches it. Names are stored as plain text. With
Bots on Anthropic, naming sent the Anthropic key to OpenAI and no conversation was ever named; it
now asks Anthropic.

### A routine asked for in a conversation posts in that conversation

It used to post into the one conversation you share with the Bot, or have the Bot ask which. The
Routines page names conversations by their title.

### Admin → Automatic learning reviews and publishes proposed skills

The page lists Learning's proposed skills, each with its SKILL.md, files and what it was learned
from, to approve and publish or reject, both audited. **Learn now** starts a run. It works on an
Intelligence with no dashboard, and says when Learning is off in Intelligence.

### An allowed site on a non-default port opens

With a network allowlist, a Bot opening an allowed site on a port other than the scheme's default,
such as `http://erp.internal:8080`, was refused whatever the rule said: the server compared the host
with its port attached against the allowlist's domains. It now compares host and port apart, as the
computer's own filter does.

### The computer image is smaller

`openbot-agent-computer` no longer carries Playwright's headless shell, a second Chromium it never
starts, or the package cache left from installing the browser: about 100 MB less to download and
about 300 MB less unpacked. The `openbot` image drops the same. The browser is unchanged.

### A computer run on a laptop can stay off the local network

A computer run straight on a machine rather than in a container listened on every interface, leaving
its token-protected API reachable from the local network. `COMPUTER_BIND=127.0.0.1` now keeps it to
the machine. Unset, nothing changes; a computer driving a native Chrome (OpenBot Desktop's) always
listens on loopback.

### Each Bot keeps a fact it formed, even when another Bot formed it first

A memory a Bot forms from what it read was deduplicated per person, but each Bot recalls only the
memories it formed itself. So when a second Bot formed a fact the first already held, it was told
the fact was remembered and could then never recall it. Each Bot now keeps its own copy, and
resetting one Bot leaves the other's alone. Forgetting stays the person's: a fact forgotten from
any Bot is not formed again by another.

### A licence token from a store reaches the server

The Helm chart passed `COPILOTKIT_LICENSE_TOKEN` to the server only when `secrets.licenseToken` was
written as a literal. A token synced through `externalSecrets` reached the Secret and never the
pod, so the deployment ran unlicensed with nothing saying why. It is now passed whenever
`externalSecrets.data` names `license-token`, and as an optional reference with
`secrets.existingSecret`, where the chart cannot see the Secret's keys.

### The server says at start-up when Intelligence or the model key will refuse it

Both checks ask once, log what they find and never delay start-up:
- A self-hosted Intelligence without its own licence refuses memory and other licensed features
  while conversations carry on. The server logs `intelligence-entitlement-not-ready` with the code
  and where the licence goes, or `intelligence-entitlement-unreadable` when Intelligence cannot be
  asked.
- A key without access to the tenant package's `default_model` passed every start-up check and
  failed at the first message. The server asks OpenAI or Anthropic and logs `model-unavailable` with
  the model and the fix, or `model-credential-rejected` for a refused key. It does not ask another
  endpoint set by `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, and says nothing while no key is
  configured.

### A responsibility hears about large pull requests

GitHub events for a responsibility were refused above 32 KB, and most `pull_request` deliveries are
larger, since the pull request repeats its repository under `head` and `base`. They were answered
503, which GitHub does not deliver again on its own, so the responsibility never ran.
`/api/events/github/:bindingId` now takes up to 256 KB, like the event triggers, and stores an event
over 32 KB as its short top-level fields (`action`, `number`) and an excerpt from the start of the
rest. A body over 256 KB is answered 413.

### Routines describe a repeated minute once, and concurrent edits keep the limit

- A schedule like `0,30,0 9 * * *` fires at 09:00 and 09:30, but the routines page and the model
  were told "Every day at 09:00, 09:00 and 09:30". A repeated minute is now said once.
- An edit now reads the routine under the same per-person lock that counts and writes it, so an
  enable queued behind another cannot take a person past 20 switched-on routines, and concurrent
  schedule and time zone edits work out the next run from the schedule actually saved.

### A title that arrives after its conversation was deleted is dropped

It no longer renames the deleted conversation or announces a new title.

### A paused hand-off closes its run before it gives up

When a person pauses a Bot while another Bot's hand-off to it is running, OpenBot now waits for that
run to close on Intelligence before giving up on the hand-off. It used to let go at once, and the
run stayed open there with no end.

### Connect works for an app Composio already holds your account for

Connect could be refused because Composio already held an account for the app that OpenBot had no
record of, with advice to disconnect an app the page showed as not connected. Connect now records
the account Composio holds and shows the app as connected. A Shared app's team account is still
recorded only by an admin.

### A Bot holding apps keeps its browser, and each step is drawn once and named for the app

- **The browser works beside apps.** A Bot that held any app or research tool could not open a
  page, click or type in a conversation: every browser step came back unavailable. It now works as
  it does for a Bot that holds none.
- **Each tool call is drawn once.** The LangGraph Bot named its tool calls' message differently from
  the conversation store, so every call was kept twice, drawn twice (also after a reload) and sent
  back to the model on the next turn. Each is now kept once, and drawn once even in a conversation
  that already holds a copy.
- **Steps name the app, not the broker.** "Used Composio Airtable" and "Airtable list bases" now
  read "Used Airtable" and "List bases", and app cards say "Gmail", not "Composio Gmail".

### Approving a Bot for a Shared app either completes or can be tried again

Deciding a Shared app request now commits the decision and the access it grants together. If they
cannot be saved, the request stays pending, where it used to read as approved with no access
granted. Approving a Bot whose published audience and assigned groups name the same group no longer
fails. Concurrent approvals of the same Bot and app wait for each other instead of deadlocking.

### A server that cannot read an app's OAuth client no longer replaces it

When a server could not decrypt an app's stored OAuth client, Connect registered a new client,
replacing the one every replica that could still read it was using. It now fails that Connect with
a retryable error and records `mcp.oauth_client_read_failed` on the audit trail, with nothing of
the credential. A missing, revoked or malformed client is still registered afresh.

### A message naming different Bots' apps stays on the default Bot when routing is unsure

When the router could not decide, a message naming apps held by different Bots went to whichever
Bot came first in the roster. It now stays on the default Bot. One Bot holding every named app, or
a confident routing decision, still wins.

### A Bot's Slack link code works only in a direct message, and the audit trail names who used it

The `link <code>` message from a Bot's Reaching you now links on Slack only when sent to the app in
a direct message. Sent in a channel, it is cancelled and the sender is told to make a new one, as a
code from Connections already was. Teams codes still link wherever they are sent. The
`delivery.linked` audit row now names the Slack or Teams account that sent the code, not only the
workspace; SMS and push rows still carry no phone number or device token.

### A freshly built Microsoft Agent Framework Bot starts

`agent-framework-ag-ui` 1.7.0, released after v0.2.0, refuses to build an AG-UI endpoint that does
not declare how it authorizes, so a Microsoft Agent Framework Bot built with it failed at startup.
It is now pinned below 1.7.

### The audit trail can be exported as CSV

Admin → Audit has Export CSV, which downloads the events the open view matches, up to the newest
5,000 (`GET /api/admin/audit-events?format=csv`; a cut export says so and sets
`X-Audit-Export-Truncated`). A cell starting with `=`, `+`, `-` or `@` gets a leading `'`, so a
spreadsheet reads it as text. Each export is recorded as `audit.exported`. The enterprise
`models/usage?days=` and `actions?limit=` routes now answer 400 to a value that is not a whole
number instead of using their defaults.

### OpenBot reads the Intelligence key the CopilotKit CLI writes

`npx copilotkit project select` writes the key as `CPK_INTELLIGENCE_API_KEY`, which OpenBot did not
read. The server, `scripts/setup-learning.ts` and the Learning setup job now read it first and fall
back to `INTELLIGENCE_API_KEY`; `scripts/start.sh` accepts either, and OpenBot Desktop writes both.

### A local Intelligence install signs in through its own dashboard

Connecting an Intelligence install made with `copilotkit local` failed with `invalid_redirect_uri`.
`bun scripts/setup-learning.ts` now asks the newest CopilotKit CLI on the machine (installed or in
npm's npx cache) for its dashboard and signs in there. Any other Intelligence signs in at its API
address as before.

### A new conversation starts with no Bot chosen

To: starts empty with the list open, unless the address names a Bot (`?agent=`), and Tab goes from
To: straight to the message box. When a Bot's computer stops during a hand-over, the notice says so
in plain words: if you had control it asks you to check the page and hand it back, and otherwise it
says the Bot will ask again if it still needs you.

### A Bot's steps act for that Bot after you leave its conversation

A Bot keeps working after you leave its conversation, but its later steps were decided by whatever
was on screen: a component it drew could show "Not shown", and in another Bot's conversation its
command or page could go to that Bot's computer. Each step now acts for the Bot whose run it is,
with that Bot's own components and tools, wherever you are in the app.

### The private sign-in button shows while a Bot waits for you

When a Bot asked you to sign in to a site in an open conversation, its card said "Waiting for you to
sign in" with no Open private sign-in button. The card now shows the button while the Bot waits.

### A Bot's proposed Bot or skill says when the name is taken

A card proposing a Bot or skill whose name already exists now says so ("Create Researcher, again",
or "Replace" with whose skill it is); it used to check a list that had not loaded. A Bot's own
`list_skills`, `read_skill` and `list_skill_tools` no longer answer "No skills exist here yet" while
skills exist.

### The all-in-one image waits for its database before migrating

With its embedded database, the `openbot` image could start migrating while PostgreSQL was still
starting, fail with `the database system is starting up`, and stay up with no server answering. It
now waits up to 60 seconds for the database, and says what it waited for if it never answers.

### A Desktop download fails only when it stops arriving

OpenBot Desktop gave up on any download that took over 30 seconds in total, which on a connection
under about 1 MB/s failed the Bun download every time ("error decoding response body"). It now gives
up only after 30 seconds with nothing arriving.

### Each source checkout starts its own routine worker

`scripts/start.sh` skipped starting the routine worker whenever any OpenBot worker ran on the
machine, so a second checkout never ran its routines. On macOS and Linux it now counts only a worker
from its own checkout, and stops and says so when it cannot tell.

### A conversation opens at the bottom and stays still while a Bot writes

A conversation opens at its newest messages, and older ones load as you scroll up without moving
the view. Charts, tables and cards grow in place as they stream instead of flashing "not available"
first. A reply is revealed at a steady pace, followed until you scroll up or select text. A rail
beside it has a mark per turn to preview and jump to.

### A Bot is told to search with its search tool, not its browser

A Bot holding a search tool is told to use it, and to keep its browser for signing in, clicking
through a site, forms or a page the person named. Without one it is told never to open a search
engine, to answer from what it knows saying it has not checked, and to show a card for a search app
the person can ask an admin for.

### A computer that is starting says so

The Computer panel said "Can't show the screen right now" while a Bot's computer was asleep or
starting. It now says starting, or off until the Bot next uses it, and shows a problem only when the
computer can't be reached or has gone two and a half minutes without a picture; looking no longer
wakes it. An action a cold start turns away reads "not done yet" and the Bot tries again. A hosted
computer's cold start answers within 45 seconds, under a load balancer's usual 60-second timeout.

### A conversation shows who it is waiting on

While a Bot asks another, the conversation ends with that Bot's avatar and "Asking Risk Analyst…",
and a routine firing into it reads "Market Scout is running a routine…"; the sidebar keeps it lit,
through a reload. A Bot at an address this deployment will not dial fails at once, not after five
minutes of retries.

### A Bot's browser step is no longer refused while it is being saved

Before a click or a typed entry runs, the server checks it against the copy saved in the
conversation. That copy is saved a moment behind, a piece at a time, and a check that read it half
saved refused the step with "That unanswered tool call is not saved in this conversation" or
"Supply a valid request", stopping a form partway. The check now waits up to five seconds for the
step to be saved whole, as it already did for a step not saved at all.

### More credentials in a command are redacted

A credential passed as the word after a flag was kept in clear: `docker login -p secret`,
`sshpass -p secret`, `redis-cli -a secret`, `-asecret` and `--pass secret`. So were a URL with a
password and no user (`redis://:secret@host`) and curl's `--proxy-user user:secret`. All are now
redacted, in the command kept for Action Recording and in the copy exported to a telemetry
collector. Each rule stops where its command does, so the port in `sshpass -p secret ssh -p 2222`,
or in a `docker run -p 8080:80` on the line after a `docker login`, is kept.

For `mysql` and `mysqldump`, the rule that scrubs secrets from a Bot's recorded and exported
commands also hid `-P`, the port, so `mysql -h db -P3306 -phunter2 app` was kept with the password
in plain text. It now hides the password and leaves the port.

### Outside content that looks marked as untrusted is marked anyway

A connector's answer or error was passed to the model without the untrusted-data notice when its
text already started and ended like one. That text could carry a notice in its own words, or close
the tag and continue outside it. Content is now left as it is only when it is exactly the envelope
OpenBot itself writes for that source; anything else is wrapped.

### A Bot that runs on the deployment's own agent works when that agent is on a private address

A Bot created in the app with no address of its own runs on the deployment's agent,
`MANAGED_AGENT_AG_UI_URL`. Where that address is private, as on a local deployment that keeps it on
loopback, every message to the Bot failed with "This deployment will not dial". The deployment's own
agent addresses (`MANAGED_AGENT_AG_UI_URL`, and `PICKED_HARNESS_URL` when `PICKED_HARNESS_IMAGE` is
set) are now allowed at exactly those URLs, when a Bot is saved, in Test connection and on every
run. Another path on the same host and port, and a redirect onto those addresses, are still refused.

### An email trigger reads the mail as the sender wrote it

A base64 or quoted-printable part was always read as UTF-8, so an `iso-8859-1` mail reached the Bot
with every accented letter turned into `�`. Each part is now decoded in the charset its Content-Type
names, and one the runtime does not know still reads as UTF-8. An HTML-only mail kept its character
references once the tags were stripped (`R&amp;D`, `we&#8217;re`). Numeric references, `&amp;`,
`&lt;`, `&gt;`, `&quot;`, `&apos;` and `&nbsp;` are now decoded once, so `&amp;lt;` reads as `&lt;`.

### Long text is cut between characters, not inside an emoji

Where OpenBot shortens text, a cut that landed inside an emoji left a broken character before the
"…". It now drops the half character instead, in a text message too long for one SMS, in what an
approval shows a Bot is about to type, write or send (and each field on the OpenTag card), in the
preview of a private share, and in a tool's link fields and a vendor's refusal the Bot reads.

### No sign-in refuses an address it cannot place

With `OPENBOT_SINGLE_USER=true`, an address with no scheme, such as `example.com:3010`, in
`OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or `TRUSTED_ORIGINS` counted as a private network address
and only warned, though its host could not be read. It now stops the server starting, as an address
the public internet reaches does.

## 0.2.0

**Before upgrading.** Two things change for an existing deployment:
- Migration `0052_shared_brokered_accounts` copies every Composio connection into a new
  `brokered_connections` table and leaves `composio_connections` in place, unwritten. Rolling back to
  0.1.2 works, but accounts connected after the upgrade are invisible to it.
- A handoff now records what started the run it came from. Older remote Bots' signed runs carry no
  such record for up to ten minutes after the upgrade, and calls they make to a Shared app in that
  window are refused.

### The desktop asks before every command that can edit a folder

When a Bot runs a command in a folder shared from the desktop app, the person sees a prompt that can
offer "Always allow in this folder". That choice now covers commands that only read the folder. A
command that can change or delete files in it shows the prompt every time, without the "Always
allow" option. Folders already set to "Always allow" work as before for read-only commands.

### One Bots list, and one page per Bot

Agents, Team Bots and Bots were three lists of the same Bots. `/bots` is now the only one — pinned,
yours, shared with you, and the ones you hid — with **New Bot** at the top. A Bot's page holds
everything about it: its routines, its skills and what it may reach, who it is shared with, and its
name, role and connection. Where updates reach you and your answers to shared Bots moved to
Settings. `/agents` and `/team-bots` still work and open the new places. A Team Bot an administrator
assigns to a group is pinned at the top of its members' Bots list instead of sitting in their
sidebar.

The sidebar no longer lists each Bot that needs you. A badge on Bots counts the questions, approvals
and stalled hand-offs waiting across all of them, and Bots lists those Bots first, under Needs you.
Browser notifications when a Bot starts needing you are unchanged.

The sidebar is now Bots and Skills. Each Bot's page holds what that Bot is waiting on you for, its
suggested next steps, its responsibilities, where it reaches you, its memory sources and background
research, and its approval rules. `/approvals`, `/memory`, `/reachability` and `/responsibilities`
still work and open the new places. Messages from Bots, Slack and Teams that named those pages now
point at the Bot's page.

A group conversation is started like any other: put two or more Bots in the To: field of a new
conversation, in the order they should answer. The separate group button and `/group/new` screen
are gone; `/group/new` opens the new-conversation screen.

Settings now also holds whether your Bots ask before acting, rules for every Bot, your memories, your
devices and recent deliveries, and GitHub event sources. Team approval settings and shared account
requests moved to Admin → Approvals.

### People can link their Slack and GitHub accounts

Settings → Connected accounts gains a Linked accounts section with one card per account a person can
link. Slack links through a one-time code sent to the OpenTag app in a direct message; a code posted
in a channel is cancelled. GitHub links through a GitHub App's user sign-in, set with
`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` (both or neither); the server refuses to start
with them and no public URL. Nothing reads the links yet: they are what GitHub alerts and reviews will
build on. Migration `0053_identity_links` only adds tables.

### An app's account can belong to the team

An administrator can make a Composio app Shared: one account, connected once, that every Bot granted
the app acts as. Who may use it through each Bot is approved per Bot — owner only, named people and
groups, or everyone, and separately whether email, Slack or webhook input may — and checked on every
call. Requests to widen it wait in the Approvals inbox. Writes through a Shared app ask the person
first.

### A new deployment starts with two coworkers, not twelve

The example package loaded every coworker in `examples/fintech/agents/`, so a fresh deployment opened
with General Assistant, Knowledge and ten more at once. The ten now live in `examples/fintech/catalog/`,
which is not loaded, and a new deployment starts with General Assistant and Knowledge. Risk Analyst
and the picked harness still register when their endpoints are configured. To keep any of the ten,
copy its file from `catalog/` into `agents/`.

A deployment that already registered them keeps them. A coworker dropped from the package is not
retired on the next boot: its row stays, still listed and still refused by delete as protected,
because only a remote coworker with a blank endpoint is retired automatically. To remove the ten
from such a deployment, set `deleted_at` on their `agent_profiles` rows after upgrading (see
[configuration.md](docs/configuration.md#agents)).

## 0.1.2

### CopilotKit 1.77 and AG-UI 1.0

OpenBot now runs on CopilotKit 1.77.0 (`@copilotkit/runtime`, `react-core` and `a2ui-renderer`,
from 1.73.1), which carries the Intelligence client, and on AG-UI 1.0 (`@ag-ui/core` and
`@ag-ui/client` 1.0.1, from 0.0.59). A managed Intelligence project needs nothing changed; it is the
client in the server that moved. Among what comes with it: thread naming falls back to the first
message, the realtime connection keeps its place across a repeated checkpoint, an interrupt resume
gets a run id of its own, and generated A2UI controls no longer submit the page's own forms.

Bots served from their own endpoint keep working as they are. AG-UI 1.0 still accepts the earlier
event shapes, so `agent-bot`, `agent-langgraph` and the Python Bots were not changed.

A tool result's `error` field is gone from the `TOOL_CALL_RESULT` event, because AG-UI 1.0 does not
define one. The refusal is still in the result's text and on the tool message, which is where a
Bot's next turn reads it.

## 0.1.1

- A password given to `curl` as `-uuser:password`, `--user=user:password` or `-u "user:pass word"` is
  now redacted in a Bot's recorded shell command. Only `-u user:password` with a space and no quotes
  was recognised, so the other spellings kept the password in the command that was stored or exported.
- A password, token or API key sent as a JSON field in a shell command is now redacted before the
  command is kept or exported. `curl -d '{"password":"x"}'` was recorded with the secret in clear,
  because only `NAME=value` and `--name value` forms were recognised and a quoted JSON key was
  neither. The key is still shown, so the command reads the same.

- A Bot's browser is now refused names under `.localhost`, such as `http://admin.localhost:5432`, the
  same as bare `localhost`. The whole `.localhost` zone is loopback and Chromium resolves it without
  DNS, but only the exact name `localhost` was on the refused list, so a deployment that had not opted
  into private hosts could still be pointed at its own services this way.

- `OPENBOT_SINGLE_USER` is now refused with a public name that starts with `127.`, such as
  `https://127.example.com` or `https://127.0.0.1.nip.io`. The check for a loopback address matched
  any host beginning `127.`, so a public address like that read as this machine and the no-sign-in
  administrator was allowed on it. Only a full 127.x.x.x address counts as loopback now.
- A cancellation the native host never collected is now dropped instead of being reported as
  pending forever. Every timed-out, stopped or revoked host operation queues a cancel for the desktop
  worker, and only that worker ever removed it: a worker that stopped polling left the entry in
  memory for the life of the process, so the Host access panel showed an operation that could never
  finish. A desktop that reconnects within the operation timeout is still told to stop.
- A Bot's shell now honours a Stop that landed before the command was spawned, not only one that
  arrives afterwards. A person who pressed Stop in the window between the request reaching the
  computer and the command starting got no answer until that command finished on its own.
- A file download refused because the computer's response carried no usable byte length now releases
  the connection before reporting the refusal. The unread body could be as large as the whole
  download budget, so a computer reached through a proxy that re-chunks left a transfer running and a
  connection checked out of the pool on every attempt.



- A conversation title cut at 60 characters no longer ends in half an emoji. `slice` counts UTF-16
  code units and an emoji is two of them, so a title cut between the halves rendered a replacement
  character in the sidebar and the picker, where the character itself should have been.

- A tool result that arrives before the call it answers is now paired with that call by the LangGraph
  Bot, as the sibling Bots already did. Read back from the durable thread store the result arrives
  first, which is a payload no provider accepts: a tool message with no preceding call, then a call
  with nothing following it. The model answers that with silence rather than an error, so the Bot
  stopped responding for the rest of the conversation.

- Pressing Stop now stops the computer even when the desktop worker never collects the instruction.
  A stop was queued with no timeout and the worker was the only thing that could ever remove it, so a
  worker that stopped polling left the entry in memory for the life of the process and the Host
  access panel showed an operation that could never finish, growing by one per press. Pressing Stop a
  second time also withdrew the first Stop before the desktop could collect it, and rejected a request
  that nobody was waiting for, which the server treats as fatal. A desktop that reconnects within the
  operation timeout is still told to stop.

### A computer refuses the cloud metadata address written through the NAT64 prefix

A Bot's computer is now refused the cloud metadata address when it is written through the NAT64
prefix (`64:ff9b::a9fe:a9fe` is 169.254.169.254), under every network policy including allow-all.
Only the plain and IPv4-mapped spellings were refused, so on a network with a NAT64 gateway the
metadata endpoint was one rewrite away. Browsing already refused this spelling; the computer's
filter now agrees.

### `?sslmode=require` on `DATABASE_URL` now connects to a managed database

A deployment pointed at RDS, Cloud SQL or Azure Database could not start. The server sent
`sslmode` to Postgres as a connection parameter instead of turning TLS on, so the connection went
out unencrypted and was refused with `no pg_hba.conf entry for host ... no encryption`, the very
error the Helm chart's README says `?sslmode=require` avoids. Migrations were unaffected, which is
why a deployment got as far as a migrated database and then crash-looped. `sslmode=require` now
encrypts the connection, and `sslmode=disable` turns TLS off. `sslmode=verify-full`, with an
optional `sslrootcert`, checks the certificate on Bun 1.4 and later and is refused on Bun 1.3,
which connects to any certificate. `verify-ca`, `prefer` and `allow` are refused with a message
naming the modes that work.

### A coworker the message speaks to is routed to without asking a model

Addressing a coworker by name went to the intent router like any other message, so the deployment
paid a model call to be told what the person had already said, and sometimes was told something
else. A message that speaks to a coworker by its full name now routes straight to them: it opens
with the name ("Risk Analyst, please check this"), names it with `@`, or asks it ("ask Risk Analyst
to review this"). It is recorded as `matched a coworker’s name in the message` with
`viaNameMatch: true` on the same `channel.routed` row. A name in passing ("don't send this to Risk
Analyst") and a word that only ends a name ("review this contract", "my meeting notes") still go
to the router. When the message addresses more than one coworker, or two share the addressed name,
it is refused with distinct labels, and the composer keeps the draft and asks the person to choose
instead of starting the default coworker. Explicit picker choices still use `viaMention: true`.

### A Bot's turn in a group is no longer offered coordination tools it cannot call

A Bot answering another Bot in a group conversation was offered `ask_person`, and `message_bot`
when hops allowed it, but every call was refused with "This run no longer has permission to
coordinate work in this conversation" and an `mcp.callback_refused` row nobody had caused. A run is
now offered these tools only when a call from it would be allowed, so that turn is offered neither.
A call that is refused anyway, from a schema offered earlier, is still refused and audited.

## 0.1.0

**Before upgrading.** Six things change for an existing deployment:
- Automatic Learning is on unless an administrator saved it off. It does nothing until a Learning
  container is assigned; see below.
- A Bot's computer refuses the network until the server pushes its policy. A computer run without
  an API server can set `EGRESS_POLICY_REQUIRED=0` for the old behaviour.
- The upgrade runs migrations `0042_user_preferences`, `0043_plugin_logos`, `0044_voice_sessions`,
  `0045_channel_activity_source`, `0046_automatic_learning`, `0047_agent_pinning`,
  `0048_coworker_parity`, `0049_coworker_parity_lanes`, `0050_review_fixes` and
  `0051_routine_enabled_at`.
- An existing Windows clone checks text files out with LF only after
  `git rm -r --cached . && git reset --hard` on a clean tree.
- The signed-in app shows a bar offering CopilotKit's help self-hosting OpenBot, unless the
  deployment is on a paid Intelligence plan. Set `OPENBOT_SELF_HOST_BANNER=false` to remove it for
  everybody.
- An egress rule with a malformed IP range, such as `10.0.0.5/`, used to be read as `/0` and allow
  every IPv4 address. It is now refused, and a saved network policy that contains one is refused as
  a whole: the Bots under it fall back to an allowlist with nothing on it, so they reach nothing
  until the rule is corrected under Admin → Enterprise.

### A group reply the owner allows still reaches the Bot it names

A reply held until its owner allowed it to be shown in a group was written into the transcript and then stopped. The same reply allowed immediately was handed to the Bot it named. Allowing it now hands it on the same way.

**Before upgrading.** Four things change for an existing deployment:

### The app offers help self-hosting OpenBot, until you close it

A slim bar at the top of the signed-in app links to CopilotKit's engineers for help self-hosting
OpenBot. Closing it is saved to your preferences, so it stays closed on every device. A deployment
on a paid Intelligence plan (`pro`, `team`, `team_self_hosted` or `enterprise`, or a licence bought
through AWS Marketplace) never shows it; any other plan, or an entitlement that cannot be read,
shows it. A fork running OpenBot for its own organization hides it for everybody with
`OPENBOT_SELF_HOST_BANNER=false`.

### A request to the approvals API that is not JSON answers 400

A body that could not be parsed as JSON, sent to any approvals route that reads one, such as
`PATCH /api/approvals/preferences` or `POST /api/approvals/rules`, answered 500 with the parser's own
message. It now answers 400 "Supply a valid request.", as the delivery routes do.

### Syncing a memory source a policy refuses says why

When a connected app's policy refused the read behind a memory source's sync, `POST
/api/memory/sources/:id/sync` answered 503 "Memory is unavailable. Try again.", although the
refusal's own sentence was already saved on the source. It now answers 400 with that sentence, as
the plugin routes do for the same refusal.

### `@Ops Lead` in a group addresses Ops Lead, not Ops as well

In a group conversation, a reply naming `@Ops Lead` also addressed a Bot called Ops, because the
shorter name matched at the same `@`, so both answered. An email address addressed a Bot by its
domain: `jo@sam.com` reached a Bot called Sam. Where two names start at the same `@`, only the
longer one is now addressed, and an `@` straight after a letter or digit is not a mention.

### A webhook with many long top-level fields no longer stops the server

A trigger's event is cut to 32 KiB before it is recorded, keeping each top-level text field up to
1000 characters and an excerpt of the rest. A flat payload whose fields alone came to more than
that, such as forty 1000-character fields, left the excerpt nothing to give up, and the loop
trimming it never ended. That loop runs on the server's only thread, so every request stopped being
answered. The kept fields now get at most half the space, and the rest is still in the excerpt.

### A malformed IP range in an egress rule is refused instead of widening the rule

An egress `cidr` rule written `10.0.0.5/` was stored as `10.0.0.5/0`, which is every IPv4
address, so a typo for one host opened an allow-list to all of them. `/0x8` and `10.0.0.0/8/9` were
accepted the same way. A zone id such as `fe80::1%eth0` was accepted too, and then threw from the
filter on the first connection that policy judged. Each is now refused when the rule is saved, with
the sentence a malformed range already got. A rule like this saved earlier matches nothing.

### Deleting a channel twice is recorded once

A second `DELETE` of the same channel, from a retry or a second tab, still answers 204 as before.
It no longer tells every member again, and no longer writes another `channel.deleted` row to the
audit trail for a deletion that did not happen.

### A Bot's saved reply in a group is no longer replaced by a later error

In a group conversation, a Bot's reply was saved, then handed on: to Activity, to any consent
cards, and to the Bots it named. A fault in that hand-on, such as the audit trail being
unreachable, wrote the error's text over the saved reply and marked it failed, and a retry did not
bring the reply back. The reply now stays as saved, the fault is logged as
`group-turn-after-reply-error`, and any consent cards or handoff the fault interrupted are still
posted.

### The egress filter reaches an IPv6 upstream proxy and asks it for IPv6 hosts correctly

An upstream proxy configured at an IPv6 address, such as `http://[fd00::1]:3128`, could not be
reached: the filter handed the address to the socket with its brackets, and the socket looked it up
as a name. A `CONNECT` to an IPv6 host was also sent to the upstream without the brackets an
authority needs, as `CONNECT ::1:443`. Both now work.

### The Helm chart configures Slack, Teams, text messages, push, SCIM, inbound email and OpenTelemetry

These settings had no chart values and could only be passed through `config.extraEnv`. They now have
their own: `config.opentag`, `config.sms`, `config.push`, `config.deliveryPublicUrl`, `config.scim`,
`config.inboundEmail` and `config.otel`, with the OpenTag secret, the Twilio auth token, the Expo
access token, the SCIM bearer tokens and the OpenTelemetry headers under `secrets` (or an existing
Secret or store, by key). The install refuses what the server would refuse at boot, such as an
OpenTag secret under 32 characters or a partial set of Twilio settings. With none of them set, the
chart renders exactly as before, so a deployment already passing these through `config.extraEnv`
keeps working unchanged until it moves them across.

### A coworker at its own endpoint can hand work to another Bot

A grant letting a remote Bot (a coworker at its own endpoint) hand work to another Bot was accepted and stored, but the grant read kept only built-in Bots, so the remote Bot was never
offered `message_bot` and a call it made anyway was refused as not granted. The read now counts a
grant whatever the Bot's type, so a remote Bot hands work on through the same signed callback, grant
check, caps and audit rows as a built-in one, to a built-in Bot or to another remote Bot. The
coworker's handoff panel now offers it the same switches.

### A channel cursor with a malformed time reads as the first page, not a 500

`GET /api/channels` only checked that a cursor's time was a string before casting it with
`::timestamptz`, so a hand-edited or corrupted cursor such as `{"recency": "not-a-date"}` answered
500. A time that is not the UTC timestamp the list writes now reads as the first page, the way every
other malformed cursor already did.

### A playground component's Published switch publishes its source too

The Published switch on an admin component page called the generic publication endpoint for every
kind. For a browser-authored component that endpoint promoted the description and marked it
published without copying the playground draft, so Bots were offered a component the renderer could
not draw. Playground components now publish and withdraw both rows in one transaction; a missing or
empty description or HTML is refused instead of leaving a half-published component, and repeating
an unchanged publish no longer advances the revision.

### A proxy password containing `%` no longer stops every shell command

A proxy password with a `%` that does not start an escape, such as `p%zz`, made decoding it throw.
- In the computer's shell, which strips proxy credentials before every command, every `/exec`
  failed as a result.
- Resolving a Bot's egress proxy failed the same way.

Such a password is now taken as written, and it is still kept out of the shell's environment.

### Revoking a credential twice says so, instead of answering a server error

Revoking a credential that was already revoked, or that does not exist, now answers 404 with the
reason. Rotating one that is gone answers 404, and rotating one that is revoked or does not match
the key answers 409. Before, each answered a plain-text 500, as if the deployment were broken; a
double click on Revoke was enough to cause it. The refused-rotation audit row is written as before.

### The channel list no longer skips channels made in the same millisecond

The channel list's page cursor kept the last channel's time to the millisecond, while PostgreSQL
keeps it to the microsecond. Channels later in that same millisecond, as a package sync or an
import makes them, sorted after the cursor and were on no page. The cursor now carries the time to
the microsecond, as the audit trail's cursor already did.

### A package skill's slug has the same shape as one made in the app

The skills screen, the skills API and the store all accept a slug of 2 to 40 lowercase letters,
digits and hyphens that starts and ends with a letter or digit. `skills.yaml` accepted any length
and a trailing hyphen, so a package could seed `a`, `a-` or a sixty-character slug that nobody
could then edit. A package with such a slug is now refused at load, with a sentence naming it.
Every slug in `examples/fintech` already has the shape.

### A tenant package that repeats itself is refused by name, instead of failing at boot

Validation now refuses each of these, with a sentence naming the file and the repeated id:
- A skill named twice by one agent, or an agent listed twice in one channel's `permitted_agents`.
  Before, the server stopped at boot with a raw SQL error.
- An agent id repeated within `agents.yaml`, a channel id within `channels.yaml`, or a skill slug
  within `skills.yaml`. Before, the last entry silently won, though two files declaring the same
  agent were already refused.
- A remote agent left blank in `agents.yaml` but declared with an endpoint under `agents/` was
  dropped from every channel that named it. It is now treated as declared.

### `start.sh` and `stop.sh` see their own processes on Windows

In Git Bash on Windows, which has no `lsof`, `pgrep` or `pkill`, every process and port lookup in
the two scripts came back empty.
- `bash scripts/stop.sh` reported the app, the routine worker and the API server as not running,
  and left all three up.
- `start.sh` could not see a port held by another process.
- `start.sh` started another routine worker on every rerun, then reported that the one it had just
  started "did not stay up".

Where those tools are missing on Windows, the scripts now ask PowerShell, which ships with Windows.
Everywhere the tools exist they are used exactly as before.

### The supervisor and the Python Bots compare their tokens in constant time

The supervisor compared its bearer token with a plain string comparison, and the eleven Python Bots
compared the shared agent token as text, which answered 500 rather than 401 on a header carrying a
non-ASCII character. Both now compare bytes in constant time, as the server and the computer already
did. A wrong or missing token is refused exactly as before.

### A clone on Windows builds an image that starts

On Windows, where Git converts line endings by default, a clone checked every text file out with
CRLF. `docker build` copied the s6 service files into the image that way, so a service's `type`
read `longrun\r` and its scripts stopped on `set: -: invalid option`, and `bun run format:check`
failed on every file. `.gitattributes` now checks text files out with LF on every system. An
existing clone with nothing uncommitted picks this up after `git rm -r --cached . && git reset --hard`.

### A routine switched back on gets a fresh count of failures

A routine that fails ten times in a row is switched off, and someone has to switch it back on.
- **Before:** the failure count ignored that, so the first failure after re-enabling counted as the
  eleventh. The routine was switched straight off again with "failed ten times in a row", and the
  first-failure message never appeared.
- **Now:** failures are counted from when the routine was last switched on, recorded in a new
  `routines.enabled_at` column. The migration sets it to the time of the upgrade, so any failure
  streak already under way starts again from zero at that point. Adds migration
  `0051_routine_enabled_at`.

### Generated workspace files can be downloaded intact

`GET /api/computers/:botId/files/download?path=...` streams a generated file as an opaque
attachment instead of returning the 64 KB UTF-8 text extract. Downloads use the separate
`computer_download_file` / `download_file` permission, remain confined to the Bot workspace, are
capped at 100 MiB with `413`, and are recorded on the computer audit trail. Switching off **Cloud
computer use** under Admin → Enterprise refuses downloads as it refuses reads. Existing read, list
and write APIs are unchanged.

### Bots work as coworkers

A Bot can now carry on without anyone watching it. It runs standing **Responsibilities** fed by
schedules, signed webhooks, GitHub, Linear, Sentry, PagerDuty, inbound email and Slack messages,
drives its own computer while the app is closed, and keeps its browser profile, cookies and files
across restarts. Its questions and approval requests reach the person who owns the conversation in
Slack or Microsoft Teams (through OpenTag), by text message or by push, and the conversation
resumes when they answer; charts reach Slack and Teams as native charts. **Reachability** links
each of those places to a conversation.

Approvals become one personal flow across the browser, connected apps, shell, files, the host and
remote Bots, with custom rules, auto-review and host command modes (**Approvals**). Bots can
message each other, share a group conversation with attributed speakers, and be published to
teammates as **Team Bots**. **Memory** imports facts from connected apps with their source, and
optional background research suggests next steps. A browser demonstration can be recorded and
turned into a skill. Administrators get capability toggles, SSO-required sign-in, SCIM, network
egress policy, action recording, OpenTelemetry export, and **Passwords** with private sign-in
requests.

Upgrading runs migrations `0048_coworker_parity`, `0049_coworker_parity_lanes` and
`0050_review_fixes`.

### A Bot's computer refuses the network until its policy arrives

A computer used to allow every connection until the server had pushed its Bot's network policy,
which left up to 30 seconds of unfiltered access after every wake. It now refuses until the policy
arrives, and the server pushes it as the computer wakes. Cloud metadata and link-local addresses are
refused in every mode, including `allow_all`, and the browser's WebRTC traffic now goes through the
filter instead of around it. A computer run without an API server can set
`EGRESS_POLICY_REQUIRED=0` to keep the old behaviour.

### Parallel Search is in the plugin catalogue

Two catalogue entries reach Parallel's public-web search and extraction at
`https://search.parallel.ai/mcp`: **Parallel Search**, anonymous with provider-managed limits, and
**Parallel Search (API key)**, which sends a deployment credential as a bearer token. Nothing is
granted automatically. When a Bot holds both `web_search` and `web_fetch`, the built-in Bot guidance
describes them for public-web research, and the fintech example's Research Desk ships a
`research-public-web` skill that declares them. See
[Public-web research with Parallel](docs/parallel-research.md).

### `lodash-es` is pinned to the patched 4.18.0

A root `overrides` entry pins the transitive `lodash-es` to 4.18.0, the patched release, wherever a
dependency pulls it in.

### Provider and Bot lookups ignore inherited object properties

Unknown names such as `constructor` and `__proto__` no longer return an inherited
JavaScript object as a provider or Bot entry. Unknown providers return no spec, and
missing Bots raise the existing startup error. Configured providers and Bots are unchanged.

### A malformed `%` in a stream URL no longer returns a 500

A request to `/api/computers/<id>/stream` whose id held a broken percent-escape, such as `%zz`,
made the server throw and answer 500. It is now treated as not matching the stream route and goes
through normal routing. Valid ids behave as before.

### `start.sh` names the port to change on macOS

When the API server's or the app's port was held by another process, `start.sh` was meant to say
which setting to change, such as `Re-run with SERVER_PORT=<free port>`. On macOS, whose bash is
3.2, the run ended on `bad substitution` before printing it, because the hint upper-cased the
name with a bash 4 expansion. It is upper-cased with `tr` now, so the hint prints on either bash.

### `start.sh` starts the Docker services on Compose v5

On Docker Compose v5, `bash scripts/start.sh` stopped at
**1/4 Docker services** with `failed to get console: provided file is not a console`. The script
sends compose's output to `/dev/null` while its errors still reach the terminal. Compose saw that
terminal, chose its interactive build display, and could not draw it. The script now asks compose
for quiet progress through `COMPOSE_PROGRESS`, which older Compose versions ignore, so nothing
changes where it already worked.

### The skills pages say when the skills could not be read

When `GET /api/plugins` failed, **Agent Skills** said "You don't have any skills yet.", **Admin →
Skills** said "No skills yet.", and opening a skill to edit said "That skill no longer exists, or it
is not yours to edit.", to people who may have written a dozen. They now say the skills could not
be loaded. A list that arrived empty still reads as before, and a failed refetch over a list already
on screen keeps that list.

### A coworker can be pinned to the top of the Agents screen

A coworker's Manage tab has a **Pin** switch beside Hide, and pinned coworkers move into a
**Pinned** section at the top of `/agents`. Like hiding, pinning is personal: it changes nothing for
anyone else. It is stored next to `hidden_at` in `agent_preferences` as a new `pinned_at` column
(migration `0047_agent_pinning`), and each write sets only its own column, so pinning a hidden
coworker keeps it hidden and it comes back pinned when unhidden. `POST /api/agents/:id/pin` and
`/unpin` record `bot.pinned` and `bot.unpinned` on the trail, as hiding does.

### A hidden coworker can be found again on the Agents screen

Hiding a coworker took it off both lists on `/agents`, and Unhide is only in the coworker's dialog,
which only its card opens, so a hidden coworker had no way back short of typing its id into the
address bar. The screen now ends with a collapsed **Hidden** section listing them, each card opening
the dialog as before. It appears only when something is hidden. Hiding still changes nothing for
anyone else, and nothing on the server changed: the screen reads the `GET /api/agents?hidden=true`
list the server already served.

### A connector's own pages say when the plugin list could not be read

When `GET /api/plugins` failed, a connector's admin page said "Not a plugin", a tool's page said
"This deployment has not enabled that connector.", and a person's connected-account page said "This
is not a service you connect for yourself.", each about a connector that may be added and granted
right now. They now say the list could not be loaded, as the per-Bot grant page beside them already
did. A list that arrived without the connector still reads as before.

### Boundaries says when the policy could not be read

When `GET /api/computers/policy` failed, the Boundaries screen showed its title over nothing, for as
long as it was open. It now says "The boundary could not be read.", or the server's own reason, as
it did before the screen's read moved into a query.

### Browser controls are visible in chat and the Computer sidebar

Channel chats and standalone Bot chats now have a labeled Computer button and always-visible
Take control or Hand back controls. The same ownership state is shown in the chat, live Computer
sidebar, and full-size viewer. Standalone Bot chats can open the current live browser alongside
the conversation without losing the selected Bot or chat history.

### An administrator cannot grant a skill nobody has written

`POST /api/plugins/grants` checked that a skill existed for everybody except an administrator, whose
grant was stored whatever it named. A Bot's skills are read by slug alone, so the row waited for
whoever wrote a skill under that name next, and on a Bot the deployment shares that was one person's
instructions answering everybody. It is now refused with "There is no skill called …", as a grant
naming no app already was. Revoking one by hand still works.

### A remote Bot keeps answering when it asks for a learned skill that is not there

With Automatic Learning delivering skills, a Bot reached at an AG-UI endpoint (every shipped Bot
except a built-in one) ended the whole turn with "Skill is unavailable." in place of an answer when
its model asked for a skill by a name the snapshot does not hold, for a file the skill does not
list, or sent arguments that were not JSON. A built-in Bot's model is handed that sentence as the
call's result and carries on. A remote Bot's model now gets the same result and carries on too.

### An app or skill cannot be granted to a Bot that does not exist

An administrator's `POST /api/plugins/grants` for an app or a skill checked that the app or skill
existed but not the Bot, so a mistyped Bot id reached the insert, failed on the `plugin_grants`
foreign key, and answered 500 with no body. It is now refused with "There is no such Bot.", the
sentence the `bot` kind already used, and nothing is stored. Revoking still checks nothing.

### A malformed OAuth client is refused with a 400, not a 500

`POST /api/plugins/servers/:id/oauth-client` called `.trim()` on the client id and secret without
checking they were strings, so `{"clientId": 12345, "clientSecret": "s"}`, or a secret of `{}`, threw
outside the route's try and answered 500. It now answers the same 400 as an empty value, as the
other plugin routes do for their own fields, before the store or the audit trail is touched.

### Browser challenges can be handed to a person without losing the Bot's page

Bots pause for actionable browser challenges and resume from a fresh page snapshot after an explicit
handback. Requests survive viewer reconnects and distinguish completion from cancellation, expiry,
or an interrupted browser session. Managed browsing now uses full Chromium in headless or headed
mode. Local API deployments can opt into installed Chrome with dedicated per-Bot profiles, the same
in-app viewer, a loopback-only computer endpoint, and host shell execution disabled.

### A hidden Bot's app grants stay on the Plugins screens

Hiding a Bot from your own roster took it off the Plugins screens too: its row went from By Bot and
from each tool's switches, the counts could read "3 of 2 Bots", and its own page said there was no
such Bot. Its grants stayed in force, and nothing on any screen could take them away. The Plugins
screens now follow the rule the Handoff panel already does: a hidden Bot is shown when it holds one
of the grants the screen is about, marked "Hidden from your roster", and its own page draws its
grants. Nothing on the server changed.

### Revoking a function from a component that does not exist answers 404

`DELETE /api/components/:name/functions/:function` was the one grant write that did not check the
component exists. Against a name nobody has, it deleted nothing, answered `revoked: true` and wrote a
`component.function_revoked` row naming a component that was never there. It now answers 404 and
writes nothing, as granting a function and withholding a component already do. A function grant
cannot outlive its component, so there is no stored row this stops anybody removing.

### A wiped or restarted shared computer no longer leaves refs pointing at the dead page

Snapshots are ordered on the run of the browser that took them as well as the generation, so a
computer that is replaced cannot have its old page mistaken for its new one. That ordering was
reaching only the deployments that give each Bot its own container or sandbox, because the run was
read off the infrastructure and the deployment with one shared computer has none to read.

Two failures followed there, and both are fixed. A snapshot still in flight when somebody pressed
Reset brought the wiped page back, and the boundary went on deciding about its elements: a rule about
"Confirm transfer" firing on a click nowhere near one, or failing to fire on one that is. And a
computer that restarted counted generations from one again, so its first snapshots were dropped as
stale and refs kept resolving against a page nobody was on until the counter climbed back past it.

The computer now mints a run for each Bot's browser session, mints a new one when the Bot is reset,
and answers which run it is on. Nothing changes for a deployment that already reports one, and a
computer too old to answer leaves the ordering exactly where it was rather than refusing anything.

### `scripts/start.sh` no longer needs python3

The runtime health check in step 3 was a `python3` heredoc. On a machine without Python, and on
Windows, where `python3` is usually the Microsoft Store alias that exits 49, the run stopped there
with the server and worker up and the app never started. The check now runs in Bun, which the
script already requires, with the same output and exit status, and `python3` is gone from the
prerequisites in `docs/development.md`.

### An MCP tool that answers with a resource link is no longer read as an empty name

A tool that points at a file or a page often returns a `resource_link`: a URI, a name, and a
sentence of what it is, rather than the contents themselves. That part was named `[resource_link]`
and the URI was dropped, so the model was told a link arrived and never shown where it went. A
search that answered with pages produced no page it could open. The URI, name and description are
now read, each on its own labelled line. The URI leads and the name and description are bounded, so
a long name cannot push the pointer past the result cap; a server's `title` is shown over its `name`
when it gives one. A part that already carried text is unchanged.

### The Microsoft Agent Framework Bot answers on a plain OpenAI key

Picked with an OpenAI key, the Microsoft Agent Framework Bot failed every run with "Connection
error.". Compose writes `OPENAI_BASE_URL` empty when the choice is a plain OpenAI key, and the
OpenAI SDK only defaults an absent URL, so it was given "" as the address. The Bot now falls back to
`https://api.openai.com/v1` for an empty value, as its Anthropic branch already did for
`ANTHROPIC_BASE_URL`. An OpenAI-compatible endpoint is unchanged.

### `OPENBOT_ONE_COMPUTER_EACH=false` in `.env` is honoured by `start.sh`

`scripts/start.sh` read `OPENBOT_ONE_COMPUTER_EACH` from the environment alone, so the line that
`docs/configuration.md` tells people to put in `.env` was ignored: the supervisor was still started
and the server still told to give each Bot its own computer. It now reads the key as it reads every
other setting, the environment first, then `.env`, then the default of `true`.

### Skill selection keeps capabilities named across multiple JSON replies

When a model wraps its skill choice in prose or sends a revised JSON object, OpenBot reads each
complete `skills` list and offers the union of the named skills' granted tools. This also works with
Anthropic's OpenAI-compatible endpoint, which may ignore the request for bare JSON. Previously a
reply containing multiple objects fell back to offering every tool; replies with no valid `skills`
list still do.

### The AG2 Bot answers on a plain OpenAI key

Picked with an OpenAI key, the AG2 Bot failed every run. Compose writes `OPENAI_BASE_URL` empty when
the choice is a plain OpenAI key, and the OpenAI SDK only defaults an absent URL, so it was given ""
as the address. The Bot now falls back to `https://api.openai.com/v1` for an empty value, as its
Anthropic branch already did for `ANTHROPIC_BASE_URL`. An OpenAI-compatible endpoint is unchanged.

### The live screen keeps reconnecting after it has recovered

A dropped live screen retries five times, waiting half a second, then one, two, four and eight, and
then asks for Retry. The count of retries never went back to zero after a retry worked, so a screen
left open through five short drops over an afternoon gave up on the sixth, although each had
recovered within a second. The count now starts over once a reconnected screen shows a frame again,
so only five failures in a row end in Retry.

### A failed save of a Bot's browser control leaves no copy behind

The computer keeps who holds a Bot's browser, and its handoff requests, in one file per Bot under
the profiles volume, written to a temporary file first and renamed over it. When the write or the
rename failed, the temporary file stayed, a readable copy of that state beside the real one, and
every later failure added another. It is now removed whether or not the save succeeds, as the
learning setup and the model sign-in file already do.

### Every Bot's provider defaults live in one spec file

`shared/model-providers.json` now holds the provider facts and the default provider and model of
the thirteen Bots that read it: the three TypeScript Bots through `shared/model-providers.ts` and the
ten Python Bots through `shared/model_providers.py`. The Claude Agent SDK Bot does not read it.
`BOT_PROVIDER` and `BOT_MODEL` still win over both, and each Bot keeps its existing default,
including Mastra's `gpt-4o-mini`. Moving a Bot to a different model is one row in one file.

Both loaders check the file against their own list of providers and refuse in the same words, so a
wrong row now stops all thirteen at startup, naming the key, where the Python Bots used to start
clean and meet it at their first model call. The Mastra Bot also refuses a `BOT_PROVIDER` it does
not recognize (such as `google`) instead of quietly answering through OpenAI with a different model.

Compose used to substitute `gpt-5.5` for `agent-langgraph` whenever `BOT_MODEL` was unset, whatever
`BOT_PROVIDER` named. It now passes the unset value through, so the Bot's own row answers: an OpenAI
deployment keeps `gpt-5.5`, and a Google or Anthropic one stops being handed a model its vendor has
never heard of. The picked harness in Compose now also receives `GOOGLE_API_KEY` and
`GOOGLE_GENERATIVE_AI_BASE_URL`, so a harness picked on `BOT_PROVIDER=google` has its key.

### Automatic Learning, on by default

Every shipped Bot can now contribute completed conversations to a CopilotKit Intelligence Learning
container and receive the skills published from it. **Admin → Automatic Learning** chooses a default
container, overrides or excludes individual Bots, and pauses Learning. Chat, channels, routines and
handoffs all follow the same settings.

Learning is on unless an administrator has saved it off, and a saved off stays off. It collects and
delivers nothing until a container exists in the Intelligence project and is assigned:
`bun scripts/setup-learning.ts` creates or reuses one called `openbot` and writes it to `.env`, or
set `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` (Helm: `config.learning.containerId`), or enter it on
the Admin page. OpenBot starts and chats without one. Skills are reviewed and published in
Intelligence; nothing is approved automatically. See
[Automatic Learning](docs/automatic-learning.md). Adds migration `0046_automatic_learning`.

### Dictate messages and talk to a coworker in a live voice call

Deployments can configure transcription separately from their Bots' models, with a waveform composer
for recording, cancelling, transcribing, or sending speech. Optional OpenAI Realtime and Grok voice
adapters add a floating call widget. The live model handles conversation directly and delegates tools
and actions to the existing Bot in the same thread. Ending a call saves its transcript and a short
summary; later voice calls and typed messages receive that history. Calls start silently, and muting
affects the person's microphone. See [configuration](docs/configuration.md#live-voice-calls).

Voice summaries use the configured chat provider, including Anthropic keys and Claude or ChatGPT
plan sign-in. Retrying a failed summary refreshes its sidebar preview without replacing newer
activity. A call the voice service turns down says why, such as "The voice service is busy. Please
retry shortly.", and a call that cannot be saved says "Could not save this voice chat." and stays on
its card to retry. Caps on a call's context, captions and answers cut between characters, never
inside an emoji.

### The Pydantic AI Bot answers on a plain OpenAI key or an Anthropic key

Picked with either key, the Pydantic AI Bot failed every run. Compose writes the endpoint the choice
did not need as empty (`OPENAI_BASE_URL` for a plain OpenAI key, `ANTHROPIC_BASE_URL` for an
Anthropic key), and Pydantic AI builds each provider's client from the environment, so the SDK was
given "" as the address. The Bot now removes an empty value before building the model, as
`agent-langgraph-agui` already does, so the SDK uses its own endpoint. A real endpoint is unchanged.

### The Langroid Bot answers on a plain OpenAI key

Picked with an OpenAI key, the Langroid Bot failed every run with "Connection error.". Compose
writes `OPENAI_BASE_URL` empty when the choice is a plain OpenAI key, and the OpenAI SDK only
defaults an absent URL, so it was given "" as the address. The Bot now drops an empty
`OPENAI_BASE_URL` before it builds its client, as it already does for an empty `OPENAI_API_KEY`.
An OpenAI-compatible endpoint is unchanged.

### Find older conversations and keep chat preferences across devices

The sidebar loads older conversations as the person scrolls. Settings save the choice to emphasize
the agent or thread name in the database, with a preview. Agent directory cards have more space,
connected accounts use individual entries with stored app logos, and browser steps appear in a compact
expandable group instead of filling the conversation with screenshots.

## 0.0.15

### A model provider's own sign-in can stand in for an API key

`OPENBOT_MODEL_OAUTH_FILE` names a credential file holding a Google or xAI OAuth grant. Set it and
the server mounts `POST /api/model-provider/v1/chat/completions`, which answers an ordinary Chat
Completions request using that grant, refreshing the access token 120 seconds before it expires and
again on a provider 401, and persisting the rotation under a lock the writer and the desktop share.
Leave it unset, which is every deployment that does not set it, and the route does not exist.

The caller authenticates with a separate local bearer taken from that file, compared in constant
time, never with the provider's own token: a refresh token never leaves the server process. The file
itself is refused unless it is a regular file under 64KB owned readable by nobody else, and a Google
grant must name a quota project. The upstream host, path and headers are fixed, so nothing a caller
sends can redirect the request.

Google is reached through its native generation API rather than a compatibility endpoint, with a
translation layer that carries streaming, tool calls and their results, inline images and
function-call thought signatures across in both directions. An API-key connection is unchanged and
still uses the compatibility endpoint.

**A provider 403 no longer reads as an expired sign-in.** It usually means a missing project or
resource permission, which signing in again cannot fix, so only a 401 now raises "sign in again".

### Desktop setup shows progress, chooses its own local ports, and can sign in to a provider

Downloads report transferred bytes, every running step reports elapsed time, and running, completed
and failed stages are told apart. Back preserves the connections already entered.

OpenBot now chooses its local ports by binding them rather than assuming them, holds them until the
whole set is settled, and writes them to the deployment's `.env` so a restart keeps the same
addresses. That covers a port another program holds and a port Windows has reserved, neither of
which the old fixed defaults survived. A port that becomes unavailable between choosing and starting
now says so and asks for another Start, where it previously refused before trying.

Setup can create a CopilotKit project, and offers Google Gemini and xAI as API-key choices alongside
OAuth sign-in. Google sign-in requires this build's own registered desktop client and quota project,
set at build time or by environment variable, and refuses with a message saying so when it has
neither; xAI falls back to a public client and works in any build. `desktop/PROVIDER_OAUTH.md`
describes what a distributor configures.

A deployment left behind by an earlier installation can be detected and reset from the app, which
removes that deployment's database volume and nothing else.

Startup failures keep enough of the log to name the cause, with every secret value redacted, and
carry a support link a whitelabel build can point elsewhere.

### A Bot's image pull finds the Docker credential helper beside Docker

A Docker install whose credential helper sits next to the `docker` binary rather than on the desktop
app's own PATH failed the pull with a PATH error naming the helper. The directory holding the
resolved `docker`, and the directory holding what it points at when it is a symlink, are now appended
to the PATH the engine is invoked with. Appended, so an existing helper still wins, and the inherited
PATH is now kept rather than replaced, which it was not before.

### OpenBot starts only on the Bun it pins

An installed or cached Bun that is not the pinned version is no longer accepted, on install and on
every start, and OpenBot acquires its own copy instead. The version already on the machine is left
exactly as it is and simply not used.

### Organization sign-in survives a callback that arrives in pieces

The loopback listener that receives an organization or provider sign-in read the callback once and
gave up if the whole request had not arrived, and on Windows the accepted socket inherited the
listener's non-blocking mode, so a timeout did not apply. A good sign-in could be answered "Sign-in
did not match". Both paths now read until the request line is complete, with a real timeout.

### Compose file lists separate correctly on Windows

The separator between Compose files fell back to `:` everywhere, which is right on macOS and Linux
and wrong on Windows, where a drive letter contains one. It now follows the platform. This is
reachable on every platform now that a port overlay is passed, where before it was macOS only.

## 0.0.14

### A tool cannot be granted for an app this deployment has not added

Granting a Bot a connector's tool checked only that the person asking was an administrator, so a
grant naming an app that was never added was stored and then invisible — the page that reports a
grant nothing advertises is built from the connector's own row, and there was none. Adding that app
later put every such grant straight onto its Bots, with nobody having granted anything and nothing in
the trail saying so. The grant is now refused, naming the app. Taking a grant away is unaffected, so
a dead row an administrator can see is still one they can remove, and a tool a connector has stopped
advertising can still be granted: what a vendor lists today is not what somebody decided yesterday.

### The LiteLLM Bots keep the chosen provider on a model name that contains a slash

A model name the endpoint publishes with a slash in it — `qwen/qwen3-8b`, or the docs example
`openai/gpt-5.6-terra` — was treated as already carrying a provider. LiteLLM then took the first
half as the provider and sent only the rest, so a compatibility endpoint either failed with
`LLM Provider NOT provided` or received `gpt-5.6-terra` instead of the namespaced name. The ADK,
Strands, Agno, LlamaIndex and CrewAI Bots now keep the chosen provider in front, and the whole
model name reaches the endpoint.

### A Google Drive shortcut is read as the file it points at

Search and recent files return shortcuts as ordinary hits, and reading one by that id was refused
as a binary `application/vnd.google-apps.shortcut`. A document somebody had starred or filed as a
shortcut — the usual way a shared drive file is kept at hand — could be named and not opened. The
connector now follows the target once and reads that file the same way it would have if search had
returned it directly. A shortcut that names nothing, or another shortcut, is still declined.

### An MCP tool that answers in structuredContent is no longer read as empty

A tool that declares an output schema often puts the answer in `structuredContent` and leaves the
content list empty. That empty list was reported as "nothing was found", so the model filled the
gap from memory while the vendor had answered. The structured object is now read when the content
list had nothing to say. A tool that already sent text is unchanged.
The slash no longer names the provider on those five Bots, so a `BOT_MODEL` that relied on it to
reach somewhere other than `BOT_PROVIDER` is now read as part of the model name: `bedrock/…`,
`azure/…` and `openrouter/…` reach the provider `BOT_PROVIDER` names rather than the one written in
front of the slash. `BOT_PROVIDER` is the setting for that, and a model name written bare beside it
behaves as it did. The framework Bot `agent-langgraph` and the Langroid Bot are unchanged, because
neither read the slash that way.

### A Bot's computer no longer runs as root on Kubernetes

The image already builds `pwuser`, chowns `/workspace`, `/profiles` and `/app` to it, and the
all-in-one image drops to it through s6. A computer pod overrides the command to run the browser
process alone, so it never reached s6 and ran as uid 0. It now runs as `pwuser` in both the modes
this chart runs a computer in, `shared` and `sandbox`, with `HOME` and `BUN_INSTALL` set the way s6
sets them. `BUN_INSTALL` moves because its default is root-owned, and `bun add` in a Bot's shell
would otherwise stop working the moment the pod stopped being root.

**Kubernetes only.** The Compose and supervisor paths run `agent-computer/Dockerfile`, which builds
no such user and is still uid 0. That is the rest of the residual #261 named and is not this change.

**What it buys, and what it does not.** It is not a containment boundary against a Bot's own shell:
the image grants `pwuser` passwordless sudo for apt-get/apt/dpkg, which escalate to root by design,
and gVisor plus a computer per Bot remain the actual boundary. Nor does it change which Pod
Security Standard the pod meets: `runAsNonRoot` is a **restricted** control, not a baseline one,
and restricted also wants `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]` and a
seccomp profile, which are deliberately not set here for the sudo reason above. The pod met
baseline before this and still does not meet restricted after it. What it does buy is the org
policies and admission rules that reject uid 0 outright, that root-owned data stops accumulating
in the volumes, and that a bug yielding a constrained primitive lands as 1001.

**Before upgrading an existing release, two things.** The kubelet applies `fsGroup` only where the
volume plugin says it can: the EBS, PD and Azure Disk CSI drivers do, `hostPath` does not, and
hostPath is what rancher/local-path-provisioner hands out by default, which is the default
StorageClass on k3s. On storage that cannot, the computer now refuses to start and says so, rather
than coming up healthy with a browser profile Chromium silently replaced, which is what it did
before this release. Chown the directory, or set `computers.podSecurityContext: null`. And an
upgrade run with `helm upgrade --reuse-values` does not pick up a new key at all, so it keeps
running as root and says nothing; pass the value or drop the flag.

**In `computers.mode: sandbox`, existing Bots keep their old computer.** The server copies the pod
template into a Sandbox when it creates one and never updates it, so only Bots created after the
upgrade run as 1001. The server does restart, because the template checksum changes, which makes it
look like the change landed everywhere. The only lever today is `reset`, which deletes that Bot's
volumes and its logins.

`fsGroupChangePolicy: OnRootMismatch` is set deliberately. Unset means `Always`, which walks every
file on every mount; a real Chromium profile is tens of thousands of small ones, and in `sandbox`
mode that pass would run again on every resume from idle.

### Which email domains may sign in, decided by the deployment rather than the provider

Nothing in OpenBot filtered who could sign in. `INITIAL_ADMIN_EMAILS` decides who is an
administrator once they are in, which is a different question. The providers do not answer it
either: `MICROSOFT_OAUTH_TENANT_ID` defaults to `common`, which is any Microsoft account including
personal ones, and Okta has no equivalent setting. So a deployment reachable from the internet
admitted anybody who could complete the flow, as a non-administrator with access to its Bots.

`SIGNIN_ALLOWED_EMAIL_DOMAINS`, or `config.allowedEmailDomains` on the chart, names the domains
admitted. It is checked against the address the provider returns, in the same two hooks the removal
deny list uses, so it covers a first sign-in and an account that already exists. A refusal writes a
`session.refused` audit row naming the reason. Empty means no opinion, so nothing changes for a
deployment that does not set it.

Matching is exact with no wildcards, for the reason `AGENT_ENDPOINT_ALLOWED_HOSTS` gives:
`example.com` admits neither `sub.example.com` nor `evil-example.com`. Both sides go through the
same IDNA normalisation, so a list may be written `@Example.COM.` or in punycode and still mean
what it says.

**It is a filter, not a boundary, and the deployment is told so.** OpenBot does not require a
verified address, and Entra's `email` claim comes from a directory attribute that the signing-in
tenant's own administrator writes. Two consequences, both now enforced at start-up rather than
documented and hoped for:

- Naming domains while `MICROSOFT_OAUTH_TENANT_ID` names no directory is **refused**. That is
  `common`, and equally `organizations`, which Microsoft describes as admitting any work or school
  account in any directory, and `consumers`. Anybody can create a tenant and write your domain into
  their own user, so the list would refuse the honest and admit the rest while reading as a
  control. Set your directory GUID.
- A list that names nothing, which `SIGNIN_ALLOWED_EMAIL_DOMAINS=@` and a stray `.` both produce, is
  **refused**. It is a non-empty list no address can match, and left to run it turns every visitor
  away with nothing said at boot.

A deployment that names no domains and leaves the tenant multi-tenant warns instead of refusing,
because genuinely multi-tenant is a real deployment.

### No sign-in cannot be combined with a public address

`OPENBOT_SINGLE_USER=true` admits every request as one administrator. The flag is how somebody says
they meant that, and it still is. What was missing is the second question: one administrator and no
sign-in is a thing you run where only you can reach it, and nothing checked the address.

It is now refused alongside an `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or `TRUSTED_ORIGINS` entry
that the public internet routes to, and the refusal names the address it objected to. This is the
rule the chart already applies twice, in `validation.yaml`, moved to where a deployment that never
goes near Helm is asked it too: `.env.example` ships the flag on so that a clone runs, and README's
"Deploy it" hands that same `.env` to `docker run`, where the only thing separating a laptop from a
server is an address.

**Public, not "not loopback", and the difference is most of the deployments this flag has.** A home
server at `192.168.1.10`, a Tailnet address, a VPN address, `openbot.local`, a bare hostname with
no dot in it: none of those is loopback and none of them is a stranger's to reach. Refusing them
would refuse the feature's own audience, and the only way out would be to turn off the flag that
describes what the operator is doing. Those run, and warn once at boot that anybody on that network
is the administrator. Loopback is silent. A value that cannot be parsed as a URL counts as public,
because a value nobody could read is not one anybody checked.

Nothing on loopback changes, so the local workflow the flag exists for is untouched, and neither is
the chart's `config.singleUser` trial mode, which sets no public address. A deployment naming an
external authority through `OPENBOT_ORGANIZATION_AUTH_URL` is unaffected too: the authority wins
before this is consulted. Explicitly NOT gated on `NODE_ENV`: the image and the chart both set it
to `production` for every deployment including that trial, so it says nothing about who can reach
a deployment.

`docs/architecture.md`, `docs/deployment.md` and `docs/configuration.md` all described the old rule
and now describe this one.

### The EKS cluster recipe puts the node's IAM role out of a Bot's reach

A Bot has a shell, and a shell reaches whatever its pod reaches, including the instance metadata
service at 169.254.169.254 that hands out the node's IAM role. The NetworkPolicy excepts that
address, but it is off by default and does nothing on EKS until the VPC CNI is told to enforce it,
so the cluster config in the chart README now sets `disableIMDSv1` and `disablePodIMDS` on the node
group, which closes it at the node whatever the CNI is doing.

`disablePodIMDS` is the line that does the work: it sets the hop limit to 1, and that governs the
IMDSv2 token PUT, so a pod one hop further out than the node cannot get a token. `disableIMDSv1` is
written beside it to say so out loud rather than to change anything, because eksctl defaults it to
true and sets `httpTokens: required` for either flag. Pods on the cluster network are covered; one
running with `hostNetwork: true` is on the node and is not.

**It costs something, and the recipe says so.** The EBS CSI driver reads instance metadata from
IMDS, and its own documentation asks for a hop limit of 2 or greater in a containerized environment.
A hop limit of 1 also rules out `MutableCSINodeAllocatableCount`, which requires IMDS to be the
driver's metadata source. Take these two lines out if you need that.

Nothing in OpenBot wants pod-level IMDS: the chart reaches AWS through IRSA. Documentation only; no
chart template changed, and an existing cluster is unaffected until its node group is recreated.

### A large text file says so on the composer before it is sent

The model reads the first 120,000 characters of an attached text file and the rest is dropped. The
part said so to the model and nothing said so to the person attaching it, so a 1MB CSV was answered
from roughly a tenth of itself with nothing on screen to explain the answer. A staged file over that
ceiling now carries "may be cut" beside its size, with the exact number on hover. Warned, never
refused: the whole file is still uploaded and still stored.

Whether a file is text is decided by what the server read in its bytes, not by what the browser
called it, so a file the browser labelled an image and the server read as text is warned about too.
That is the file the old reading would have missed.

### ADK and Langroid Bots can call the tools OpenBot supplies

Both answered text prompts on an OpenAI key and neither could reliably use the tools the deployment
supplies them, so a Bot on either harness could talk but could not act. ADK now registers the
documented `AGUIToolset`. Langroid now sends each run's tool schemas and its complete message
history, tool results included, so a tool's answer reaches the model that asked for it. Each run
keeps its own tool and history state.

### Built-in Bots carry a model provider's sign-in failure through as itself

A built-in or LangGraph Bot whose model credential had expired ended the run as a generic failure,
which reads as the Bot being broken. The run now ends with `OPENBOT_MODEL_AUTH_REQUIRED` and says to
sign in to the model provider again.

The built-in Bot's tool loop also moved to the server, which owns the grants that decide what a tool
may do. The harness is given model input alone, and a tool result is resolved against the call that
produced it, so a Bot can carry a multi-step task across several tool calls rather than losing the
thread after the first.

### A deployment can name an organization authority that decides who it admits

`OPENBOT_ORGANIZATION_AUTH_URL` points at an OpenBot deployment configured with Google, Microsoft or
Okta, which verifies who somebody is and what roles they currently hold. It is separate from any
Intelligence connection, and the authority keeps its own secrets.

Naming one settles the sign-in question by itself: it wins over `OPENBOT_SINGLE_USER`, so a
deployment carrying a leftover single-user flag admits verified people rather than admitting
everybody as one administrator.

### A coworker can be a file of its own

The example package declared every coworker in one `agents.yaml`, so adding one meant editing a file
somebody else was editing too, and handing somebody a coworker meant handing them a fragment to
paste into the middle of theirs. A package may now also keep a coworker per file in an `agents/`
directory beside `agents.yaml`, and both are read. A package that keeps everything in `agents.yaml`
loads exactly as before. A file holds the coworker on its own or a list under `agents:`, only
`.yaml` and `.yml` are read, and files are read in filename order. Two declarations of the same id
stop the server and both files are named, rather than one quietly winning on the order a directory
was listed in. The directory is in the package checksum, so a coworker added or edited there is a
package change a running deployment notices.

### Ten more example coworkers, each doing one job

The example package shipped three coworkers, which is enough to prove the format and not enough to
give anybody ideas, and writing a `role_description` cold is the part that decides whether a
coworker answers usefully or vaguely. Ten more ship in `examples/fintech/agents/`, one file each:
reading an expense claim against the policy as written, turning a meeting note into the follow-ups
actually in it, drafting release notes from what shipped, triaging a support ticket, answering a new
starter from the handbook, writing a brief that names what it could not find, writing up an
interview with question, answer and observation kept apart, handing an on-call shift over from the
record, assembling what is known before a renewal decision, and grouping customer feedback into
themes it can cite. Each says what the job is, what the coworker must not do, and what to say when
it cannot find something. They grant nothing: a coworker names skills, a skill names tools, and what
it may call is what an administrator has granted. Delete the ones you do not want.

### Built-in and Mastra Bots can run on Anthropic API keys

The example built-in Bots and the Mastra Bot now use the selected model provider instead of
assuming OpenAI. A deployment with `BOT_PROVIDER=anthropic`, `BOT_MODEL=claude-sonnet-4-5` and an
Anthropic key routes built-in model calls, tool selection and Mastra runs through Anthropic's native
API. Source startup no longer waits for the unused OpenAI-only sample when Anthropic is selected.

### The Agno Bot answers on an OpenAI key

Picked with an OpenAI key, the Agno Bot failed every run before reaching OpenAI. Agno sends a
temperature and a `top_p` with each request, and LiteLLM refuses both for `gpt-5.5`, the model
Compose passes when the setup screen names none, so the run ended in `UnsupportedParamsError`. A
parameter the model does not take is now dropped instead, the way the LlamaIndex Bot already does
it. The Anthropic key and an OpenAI-compatible endpoint behave as before.

### The Pydantic AI Bot starts on an Ollama model named with its tag

Ollama names every model with a tag after a colon, as in `llama3.1:8b`, and that is the name the
setup screen passes on for an OpenAI-compatible endpoint. The Pydantic AI Bot took any colon in the
model's name to mean the name already carried a provider, so Pydantic AI read `llama3.1` as one,
refused it as unknown, and the Bot never started. A model's name now carries a provider only when it
begins with the chosen provider's own, as in `anthropic:claude-sonnet-4-5`.

### The Langroid Bot starts on an Anthropic key

Picked with an Anthropic key, the Langroid Bot exited on startup asking for an OpenAI key. It names
a model from any provider but OpenAI through litellm, which its image did not install, and Langroid
builds an OpenAI client for such a model all the same, from the `OPENAI_API_KEY` Compose writes
empty when the choice was not OpenAI. The image now installs Langroid's litellm extra and an empty
OpenAI key is treated as none, so the Bot starts and answers with the Anthropic model chosen.

### The AG2 Bot answers on an Anthropic key

The AG2 Bot built an OpenAI client whatever the setup screen chose, and read `BOT_MODEL` but never
`BOT_PROVIDER`. Picked with an Anthropic key, every run failed asking for an OpenAI key, because
Compose writes that one empty when the choice was Anthropic. It now reaches Anthropic through AG2's
own Anthropic client when that is the provider chosen, and OpenAI or an OpenAI-compatible endpoint
as before otherwise.

### The Microsoft Agent Framework Bot starts on an Anthropic key

The Microsoft Agent Framework Bot built an OpenAI client whatever the setup screen chose, and read
`BOT_MODEL` but never `BOT_PROVIDER`. Picked with an Anthropic key, it exited on startup asking for
an OpenAI key, because Compose writes that one empty when the choice was Anthropic. It now reaches
Anthropic through Agent Framework's own Anthropic client when that is the provider chosen, and
OpenAI or an OpenAI-compatible endpoint as before otherwise.

## 0.0.13

### Fresh desktop setup installs its runtime before sign-in

Desktop setup installs local software before asking for an AI connection. Fresh Mac Podman
installations no longer duplicate stack port bindings. The shared installer downloads verified
prebuilt Bun binaries without developer tools; Linux setup also installs its native Podman runtime
and certificate bundle. (#604)

### Ctrl+B shows and hides the sidebar on a layout that does not write Latin letters

The sidebar toggle's tooltip names Ctrl+B, or ⌘B on a Mac, and the shortcut was recognised by the
character the key writes. On a Russian or Greek layout the B key writes "и" or "β", so the shortcut
did nothing there. It is now read the way the app's own shortcuts read it since Shift+N was fixed
for the same layouts: from the physical key when the layout writes a character outside ASCII there.

### Scrolling a Bot's browser no longer scrolls or zooms the page around it

While somebody drives a Bot's browser, a turn of the mouse wheel over its screen is sent to it, and
the screen was meant to keep the wheel from also acting on the app. React attaches its wheel handler
as a passive listener, which a browser does not allow to do that, so the wheel scrolled the frame
holding the Bot's screen along with the Bot's page, and Ctrl with the wheel zoomed the app. The
wheel is now handled by a listener that can hold it, so it reaches only the Bot's browser.

### Typing into a Bot's browser no longer triggers the app's own shortcuts

While somebody drives a Bot's browser, every keystroke is sent to it. The app's shortcuts listen for
keystrokes too, and they heard each one first, so typing a capital N into the Bot's browser, as in
"New York", started a new chat and took the person away from the Bot mid-word, and Ctrl+B there
also showed or hid the sidebar. A keystroke sent to the Bot's browser now reaches only the Bot's
browser. Escape still closes the view, and the paste shortcut still pastes.

### The Python LangGraph Bot on Anthropic answers after a skill was picked

A skill somebody picks reaches the Bot as a system message just ahead of their message, and it
stays in the conversation. Anthropic takes one system prompt, and its LangChain integration refuses
a system message that comes after a turn of the conversation, so with `BOT_PROVIDER=anthropic`
every run in that conversation failed from then on, before the model was asked. On Anthropic the
Python LangGraph Bot now puts every system message ahead of the conversation, in the order given,
where the integration joins them into its one prompt. Runs on OpenAI and Gemini are unchanged.

### The LangGraph Bot answers on Anthropic and Gemini

With `BOT_PROVIDER=anthropic` or `BOT_PROVIDER=google`, the LangGraph Bot answered nothing: every run
ended in an error before the model was asked. Those two providers take one system prompt, at the top,
and the Bot handed its model several: its own guidance, the context the app sends, and the
coworker's standing role, which the server puts at the head of every run. The provider's LangChain
integration refused the second one. On those two providers the Bot now folds them into one system
prompt, in the same order, and a skill picked for a message joins it. Runs on OpenAI are unchanged.

### The proof-of-concept Bot reads a model name set with whitespace around it

A `BOT_MODEL` carrying a leading space reached this Bot as it was written. Its startup check refuses
`gpt-5.6-*`, which rejects function tools on the API this Bot speaks, and that check matches from the
start of the name, so a padded one walked past it: the Bot started, reported healthy, and answered
nothing at all on the first turn that used a tool. An empty value was read the same way and asked the
provider for a model with no name. Both now fall back to the default, and the name is used trimmed.
`.env` was never a route to this — Compose, Bun and the desktop shell each strip the value first — so
it reached only deployments that set the variable directly, such as a Kubernetes manifest or
`docker run -e`.

### Pasting into a Bot's browser works on a layout that does not write Latin letters

While somebody drives a Bot's browser, Ctrl+V or Cmd+V is left to the local page so its paste event
can send the clipboard text across. The shortcut was recognised by the character the key writes,
and on a Russian or Greek layout the V key writes "м" or "ω", so the keystroke went to the Bot's
browser instead and nothing was pasted. The V is now read the way the app's own shortcuts read it
since Shift+N was fixed for the same layouts: from the physical key when the layout writes a
character outside ASCII there.

### Reading a large file from Google Drive no longer downloads all of it

`read_file_content` shows a Bot at most the first 20,000 characters of a file, but it downloaded the
whole file and held it in memory before cutting it. A 200 MB text file raised the server's memory by
more than 600 MB for one call, on the process that serves everybody else. The connector now stops
reading once it has more than it can show and cancels the rest of the download. What the Bot is shown
is unchanged, except that the note on a cut file no longer gives the file's full length, which is no
longer known.

### A Bot reads the text an MCP server returns as an embedded resource

A tool result can carry an embedded resource, and a text resource holds content, such as a file the
server read. The MCP connector passed text parts to the Bot and named every other part, so a text
resource reached the model as `[resource]` and its contents were dropped. GitHub's MCP server answers
`get_file_contents` for a text file this way: the Bot was told the download worked and never saw the
file. The text of an embedded resource is now passed on like a text part. A resource that carries
bytes is still named.

### The Google Drive connector reaches files in shared drives

Drive leaves shared drive items out of any `files.get` or `files.list` request that does not say it
supports shared drives, and none of the connector's requests said so. A document the person could
open in a shared drive was "File not found" to `get_file_metadata` and `read_file_content`, and never
appeared in `search_files` or `list_recent_files`. Those requests now say they support shared drives,
and the listings ask for shared drive items. Listings keep Drive's default `user` scope rather than
searching every shared drive.

### Google Drive search and recent files leave out what is in the trash

Drive's `files.list` returns trashed files unless the query excludes them, and neither `search_files`
nor `list_recent_files` did. A document somebody had thrown away came back to the Bot as a match or
as a recently changed file, with nothing in its line to say it was in the trash, so the Bot could
answer from it as though it were current. Both now ask Drive to leave the trash out. Reading a file by its
id is unchanged.

### New conversations are still named once some older ones could not be

Every pass of the job that names conversations offered at most twenty of those still without a name.
A conversation it had tried and could not name, for example because the model answered with no text
or the conversation opened with only an attachment, keeps no name, so it stayed among those twenty
and took a place on every pass, although offering it again did nothing. Once enough of them had built
up, a new conversation could miss out on every pass and keep showing its plain name in the sidebar.
A pass now skips any conversation that the job already holds work for, so new ones get a place. One
it could not name is still tried again later, as before.

### An offboarding one app refuses still records the apps that answered

Removing somebody withdraws each brokered account they connected. When the broker refused one of
those apps, the whole act stopped before anything was recorded: apps already withdrawn at Composio
kept their `composio_connections` row and left nothing on the trail saying the account had ended,
and the retry that #574 made the recovery then asked again, was told there was nothing to withdraw,
and wrote `vendorRevocationRequested: false` about a withdrawal this deployment had asked for and
got. Each app is now asked, recorded with the answer it actually gave and its row removed, and only
the apps that were refused are left standing for the retry. The act still fails and still answers
500, so a refusal is as loud as it was.

### Paging the audit trail no longer skips rows written in the same millisecond

`GET /api/admin/audit-events` hands out a `nextCursor` built from the last row's timestamp, which the
server read at millisecond precision while PostgreSQL keeps microseconds. The cursor therefore named a
moment just before that row, and the rows the next page should have started with, written earlier in
the same millisecond, were on no page at all. Anything that walked the trail page by page could miss
them without any sign of it. The cursor now carries the row's full timestamp. A cursor issued before
this change still reads.

### The New chat shortcut works on a Russian or Greek keyboard layout

Settings lists New chat as Shift+N, and the app matched the character the keystroke wrote. A layout
that writes another script has no key that writes an N: Shift and the N key write "Т" on Russian and
"Ν" on Greek, so the shortcut never fired there. When the character is not ASCII, the app now reads
the physical key instead. A layout that writes Latin letters, such as Dvorak, still goes by the letter.

### Enter that confirms a typed character no longer saves a name, a rule or a wizard step

Japanese, Chinese and Korean are typed through an input method, where Enter confirms the character
being built. In three fields that Enter also acted: editing a coworker's name or title saved it with
the character still unconfirmed, the new-coworker wizard moved on to its next step, and a boundary
rule was saved into the policy in force. Those fields now wait for the character, the way the chat
composer already does, and an ordinary Enter works as before.

### A built-in coworker can be edited where the deployment's own Bot is on localhost

A coworker created as Built in is stored pointing at the managed Bot's address. Editing its name,
title, role or visibility sent that address back as though somebody had typed it, and the server
checks an endpoint it is sent the way it checks a person's. `scripts/start.sh` puts the managed Bot on
`http://localhost:4201/ag-ui`, which that check refuses unless private hosts are opened, so every edit
failed with "That address is inside this deployment's own network, so an agent may not live there."
The dialog now leaves a built-in coworker's address where it is stored. A coworker somebody hosts
still sends its own endpoint, as before.

### A long page's text is cut between characters, not through one

A navigation hands the Bot the first 6000 UTF-16 code units of the page's readable text. When that
limit fell between the two halves of an emoji, the Bot was handed text ending on half a character,
which reads as U+FFFD: a broken character that is not on the page. It now stops one code unit short
in that case, which is what a control's name and value in a page snapshot already did.

### Tool selection reads a skill choice the model wrapped in a code fence

Before a run, the deployment's model picks which of a Bot's skills the message needs, so a Bot holding
many tools is offered only the relevant ones. The request asks for bare JSON, but an endpoint that
ignores `response_format`, as Anthropic's OpenAI-compatible one does, lets the model fence the object
or lead with a sentence. Every such answer read as no answer, so the Bot was offered every tool it
holds and the audit row said `unavailable`. The object is now read out of the answer, the way the
router already reads its own. A bare JSON answer is read as before.

### A long message reaches the coworker it is for, and is recorded

A message over 10,000 characters, such as a pasted email thread or log, was refused by the router
since it started capping the text it reads. The home composer carries on past a routing that fails,
so the message went to the default coworker rather than the one it is for, and a coworker chosen with
`@` or from the To: field started with no `channel.routed` row. The app now asks the router about the
message's opening, and the whole message still goes to the coworker. Shorter messages route as
before.

### Removing somebody is recorded even when retiring what they owned fails

Removing somebody denies their access and ends their sessions, then retires the credentials and
brokered connections they had granted this deployment. When that second half failed — a vault or
Composio not answering — the removal was already committed but nothing was written to the audit trail,
and removing them a second time reported success without retrying it, leaving those connections
standing. The removal is now recorded as soon as it takes effect, and removing somebody already
removed finishes the retirement that failed.

### Removing a connector takes its grants with it

A grant naming a connector's tool outlived the connector. Removing an app revoked every credential
and every brokered account and deleted the app itself, and left the grant rows behind, naming a
server that no longer existed. Nothing showed them: the page that reports grants a connector no
longer advertises reads them off the connector's own row, and there was none. Adding the same app
back — which mints the same id, and so the same tool names — put every action it had back on every
Bot that used to hold it, with nobody granting anything and no row in the trail saying a grant had
been made. An app's grants are now removed in the same step as the app, the removal records which
grants it released and from which Bots, and a migration drops the grants earlier removals left
behind. Grants for other connectors, and skill grants, are untouched.

### A vendor that broke no longer reads as a refusal to a Bot running its own loop

When a Bot that calls tools back from its own process, such as the LangGraph Bots, called a tool
whose vendor failed, or hit a fault in this deployment, the answer began "Refused." like a boundary
holding. The conversation drew it as blocked and the model read it as not allowed, while the audit
trail recorded a failed call. Only a refusal is marked now. A vendor that broke reads "That tool could
not be called: …", the way it already did for a Bot running here, and a refusal reads as before.

### A Bot running its own loop is told a vendor's error is the vendor's

A vendor that says no by answering with an error, the way an MCP server refuses a call, reached a Bot
running here as "The vendor reported an error: …", and reached a Bot calling tools back from its own
process, such as the LangGraph Bots, as the bare sentence. Those Bots pass the answer on as they
receive it, so their model read something like Google's "The caller does not have permission" as an
ordinary result, and could tell the person they had no access rather than that the vendor had refused.
Both kinds of Bot are now told the same thing. A result that is not an error, and this deployment's
own refusals, read as before.

### A long Composio result or failure is cut between characters, not through an emoji

A Composio action's answer over 20,000 characters, and a failure sentence as long, were cut by UTF-16
code unit. When the cut landed inside an emoji or any other character outside the Basic Multilingual
Plane, the text handed to the model ended on half of it: a lone surrogate that JSON carries as a bare
`\ud83d` and UTF-8 turns into a replacement character. The cut now stops one unit short in that case,
the way the MCP and built-in transports' cuts already do. Anything that fits is untouched, and the
note saying the answer was cut reads as before.

## 0.0.12

### A deployment can broker its Bots into a few hundred apps through Composio

Composio holds a person's connections to a few hundred SaaS apps behind one account. A deployment
that sets `COMPOSIO_API_KEY` now has that broker: each person connects their own accounts, a Bot is
granted an app's tools the way it is granted any other, and every call is decided and recorded
through the gateway like the rest. Unset, there is nothing to connect, nothing to grant and no
Composio tool for a Bot to call, and the Plugins page says so under **More apps** rather than
pretending otherwise. See [docs/plugins/composio.md](docs/plugins/composio.md).

### A skill's grants are removed when it is uninstalled

Uninstalling a skill deleted the skill but left its tool grants, which are keyed by its slug. A new
skill created under the same slug then inherited them, and was offered on the Bots the old skill had
been granted to with no grant ever made for it. Uninstalling now removes a skill's grants along with
it, in one transaction, and an upgrade drops any grants already left orphaned this way.

### Malformed requests are refused instead of coerced, and a fail-open is closed

A pass across the write and query surface answers a malformed request with a 400 that names the bad
field, rather than coercing it, failing at the store, or letting it through: the plugin server and
tool-call endpoints, the admin people search and credential input, skill tools and grant ids, blank
route ids on routines, host-access, agents and channels, the routing text length, routine dispatch
and page-frame params, and the runtime env, tokens and model content the computer and supervisor
read. The app reads these responses more defensively too, degrading rather than throwing on a shape
it did not expect.

One of these closed a hole rather than tightening an edge: a skill installed with a non-string entry
in its `tools` list had that entry silently dropped, so the skill declared nothing and installed as a
success. It is refused now.

### Naming a conversation asks the endpoint OPENAI_BASE_URL names, not OpenAI

The job that names a conversation sent its request to api.openai.com whatever `OPENAI_BASE_URL` said,
while the Bots, the router and tool selection all used the configured endpoint. A deployment behind a
gateway, a proxy or a local model therefore sent its model key, and the opening of every
conversation, to OpenAI; OpenAI refused the key, so no conversation was ever named. The request now
goes to the same endpoint as every other model call. A deployment that never set `OPENAI_BASE_URL`
behaves as before.

### A Bot's question to a person survives a route that fails

Who "a person" is, is a seam a deployment fills in with its own on-call rota or duty desk. If that
route failed by throwing rather than by returning a refusal — a timeout, a 502, a name that does not
resolve — the error came straight back out of the tool, so the Bot's run ended with nothing said to
the person waiting, and no audit row recorded that the question had reached nobody. The Bot is now
told, in a sentence it can say, that nobody could be asked and that it must not claim otherwise, and
an `agent.escalation_failed` row goes down carrying what the route actually threw. Deployments using
the shipped in-conversation route are unaffected: it cannot fail.

### Resetting a Bot's computer while the Bot is acting signs it out

On a deployment with one shared computer, which is what the published image and the Helm chart run by
default, a reset takes about two seconds to close the browser before it deletes the profile. A Bot
action that arrived in that window started a new browser from the profile about to be deleted, so the
Bot stayed signed in to everything until that browser next closed, while the reset reported success
and the audit trail recorded the saved state as deleted. A Bot's browser is no longer reopened while
it is being closed: the action waits for the reset to finish and starts signed out. Computers the
supervisor makes per Bot were not affected.

### A long control name or value in a page snapshot is cut between characters

The computer's page snapshot keeps the first 200 UTF-16 code units of each control's accessible
name and value. When that limit fell between the two halves of an emoji, the Bot was handed text
ending on half a character, which reads as U+FFFD: a broken character that is not on the page, often
at the end of a message the Bot had just typed into a text box. The cut now stops one code unit
short in that case, the same rule tool results and relayed answers already follow.

### A Bot's shell can no longer read the deployment's keys from a neighbouring process

In the all-in-one image the API and the browser ran under one account, and a Bot's shell — a child
of the browser — could read a same-account process's environment through `/proc`, whatever its own
environment had been scrubbed to. One allowed `computer_run_command` returned `KEY_ENCRYPTION_KEY`,
the session-signing secret and the database password, none of it on the audit trail. The API and its
migrations now run as their own account, so the kernel refuses that read; the browser is handed only
the variables it needs, so its own environment carries none of those keys; and the files under
`/run/s6/container_environment` are closed to the shell. A deployment that runs each Bot in its own
sandboxed computer, as the documentation asks for, was never exposed to this.

## 0.0.11

### The LlamaIndex Bot answers with the model the setup screen chose

The LlamaIndex Bot built an OpenAI client from `BOT_MODEL` and ignored `BOT_PROVIDER`, so it only
worked with an OpenAI model name sent to OpenAI. Picked with an Anthropic key, every run failed with
`Unknown model 'claude-sonnet-4-5'`; picked with an OpenAI-compatible endpoint, every run failed
with `Unknown model` for that endpoint's model, and an OpenAI model name went to api.openai.com
instead of the address given, because the client read `OPENAI_API_BASE` and not the
`OPENAI_BASE_URL` Compose passes. It now reaches the model through LiteLLM as `provider/model`, the
way the Agno Bot does, so all three choices answer. A model LiteLLM does not know is treated as able
to call tools, which the AG-UI workflow requires, and parameters a model does not accept, such as
the temperature LlamaIndex sends to a reasoning model, are dropped rather than refused.

### The Audit page says "not enforced" only under a dry-run refusal that went ahead

On a deployment in `dry-run`, the Audit page printed "dry-run: recorded, not enforced" under every
allowed action, because an allowed action is always carried out, and under a tool call content
inspection had refused, because that row copied `carriedOut: true` from the policy step before the
call was stopped. The line now appears only on a row the policy refused and dry-run let through,
which is the one case it describes. A tool call refused for carrying credential material is now
recorded with `carriedOut: false` in every mode. Rows already written keep their old value, and the
page reads them correctly either way.

### The Routines page says when nothing is there to run them

A routine needs a second process to fire it, and a deployment that never started one looked exactly
like a deployment that had: the routine was stored, its schedule was computed, and the page showed it
waiting with a next run time, right up until nobody's standup notes arrived. Every sweep now records
that it happened, and the page reads that record. Somebody with standing routines and nothing
sweeping is told so — that no worker has ever checked in, or when the last one did — instead of
being shown a page that looks correct. The window is the fifteen minutes a routine's own schedule
already has as its floor, so a gap longer than that is one no routine could have wanted.

### A long tool result or relayed answer is cut between characters, not through an emoji

A tool result over 20,000 characters, and a Bot's answer over 12,000 relayed back through a handoff,
were cut by UTF-16 code unit. When the cut landed inside an emoji or any other character outside the
Basic Multilingual Plane, the text handed to the model ended on half of it: a lone surrogate that
JSON carries as a bare `\ud83d` and UTF-8 turns into a replacement character. The cut now stops one
unit short in that case, the way an attached text file's already did. Anything that fits is
untouched, and the note saying the result was cut reads as before.

### A boundary rule can ask what started a run, not only whose authority it carries

A routine's turn goes through exactly the path a person's chat turn does, as the routine's owner:
their grants, their connections, their thread. That is the right design, and it is also why
`actor.id` cannot tell a scheduled run at three in the morning from the same person typing. The
trail already drew that distinction — `AuditInitiator` is signed into the run assertion and written
onto the row, so an investigator can see a routine caused something. A rule could not ask the same
question.

The policy context now carries `initiator`, with the kind and id the trail already records, so this
is writable:

```
deny: initiator.kind == "routine" && intent == "run_command"
```

A deployment happy for a Bot to run a shell while somebody watches, and not happy for it to do so
unattended, can now say so. The id is there too, so a single routine can be named rather than
scheduled runs as a class. `handoff` is its own kind, for a Bot that hands work to another Bot.

**Nothing is refused that was not refused before.** The field is neutral — `{kind: "person", id: ""}`
— everywhere a person is driving, which is every path that does not carry an initiator today,
including every action on a Bot's computer: those are driven by the browser, so they really are
somebody's session. It is required rather than optional for the reason #115 exists: cel-js throws on
an unbound identifier and a throw fails closed, so a field that were sometimes absent would turn one
rule about routines into a deployment that refused every ordinary click.

Replaying a rule against history reads the initiator off the row when it is there and treats a row
that predates the field, or carries a shape this version does not recognise, as a person.

### The Python LangGraph Bot tells its model why the deployment refused a tool call

When the deployment would not run a tool call from the Python LangGraph Bot — a token it no longer
accepts, one issued to another Bot, or a malformed call — it answered with the status and a reason
under `error`, and the Bot told its model only "Refused. Tool callback returned HTTP 403." The model
could say a call was refused but not why, and could not correct a call the deployment had named as
malformed. The reason now follows the status, the way the TypeScript LangGraph Bot already passes it
on. A refusal with no readable reason reads exactly as before.

### A tool argument that starts with "Basic" or "Bearer" is no longer refused as a credential

Content inspection read any MCP tool argument whose first word was "basic" or "bearer", in any case,
as an authorization header. A Bot searching Drive for "Basic onboarding checklist", or posting
"Bearer of bad news" to a channel, was refused because its arguments "contain credential material".
Those words are now refused only when what follows them is shaped like a credential: base64 that
decodes to `user:password` after `Basic`, and a token of at least 16 characters with a digit,
punctuation or mixed case after `Bearer`. A shorter bearer token, or a Basic value that does not
decode to `user:password`, is no longer caught by this pattern; the same value under an
`authorization` field is still refused by name.

## 0.0.10

### The LangGraph Bot says a refused tool call was refused, not that it found nothing

When the deployment would not run a tool call from the LangGraph Bot — a token it no longer accepts,
or one issued to another Bot — it answered 401 or 403 with a reason and no result, and the Bot told
its model "The tool returned nothing." The model then told the person nothing was found. The Bot now
tells its model the call was refused, with the status and the deployment's reason, the way the
Python LangGraph Bot already does, and the transcript draws it as a refusal. A tool that answered is
passed on exactly as before.

### Revoking a grant with a blank ref or Bot is refused instead of reported as done

`DELETE /api/plugins/grants` checked its query params with truthiness, and a query param is
always a string: `?ref=%20%20` is truthy, so it skipped the 400, deleted zero rows by exact
match, still wrote a `plugin_revoked` audit row naming whitespace, and answered `ok:true`. The
`POST` twin already required trimmed non-empty strings. `DELETE` requires the same now and acts
on the trimmed values, so a blank ref or Bot is a 400 with the same message, no delete, and no
audit row.

### The Bot in the box and the LangGraph Bot read a message that has a file attached

A message with a file attached reached both Bots as `[object Object],[object Object]`, in place of
what the person typed and the file both: they read a message as a string, and one carrying a file is
a list of parts. Each part now reaches the model as what it is — the words, the text of an attached
file, an attached image — and a part neither can read is named rather than dropped.

### A fractional or out-of-range computer setting takes the fallback instead of breaking the boot

`numberFromEnv` accepted anything `Number` called finite and positive, so `PORT=80.5` bound
nothing usable, `PORT=99999` misbound at boot, a fractional timeout fired before any action could
finish, and `COMPUTER_MAX_BROWSERS=2.5` reached eviction math as a fraction — each reading as a
broken computer rather than a mistaken variable. Every reader is a port, a timeout, or a count,
so only whole numbers on sight are values now and anything else takes the documented fallback;
the port additionally keeps its 1–65535 range, the way the supervisor's own port parser already
does. Zero semantics are unchanged: `COMPUTER_BROWSER_IDLE_MS=0` still keeps browsers resident.

### A malformed page size is refused instead of silently coerced

`GET /channels` and `GET /api/admin/people` read `?limit=` with `Number.parseInt`, which
coerces: `?limit=12abc` arrived as 12, `?limit=3.9` as 3, and each answered 200 with a silently
wrong page. Both now share one strict parser with the audit list's rule: absent or blank leaves
the store default alone, a run of digits is clamped into range against the same ceiling the store
enforces, and anything else is a 400 naming the parameter, before the database is reached.

### A skill written with a non-string slug or summary is refused instead of failing the insert

`POST /api/plugins/skills` checked presence with truthiness and then ran the slug regex, which
coerces: `{"slug":123}` tested the string `"123"` and passed validation, and `{"summary":{}}` had
no check at all. Both reached the store, where the insert threw an uncaught error — a 500 for a
caller error. A slug, a title and instructions must be non-empty strings now, the slug pattern is
tested only after that, and a summary must be absent or a string; anything else is a 400 naming
the field, before any refusal check, store write, or audit row.

### More endpoints refuse a malformed request instead of coercing it or failing open

The same treatment reached the rest of the write and query surface: the agent tool-call endpoint's
name and arguments, the policy dry-run and audit-event list limits, a component's publication flag,
the sandboxed-component fields, and a catalogue entry are each checked and answered with a 400 that
names the bad field before the store is touched. The four hand-driven computer gestures — click,
type, key and scroll — validate their own payloads the same way, so a click with no coordinates or a
key with no key is refused rather than sent to the computer as a no-op.

One of these closed a hole rather than tightening an edge. A component's list of decision functions
was filtered to the strings in it, so `{"functions":[123,null,{}]}` became an empty list, the
permission check ran over nothing, and the answer came back `allowed` for functions the caller had in
fact named. The verdict is about the functions named now, or a 400; an absent list still means none.

### Generated interfaces, tables and forms

Generative UI is enabled by default; set `OPENBOT_GENERATIVE_UI=false` or `0` to disable it.
Bots can render A2UI interfaces, compare records in sortable tables, and collect related answers in
a form that waits for submission. LangGraph receives the component schemas needed to draw these
interfaces correctly.

The playground rejects invalid JSON before saving or publishing, confirms successful saves, and
shows published custom components in the administrator's gallery.

### A Bot's computer is rebuilt when it holds a token the deployment has stopped using

A computer checks every caller against the `COMPUTER_TOKEN` it was created with, and holds that one
for the life of the container. The shell mints the generated secrets once per deployment and does
not rotate them, precisely because a computer outlives a restart, so ordinarily there is nothing
here to go wrong. Setting a machine up again from nothing is the occasion where the token really
does change: the credential store is emptied, a new one is minted, compose rebuilds everything it
owns with it, and the computers, which the supervisor makes rather than compose, survive holding the
old one.

Everything then refuses, and nothing says why. The gateway allows the action and the trail records it
as carried out, the computer answers 401, and the screen says "Not authorised" while naming no token
and no container. Measured on a first run of v0.0.9 against a computer made by the install before it,
five days earlier: every page the Bot tried to open, and the live screen beside it, failed that way.

The supervisor now replaces a computer whose token is not the one it is handing out, the same way it
already replaces one built from an older image, keeping the profile and workspace volumes so the Bot
comes back with its logins and its files. A deployment that sets no token is left alone, because a
computer with no door on it is a choice the environment made rather than a mismatch to act on.

## 0.0.9

### The People screen keeps a person's last sign-in when their sessions go away

`Last signed in` was `max(sessions.created_at)`, so it disappeared whenever the session rows behind
it did: on sign-out, on expiry, and when an administrator removed somebody. Restoring them did not
bring it back, and the person moved to the bottom of the list as somebody who had never signed in.
The moment of each sign-in is now recorded on the person, so the answer survives all three, and a
removed person's row shows when they were last here instead of leaving it out. Existing deployments
are backfilled from whatever sessions they still hold.

### A message can carry files

Pick them, drag them onto the composer or paste them in: up to eight files on one message, images up
to 8 MiB and text files up to 1 MiB, in the four image formats a model reads (PNG, JPEG, GIF, WebP)
and four text ones (plain text, Markdown, CSV and JSON). A file is uploaded as it is staged rather
than when the message is sent, so the send is immediate and a send that fails keeps what was
attached to it, instead of asking somebody to find eight files again. The bytes live in the
deployment's own database and are served back from the app's own origin, which is also why the type
is decided by reading the file rather than by believing what the browser called it: something that
claims to be text and is not UTF-8 is refused rather than stored and served as accepted text on the
client's word.

What reaches the model is bounded separately from what may be uploaded, because the two limits pay
for different things. An image goes whole. A text file is read up to 120,000 characters, roughly
30,000 tokens, which is one attachment's share of a window that also holds the conversation and up
to seven other files, and the part sent says where it was cut so the model is not left answering
about a file it read only part of. A megabyte of text is therefore stored whole and read as its
first eighth or so, and the person who attached it is not yet told that.

### Unsent attachments have to be swept, or somebody who stages 32 can attach nothing again

A file is stored when it is picked, not when it is sent, so every abandoned draft leaves bytes
behind and nothing in the image reclaims them. The Helm chart runs the sweep hourly and deletes
unsent files older than a day. Any other deployment has to run it:
`bun scripts/cull-staged-attachments.ts` from `/app/server`, one pass then exit, with the retention
window as its one optional argument. Unlike the routines sweep beside it, it needs only
`DATABASE_URL`, so an external cron can run it with one variable set.

This is not only about growth. A person may hold 32 unsent files across all their channels, which is
what bounds a client that ignores the eight-per-message cap, and the refusal on the 33rd tells them
anything still unsent is cleared within a day. That sentence is a promise made on the sweep's
behalf: where nothing runs it, the files are never cleared and anybody who reaches 32 can attach
nothing, in any channel, from then on. At 8 MiB a file, 32 staged files per person is the 256 MiB
to size storage against.

### Fresh desktop installs pin the latest published deployment

The desktop app resolves GitHub's latest published release on first setup and downloads that exact
tag's source and image manifest. It records the version after both downloads finish and reuses it
on subsequent starts, so new installs no longer stay tied to the app's old v0.0.8 default.

### The Bot computer refuses a malformed scroll or live input before the browser sees it

A non-finite wheel delta travelled into Playwright and came back as a 502 that read as a broken
computer, and any JSON object on the live-screen socket fell through to `Input.insertText` or
forwarded wrong-typed coordinates to CDP. Scroll deltas must be finite numbers now, and live
input must match its mouse, wheel, key, or text shape; anything else is a 400 naming the field.

### A non-string plugin grant or tool call is refused before it reaches the store

`POST /api/plugins/grants` and `POST /api/plugins/call` checked presence, not shape, so a JSON
number, object, or whitespace string passed and failed inside the store as a 500. Refs and Bot
ids must be non-empty strings now, and anything else is a 400 naming what is required.

### A fractional or infinite snapshot id is refused as malformed, not stale

A `snapshotId` of `1.5` or `Infinity` passed the acting routes and never matched the stored
integer, so the answer was a 409 stale snapshot and the caller retried a request that was
malformed. Non-integer ids are refused with a 400 naming the ref and its snapshot before any
decision or audit row.

### A `DATABASE_URL` with a port of zero is refused at start-up

`postgres://…:0/…` parsed and booted, and every query then failed against a port nothing listens
on. Ports outside 1-65535 are refused with a sentence naming `DATABASE_URL` before a socket is
ever opened.

### Setup installs the container engine, instead of telling somebody to go and get one

Setup ended at "Install Podman Desktop or Docker Desktop first" on any machine that had neither,
which is every machine this app is for: the step existed with nothing behind it, so the whole install
stopped at a download page. It installs one now, and a Compose with it, because Podman ships no
Compose implementation and a machine with a freshly installed Podman still cannot raise the stack.
Both are pinned to the digest of the release they were tested against and refused if it does not
match, because these are files this app then executes. Only what is missing is added: an engine
somebody already has is theirs, and a Compose that already answers is left alone. Windows installs
unattended; macOS and Linux each raise the platform's own authorization prompt, which is not
something to route around. The two plan sign-ins set the engine up as well, since they run in a
container themselves and previously named an obstacle with no way past it. Every engine command names
a resolved path rather than trusting the PATH this process was started with, so an engine installed a
minute ago can be used by the run that installed it.

### Setup ends with a question the Bot has to answer

Every step before the last one proves that something started, which is not the same as proving the
answers work. A refused key, a lapsed plan or a model the account cannot use each give a stack that
comes up clean and a Bot that cannot answer, and handing over at that point means somebody finds out
later, inside the product, with no idea which of their answers caused it. Setup now ends on a
question with one checkable answer and waits for it. A run that produces no text is a failure here
rather than an empty answer, because the framework catches its own 401 and logs it, leaving the whole
of a refusal in the container's log and nowhere else. The sentence on screen is OpenBot's own and
names the choice to change, with the harness's log behind a disclosure for the developer half.

### A subscription picks the Bot that can spend it

A plan is not a key, and only one Bot speaks each vendor's subscription. Signing in to a Claude plan
and keeping the default Bot gave a stack that came up clean and a Bot whose log read "Missing
credentials. Please pass an `api_key`", after two screens the person had answered correctly and with
no way to know which answer to change. A plan now re-points the Bot, and the model screen says which
Bot that will be while there is still a screen to say it on. A signed-in ChatGPT plan gets the Codex
model, because a plan token is a bearer for one address that langchain-openai pins on purpose and
cannot be reached by pointing `OPENAI_BASE_URL` at it. The vendor's own token store is kept beside
the `.env` as an owner-only file and mounted into the harness, so the renewals the provider makes
outlast the container: the access token on its own expires within the hour and nothing can renew it,
which would give a Bot that works in the morning and fails after lunch. The window also has an Edit
menu now, so the shortcut works on the screen whose own instruction is "paste the code it shows you";
macOS routes the clipboard through the menu bar, and a window without one has no Paste.

### Signing in to CopilotKit from the window works

The sign-in that creates a key for somebody had never been run end to end, and it failed four times
in a row, each time silently or with a message that named nothing. The session is called `cliToken`,
not `token`, so the first exchange failed with "error decoding response body" and no way to tell
which field or which endpoint; a failure carries the response now, masked, because the one that
diagnosed this also carried a live session token. Project ids are numbers, and requiring a string
dropped every project, so the screen told somebody with ten of them that the account had none: an
empty list and an unreadable one are told apart now, because one of them is a lie a person cannot
argue with. The keys endpoint declares `project_id` as a number with no coercion, so the string "7"
came back as a validation error on the last step of the flow. And the project tiles drew as blank
white rectangles, because the tile rule overrode the background to white and not the colour, asking
somebody to choose between six empty boxes. The sign-in address is kept on screen the way the plan
sign-ins keep theirs, for the machine whose browser is not the one in front of the person.

### An endpoint that needs no key can be connected

The compatible row names Ollama and vLLM in its own summary and then refused to continue without an
API key. Neither has one, so the two examples the screen offers by name were the two it would not
accept, and the way out was to invent a key and hope the endpoint ignored it. An address and a model
name are what that row needs. Both bundled Bots refused to start without `OPENAI_API_KEY` as well, so
fixing the screen alone would have given two dead containers complaining about a key that person's
server does not have: a base URL is a model and its key belongs to it, so a key is now required only
when nothing else names the endpoint, and plain OpenAI still refuses without one. Because a
deployment pulls the image the release pinned, and an image published before the Bots learned this
still refuses, a placeholder string is sent to an endpoint that reads no key. Ollama, vLLM, LM Studio
and llama.cpp all ignore the value. It is written in plain sight rather than put in the machine's
credential store, because it is not a credential, and a key somebody actually typed is used
unchanged. The model name reaches the bundled Bot too, which reads `AGENT_BOT_MODEL` and had been
left on a pin chosen for OpenAI's own catalogue.

### A model name no longer outlives the answer that chose it

The compatible row is the only one that names a model, and switching away from it kept the name.
Answering with an OpenAI key after trying a local endpoint left `BOT_MODEL=local-model`, so the Bot
asked OpenAI for a model only that person's own server has, and the last screen said "That account
cannot use the model that was chosen" about a model this run never chose. The name is removed rather
than emptied, so the compose default applies, and taken out of the file as well, because the writer
keeps the lines it did not write and that is what let it survive.

### Credentials go to the machine's own credential store, not the `.env`

The `.env` is a settings file, and a settings file is something somebody opens, reads out to support
or pastes into a chat. A model key, a plan token and the tokens these services prove themselves to
each other with are not settings. They go to the login Keychain on macOS, to DPAPI on Windows
encrypted to the signed-in user, and on Linux to an owner-only file, which is said out loud rather
than dressed up: no desktop Linux install can be assumed to be running a Secret Service daemon, and
refusing to save a credential because gnome-keyring is missing would fail more people than it
protects. The value never goes on a command line on any of them, since ps is readable by every
process the person runs. macOS goes through the Keychain itself rather than the `security` command,
whose password prompt truncates at 128 bytes with no error and an exit status of zero: an OpenAI
project key is 164 characters, so every one of them was stored cut short and read back cut short on
the next run, while the run that saved it worked fine. From the store the credentials reach the
containers and the host processes as environment, which compose resolves before it reads the `.env`,
so a secret arrives at exactly the services that declare it and is written down nowhere. What an
earlier version already wrote in plaintext is moved and then purged, or the change would have bought
nothing for anybody who already had OpenBot.

### The credential store is asked once per run, not once per screen

Four Keychain dialogs every time the setup screen mounted, each needing a click before the window
would go on, and four more for navigating between setup and OpenBot. macOS authorizes every
individual read of a stored password unless the application is signed with an identity the item's ACL
already trusts; a development build is re-signed on every compile, so its ACL never matches, and the
wizard reads four secrets to arrive filled in. The store is asked once per name per process now and
the answer is held in memory, absence included, or a machine with nothing stored is asked on every
mount for something that was never there. Writes go through the same memory and forgetting clears it,
so the two cannot disagree. This does not remove the prompts on a first run, and nothing in this
process can: that decision belongs to the operating system and to the signature.

### Stop stops the Bot that was picked, and the next Start no longer refuses because of it

Compose only acts on a profiled service when the profile is named, so Stop left the one container the
person actually chose running on their laptop after they had stopped the app, still holding its port.
The next Start then refused, saying something was already listening on 4206, about a container
OpenBot itself had started, which the person never saw and could not find, and there was no way
forward from that screen. A port this deployment already publishes is not a stranger on the port, so
the check reclaims our own and keeps its teeth for somebody else's.

### Stop stops the host processes on Windows

Measured on Windows Server 2022: Stop took the containers down, reported success, and left the server
answering on 3001, the routines worker up, and both halves of the app answering on 3010. Only the
containers had gone. The handles a window holds cover what that window started and die with it, so a
window stopping a stack an earlier one started held nothing, and the Windows arm returned success
with a comment saying the host processes end with the session. They do not. The pids are written
beside the logs when the processes start and Stop reads them, ending each process together with its
children, since `bun run serve` starts the real server as a grandchild. A sweep of the ports this
deployment publishes stays as a second pass for a stack whose pid file is gone. Separately, a
byte-order mark in front of `package.json`, which `Set-Content -Encoding UTF8` writes freely, made
the manifest unreadable and was reported as "the deployment is older than this version of OpenBot",
sending somebody looking for a newer installer over three bytes.

### The installed app is served without a development server

"Show OpenBot" did nothing on a machine where the stack was up. The window said OpenBot was running,
the button was there, and clicking it had no effect at all. The app host process was dead: it was
started through `vite preview` under `bun --bun`, and Vite's proxy calls `socket.destroySoon()` when
an upstream response ends, which bun's sockets do not implement, so the process died with a TypeError
on the first call the app made. It served its page, exited, and nothing listened on 3010 from then
on, while the shell went on reporting a stack that was up, because the containers were. The app is
served by a small server of its own now: a directory and one forwarded prefix, which is all an
install needs, with no Node and no Vite at runtime. The websocket upgrade the live screen needs is
forwarded rather than answered with HTML, a miss under `/assets` is a 404 rather than the page, and
paths are confined to the directory, since the deployment's `.env` sits two levels above it. The
button also shows what it was told: the call behind it already answered "OpenBot is not answering on
port 3010 yet, so there is nothing to show", and the click handler threw that sentence away, which is
why a dead process looked like a dead button.

### A conversation whose history this deployment cannot reach says so

Clicking a conversation in the rail drew the coworker's name and then nothing at all. The rail comes
from OpenBot's own database, so a channel is listed whatever the history store says, while the
messages live in the Intelligence project: pointing a deployment at a different project leaves the
platform answering `THREAD_NOT_FOUND`. That 404 is deliberately read as "no history" and has to stay
that way, because a thread id is minted before the thread exists, so a brand-new conversation 404s as
its normal opening move, and widening it would tell somebody their conversation was gone and invite
them to start it over. The two are told apart by `lastMessageAt`, which is set only once something
has been said: a conversation with none is genuinely new and silence is correct, while one that has
been spoken in and comes back empty has a history this deployment cannot reach. That one now says so,
in the notice slot beside the existing explanations for a deleted coworker and for turns that could
not be parsed.

### `bun run dev` no longer starts a routines worker that cannot start

`bun run dev` fanned out across every workspace, and one of them is the routines worker. That worker
is handed `DATABASE_URL`, `SERVER_INTERNAL_URL` and `WORKER_SHARED_SECRET` by `scripts/start.sh` and
by nothing else, so the copy this command started read none of them and threw at boot on every run,
printing a stack trace in between the app's output and the server's. It has never started
successfully. The command now starts the app and the server, which is what `README.md` and
`docs/development.md` already say it does. Routines are unaffected: `scripts/start.sh` starts the
worker exactly as before, and on Kubernetes the CronJob does.

### Double-clicking works while a person is driving a Bot's browser

A double click was sent to the Bot's browser as two separate first clicks, because every press said
it was the first one. Chrome fires `dblclick` on the page only when the second press says it is the
second, so the page never saw one at all and `event.detail` was always 1. Opening a row in a table,
expanding a node in a tree and double-clicking a word to select it were all things a person holding
the wheel simply could not do, with nothing on screen to say why — the clicks landed, they just each
counted as the first. The count the person's own browser worked out is now the one that is sent, so a
double click is a double click and a single one is unchanged.

### Pressing Enter works while a person is driving a Bot's browser

Taking the wheel of a Bot's browser is mostly for the sign-in it cannot do itself, and Enter is how a
sign-in ends. Every keystroke reached the page, and Enter reached it as a key press that produces no
character — which Chrome delivers to the page's own listeners and then does nothing further with. So
the form did not submit, a new line in a text box did not start, and a button somebody had tabbed to
was not pressed, while anything on the page listening for the key saw it arrive. There was nothing on
screen to explain it: the keystroke was not refused, it simply had no effect, and the way out was to
click the submit button instead. Enter now carries the carriage return a keyboard sends, which is
what makes Chrome carry out what the key means. Measured against Chromium 151: every other editing
key — Backspace, Delete, Tab, Home, End and the arrows — already did what it meant and is unchanged,
and a single-line field still holds exactly what was typed into it.

### A half-ticked box is no longer described to a Bot as ticked

The snapshot a Bot reads before it acts on a page says whether each box is ticked, and Playwright
writes that as `[checked]` for one that is and `[checked=mixed]` for one that is neither — which is
what the "select all" above a partly-ticked list carries. The parser treated any value other than
the string `false` as ticked, and `mixed` is one, so a half-ticked box was reported as done. A Bot
asked to select everything read it as already selected, clicked nothing, and said the rows were
chosen when most of them were not. `mixed` is now reported as not ticked, which is both the true
half of a yes-or-no answer and the one that gets the right action: clicking a half-ticked box ticks
it. An ordinary tick and an ordinary empty box are unchanged.

### A Bot cannot end its turn by asking a person nothing

`ask_person` is how a Bot stops and puts something to a person instead of guessing, and a call with
no question in it was already meant to come back as a sentence telling it to say what it needs. That
only happened when the field was missing altogether. A question that was present and empty was
carried out: the Bot was told its question had been put to somebody, its turn ended there, and the
trail took an escalation row with nothing in its question — the row an administrator counts these by,
saying a person was asked something that was never said. On a deployment whose escalation route is a
duty desk rather than the person already in the conversation, it is a page to somebody with no
question on it. A blank question is now refused with the sentence that was already written for it,
and a question typed with room around it is recorded as the question rather than as the spacing.

### A routine scheduled for Sunday says Sundays, whichever number it was written with

Crontab has always let Sunday be either 0 or 7, the scheduler here takes both, and a routine written
with 7 is stored and fires on Sunday like any other. Only the 0 spelling was recognised by the
sentence the Routines page draws and the Bot reads back, so a working weekend routine appeared on
that page as `0 9 * * 7` while its neighbour said "Sundays at 09:00" — the same schedule, described
two ways, with the raw one looking like something had gone wrong. Both spellings now read as Sunday,
and a list that names the day under both of its numbers says it once.

### A tenant package's theme may carry a comment

A package's `theme.css` is checked at start-up against what it is allowed to define: the `:root` and
`.dark` blocks, the approved variables, no imports and no URLs. A CSS comment defines none of those
and was being read as though it did. One above the blocks — the line a hand-written stylesheet opens
with, saying whose brand it is and where the colours came from — was left over once the blocks were
set aside and refused as a second selector; one inside a block was split on the semicolons around it
and refused as a variable name, with the comment quoted back as the name it was not. Because the
package is read while the deployment starts, that was not a warning: the deployment did not come up,
over a comment, saying nothing about comments. Comments are now taken out before the file is read as
definitions, which also closes a comment wedged into the middle of `url(` as a way past the rule
above it.

### Test connection stops reading once it has seen the agent answer

The button that checks an agent before it is registered sends it a real run and reads what comes
back, needing only the opening of the stream to tell an AG-UI agent from a web server that happens to
be reachable. It was reading the whole reply first and applying that limit afterwards, so the check
took as long as the agent's run did. An agent that streams for more than fifteen seconds — a Bot
working through a document, a model answering slowly — was given up on mid-answer and reported as
`The agent started answering and the connection broke`, about a connection that had not broken and an
agent that had answered correctly in its first two events. It now reads the opening it needs, closes
the connection, and answers in the time the agent took to start rather than the time it took to
finish.

### A key pasted with a line break in it is now refused, instead of reported as an unreachable agent

The box that holds an agent's key takes whatever is pasted into it, and what comes off a clipboard is
not always what was on the screen: a long key copied out of a wrapped terminal line brings the wrap
with it, and a hyphen copied out of a document has often been turned into an en dash on the way.
Neither can be sent as an HTTP header — the runtime refuses the value outright — and neither was
being looked at. On Test connection that refusal surfaced as "This server could not reach that
address", with a suggestion about tunnels and firewalls, about an agent that was running perfectly
well and had never been dialled. Stored on the Bot it was quieter and worse: the form said saved, and
every turn that Bot took afterwards failed on a value nothing on screen said anything about. Both
places now check the value before accepting it and say which kind of character is in the way. The
character is named; the key never is.

### A deployment directory pasted with a stray space goes where it says

The desktop setup screen asks where OpenBot should live, enables Start once that box is not blank
after trimming, and then sent the untrimmed string — the same trap the API URL, the gateway URL, the
intelligence key and the model key were taken out of, and this is the one of the five that is a
place on disk rather than a credential. A path copied with the space the selection picked up, or
with the newline a copied line carries, was used whole. A trailing space made a second directory
beside the one everything else means: the tray's Stop and the next launch both ask for the default
path, which has no space in it, so a person was left with a deployment nothing on screen could
reach. A leading space was worse, because a path starting with a space does not start with a
separator — it stopped being absolute, and the deployment was laid out relative to wherever the
window happened to be running from. The path is trimmed at both ends now. Spaces inside it are part
of a directory's name and are left alone.

### The desktop app notices a busy port whichever loopback holds it

The shell refuses to start when something already holds port 3001 or 3010, because otherwise the
readiness check that follows is answered by a server it never started: everything reads green and
none of it is yours. That readiness check asks both loopback addresses on purpose, since a process
binds whichever one its runtime resolved `localhost` to — Node picks `::1`, Bun picks `127.0.0.1` —
so an answer at either counts. The refusal in front of it asked only `127.0.0.1`, which meant a port
held on `::1` alone was reported free and the start went ahead into it. Both addresses are asked
now, so the two agree on what "in use" means and the person is told which port is taken and what
OpenBot wanted it for.

### A request for a secret no longer follows a Bot into tomorrow's conversations

An unanswered ask to take the wheel stops being shown after ten minutes, because control belongs to a
Bot's computer rather than to a conversation. The other prompt on that computer, the masked box a Bot
opens when it needs one value it must not be told, was never given the same treatment: it sat there
indefinitely, so every later conversation with that Bot was flagged as needing a person and showed a
request for a password, captioned with a label written for whoever asked half a day earlier. It now
expires on the same ten-minute window, and stops being answerable at the moment it stops being shown,
so a value typed into a box left open in an old tab is refused rather than sent to a page whose run
has ended. A request inside the window is unchanged, and a person actually holding the wheel is still
never timed out.

### `COMPUTER_BROWSER_IDLE_MS=0` now keeps browsers resident, as it says it does

Zero is the documented way to switch off the sweep that closes a Bot's browser after it has sat
untouched, and the sweep itself reads a timeout of zero as being switched off. The value never got
that far. It was read the way the cap on running browsers is, where zero would close every browser
the moment it opened and so has to be refused, and an operator who typed zero got the thirty-minute
default handed back instead. Their browsers went on being closed, which is a Bot signed out of a site
that only issues session cookies and a cold Chromium on its next turn. Zero is now kept for this one
setting. A blank variable, which is what an unset variable declared in a compose file arrives as, is
still not zero: it means "not set" and takes the default, as do a negative and anything that is not a
number.

### A flag or a family emoji in a channel preview is no longer cut in half

The one line a roster draws is cut to a cap, and the cut walked code points -- right for a plain
emoji, wrong for every emoji built out of more than one. A flag is two regional indicators, a family
is three people joined by zero-width joiners, a thumbs-up with a skin tone is the thumb plus a
modifier, and a keycap is a digit plus a variation selector plus an enclosing mark. Landing the cut
inside any of those left a boxed letter, a dangling joiner or a bare digit in the sidebar, in the
generated channel title, and in the excerpt the titler is shown. The cut is now taken between
grapheme clusters, so what a person sees as one character is kept or dropped whole. Plain text is
cut in exactly the same place as before.

### A scroll with an unusable `deltaY` is refused, rather than scrolling some other distance

`POST /computers/:botId/scroll` and `POST /computers/:botId/human/scroll` accepted any JSON number
as `deltaY`, and `1e999` is a JSON number: it parses to `Infinity`, passes the `typeof` check, and is
turned back into `null` by the hop to the Bot's computer, which reads the field as absent and scrolls
its own default distance. The caller was answered 200 for a scroll it had not asked for. A `deltaY`
that is not a finite number now answers 400 and the page is not touched, the way the timeout on
`exec` and the coordinates behind a person's click already did.

### An MCP call carrying `x-api-key` is stopped the same as one carrying `api-key`

The check that keeps credentials out of MCP tool arguments compared each argument name against a
list, and `api-key` was on it while `x-api-key` was not -- so the spelling that is more obviously a
credential header was the one that went out. `x-` is the conventional prefix for a non-standard
header and says nothing about the value, so it is now dropped before the comparison. The same pass
adds the spellings of names already on the list that were missing from it: `passwd` and `pwd` for
`password`, `auth_token` and `bearer_token` and `session_token` for `token`, `api_secret` and
`secret_key` and `signing_key` for `secret`, and `ssh_key` for `private_key`. Nothing new counts as
a credential: an argument named `x_axis`, `token_count`, `max_tokens` or `secretary` is passed as
before.

### One command to stop what `start.sh` started

Stopping the local stack meant four commands read off the end of a successful start, and the one
easiest to miss was the one that mattered: a Bot's computer is made by the supervisor rather than by
compose, so `docker compose down` left a Chromium running per Bot. `bash scripts/stop.sh` stops the
app, the routine worker, the API server, the compose services and every Bot computer, in that order,
and is safe to rerun. It kills a port holder only once that process has identified itself as
OpenBot, so an unrelated process on 3010 is named and left alone rather than killed. Nothing is
deleted: the database, the Bots' files and their browser profiles are volumes. `--keep-computers`
leaves the browsers signed in.

### The trail says when an identity provider was added, not only when one was taken away

Whoever holds an identity provider decides who can sign in at all, and the audit trail recorded only
half of that. Removing one through the administration screen was written down; registering one was
not, because registration is the sign-in library's own endpoint and nothing this deployment owns ran
on the way through. The event type for it had been declared and never written. Removing a provider
through the library's endpoint rather than the screen was unrecorded for the same reason. Both are
now written where the deployment already stands in front of those routes to check that the person
asking is an administrator, so a provider appearing or disappearing names itself and whoever did it.

### Two workers on one machine can no longer fire the same routine twice

Every process that claims work from the shared queue named itself after its hostname, and the queue
tells two claimants apart by that name alone. Two processes on one machine therefore had the same
name, so the lease meant nothing between them: one whose lease had lapsed was still told the item was
its own, and both went on to dispatch it. A routine fired that way opens two runs and sends the same
scheduled message twice. Nothing stops two workers running on one machine — the worker binds no port,
and `scripts/start.sh` looks for a process it does not start the way `bun run dev` does. The name now
always carries a random suffix, so a second process is a different claimant. It also keeps the
hostname, so a stuck claim still traces back to the machine holding it, and a blank `HOSTNAME` is no
longer read as a name — which had made every replica in a deployment share one.

### The desktop app writes its `.env` readable only by its owner

The desktop `.env` holds `KEY_ENCRYPTION_KEY` and every minted token, and those are now long-lived:
the first start writes them and every later start reads them back. It was created at the default
umask (`0644`), so on a shared macOS or Linux machine another local user could read the vault key off
disk. The file is now narrowed to `0600` after it is written. Windows has no equivalent mode and its
single-user desktop profile is already the boundary, so the change is Unix-only.

### The desktop app stops adding a banner to `.env` on every start

`env::write` keeps the lines it did not write, and its own header comment is one of them, so each
start preserved the previous banner and appended another. A deployment started fifty times had fifty
copies of "Written by OpenBot Desktop" and fifty blank lines stacked above its settings. The banner
is now recognised and replaced rather than kept, and comments somebody else put in the file are left
alone exactly as before.

### Starting the desktop app again keeps the secrets the first start generated

The shell generated a fresh set of secrets every time Start was pressed, including the
`KEY_ENCRYPTION_KEY` that encrypts the credential vault. The database survives a stop, so the second
session of an installed OpenBot met a vault it could no longer read: every stored credential failed
to decrypt, with an error that named an operation rather than a cause. It also handed the server a
`COMPUTER_TOKEN` that no computer created before the restart holds. The secrets an existing `.env`
already carries are now kept, and only generated when there is nothing usable to keep — a value
published in this repository does not count, and neither does a `KEY_ENCRYPTION_KEY` the server would
refuse to start on.

### The desktop app refuses a deployment download that writes outside its own directory

The shell fetches the release tarball and lays it out under the directory it manages. The check that
kept an entry inside that directory compared paths lexically -- `root.join(path).starts_with(root)`
-- and `Path::starts_with` matches components without resolving `..`, so `app/../../elsewhere`
started with the root and still landed outside it. An entry has to begin with a directory a
deployment wants, which `app` does, so the file filter did not stop it either. Every component of a
path inside the tree is now required to be an ordinary name, and the traversal is refused by name.

### A credential pasted with a stray space into the desktop setup screen now works

The setup screen enables its button on `value.trim() !== ""` and then sends the untrimmed string, so
a key copied from a provider's dashboard with the space the selection picked up arrived intact. The
model key was trimmed on the way into `.env`; the API URL, the gateway URL and the intelligence key
entered on the same screen were not, so Compose passed the space through, the provider rejected the
credential, and the failure the person saw named neither the space nor the field. All four are now
trimmed the same way.

### Example LangGraph and Mastra Bots no longer bind an ephemeral port on empty `PORT=`

An empty `PORT=` in compose or `.env` used to become `NaN` for those two example processes, so they listened on a random port while docs still named 4300/4400. They now use the same `listenPort` helper as `agent-bot`: empty is the documented default, and a prefix typo refuses to start.

### An empty app port is the default, not a random one

`APP_PORT=` and `SERVER_PORT=` in a compose file or leftover `.env` used to become `NaN` for the Vite
dev and preview servers, so the UI bound an ephemeral port while the proxy target was `http://localhost:`.
Both empty values now mean the documented defaults (3010 and 3001), and a non-numeric value refuses to start.

### The trail says what started a run, not only whose authority it had

A routine runs as the person who set it up, and a Bot handing work to another Bot runs as the person
who began the conversation. Both are correct, that is whose grants and whose connections are being
used, and both meant an action taken while somebody slept was written into the audit trail as though
they had taken it themselves. Telling the two apart meant correlating timestamps against
`routine_runs` by hand, and there was nothing at all to correlate a hop against.

Every audit row now also names what caused it: a person, a routine, another Bot handing work on, or
the deployment itself. It travels inside the signed run assertion, so a tool call, a hop, a Bot
stopping to ask its person and a stalled stream all say it, and a Bot cannot relabel its own run.
The Audit screen has a **Started by** column and a **Nobody watching** view that answers the
question directly. An unattended run is the one nobody is there to notice going
wrong, which is the reason it is worth being able to find.

The fourth of those exists so the column never overclaims. Two rows have no person behind them at
all: the boundary and isolation rows written at start-up, and the refusal written when a caller
cannot be identified at all. Those say the deployment, not a person, and they stay out of
**Nobody watching**, which asks what ran on somebody's authority rather than what the deployment did
by itself.

Nothing about existing rows changes. Every row already written, and every row a person's own click
writes from now on, reads as a person, because that is what it was.

### The live screen and live channel updates work again, and one request can no longer end the app

The app opened its two WebSockets against its own address, so they travelled through Vite's `/api`
proxy. Vite is run through bun, and under bun that proxy does not carry a WebSocket: neither the
Bot's screen nor live channel updates ever connected, and the browser retried in a loop. Worse, an
upgrade the server answered with an ordinary HTTP response — a 503 when a Bot's computer is not
running, which is exactly when somebody opens the screen — crashed the process that served the app,
taking the server and the worker with it in development. Where Vite serves the app — the dev server
and the desktop's `vite preview` — both sockets now address the server directly, so nothing upgrades
through the proxy and the proxy no longer offers to carry one. In production the server serves the
app itself and answers the upgrade on the same origin, so the sockets stay on the browser's own
host, which is what an ingress terminating TLS on 443 requires and a fixed server port would break.

## 0.0.8

### A desktop shell that installs OpenBot and then becomes it

One window, on macOS, Windows and Linux. From a machine with nothing on it, one click fetches the
deployment for this release, pins every image to the digest the release published, generates the
secrets that are OpenBot's to generate, raises the containers, applies the migrations, installs the
dependencies, starts the host processes, waits until both the API and the app answer, and then shows
OpenBot in the same window. It is not a launcher for a browser tab. Stop takes the stack down, closing
the window hides it to the tray, a second launch hands over the window that already exists, and
quitting stops what starting started. Windows is told what it needs before anything else runs: WSL,
its kernel, virtualisation and administrator rights are each named with the command that fixes them,
because none of them is something OpenBot can fix on somebody's behalf.

### A title or name that is only spaces is refused rather than stored

Sandboxed components, skills, custom servers and the component catalogue each accepted a title, slug
or id made entirely of whitespace, and stored it. What came back was a row nobody could identify and,
in the catalogue's case, entries that were empty strings. Each endpoint now refuses those the way it
refuses a missing field, and the catalogue drops empty entries instead of keeping them.

### A malformed socket message no longer takes the screen down

The live screen and the channel socket both assumed every payload they received was an object of the
shape they expected. Anything else threw inside the handler, which in a browser means the surface
stops updating with nothing on screen to say why. Both check the shape first and ignore what does not
match.

### The worker refuses a bad server URL when it starts, not when it first needs it

`SERVER_INTERNAL_URL` was read as a string and used as one. A value that was not an http or https URL
failed later, inside whichever call happened first, with an error about that call rather than about
the setting. The worker validates its environment up front now and normalises the URL, so a typo stops
it immediately and says which variable is wrong.

### A sandbox template that is not valid JSON is reported as a sandbox error

A malformed template surfaced as a raw parse error from whatever tried to read it. It is a
`SandboxError` now, which is what the caller already handles and what the surface already knows how to
show.

### A duration written in capitals is understood

`durationMs` accepted `30s` and refused `30S`. Units are read case-insensitively now.

### The supervisor refuses a `HostPort` that is not a port

The value went through a bare `parseInt`, so `80abc` became 80 and an out-of-range number was used as
given. Digits and range are checked, and anything else refuses to start rather than binding somewhere
nobody asked for.

### The audit endpoint refuses a bad date or limit instead of guessing

An unparseable `from` or `to`, or a `limit` that was not a whole number, was coerced and the query ran
against whatever came out. All three are parsed strictly now and a bad one answers 400.

### Chat content that does not parse is dropped rather than thrown

One malformed entry in a user message threw and took the whole message with it. The malformed part is
dropped and the rest is delivered.

### The example package is read by a path the host accepts

It was addressed by a URL pathname, which is not a path on Windows. It is read by a real path now.

### The app can be served from a built bundle, and listens on both loopbacks

The app's only start script was `dev`, which runs a Vite dev server. That meant `NODE_ENV=development`
on a freshly installed product: the SDK drew its developer inspector over the top, with hot reloading
and source maps behind it. There is a `serve` script now that builds once and serves the build. Both
it and `dev` hand Vite to Bun directly, because `node_modules/.bin/vite` begins `#!/usr/bin/env node`
and a machine with Bun and no Node exits 127 without saying why. Vite is also told to listen on `::`,
since Node resolves `localhost` to `::1` and Bun to `127.0.0.1`, so binding one of them left whoever
asked for the other looking at nothing.

### A person's Stop is recorded as a stop, not as a failed action

Pressing Stop mid-action aborts the request, and the gateway wrote that outcome beside the decision
row as a failure — the same `computer.action_failed` type it writes when a computer is unreachable or
times out. The row's message already said the action was stopped, but anything counting failures by
type, the natural way to watch for outages, read every Stop as one. A stop now writes its own type,
`computer.action_stopped`: the action did not happen and nothing broke. The audit page already groups
it with the other did-not-happen outcomes, and a policy dry-run skips it the way it skips a failure,
since both sit beside a decision row that is already scored.

### A malformed `DATABASE_URL` is refused without printing the password

`DATABASE_URL` is taken apart before it reaches Bun, and the string most likely to fail that parse is
one with a stray character in the password. The refusal for an unparseable value quoted the whole
string back to name the fault, which wrote the database password into the log line that reported it.
It now names the variable and the shape it expects, the way the other refusals beside it already do,
and never echoes the value.

### Wiping a computer is recorded even if clearing its stored state fails

Resetting a computer destroys the profile first and wrote the audit row last, after two Postgres
deletes. A connection reset, a failover or a statement timeout in either delete threw before the row
was written, so the most destructive button in the product could leave a wiped computer -- every
login gone, no undo -- with nothing on the trail to say who wiped it or when. The row is now written
as soon as the profile is gone, which is the point after which nothing can be put back. A failure in
either delete is still reported to the caller.

### Pressing Stop is recorded as a stop, not as a computer that is not running

The computer transport answered a Stop correctly only when it arrived before the request left. The
caller's signal is handed to `fetch` precisely so a Stop can also land mid-action, and a fetch
aborted that way rejects with an `AbortError`, which fell through to the message for a computer that
cannot be reached. The person was told their own click had failed because the assistant's computer
was not running, and the gateway wrote that sentence into the action's audit row as its failure --
so a deliberate stop read back as an outage. A genuinely unreachable computer and a timeout still
say what they said.

### A component the server refused is no longer drawn anyway

A sandboxed component asks the server at call time whether the Bot may still use it, and a refusal
is recorded so the drawing can be replaced with a card saying so. The renderer looked that refusal
up under `props.toolCall.id`, which is the shape a tool HANDLER is given; a renderer's props carry
the id flat, as `toolCallId`. The lookup key was therefore always undefined, the refusal was never
found, and the component rendered as though it had been allowed -- so revoking a component from a
Bot did not take effect on screen until the five-second grant poll caught up, and a failed decision
request showed nothing at all.

### A component whose name has a stray space is the same component

The catalogue announcement asked whether each component's `name`, `title`, `kind` and `description`
were more than whitespace, and then published the untrimmed strings. A `name` is a component's
identity -- it is what `syncCatalogue` compares against what is already published, what `decide` and
`listForAgent` look up, and what a grant names -- so a build shipping `" weatherPanel "` added a
second catalogue row beside `weatherPanel`: published, ungranted by anybody, and impossible to hold
a Bot back from under the name people use. The four fields are now stored as the strings the guard
approved.

### A password with a `%` in it says so, instead of failing as `URI error`

`DATABASE_URL` is taken apart before it reaches Bun, and each part is percent-decoded. A part
holding a `%` that starts no escape -- `postgres://openbot:100%pure@host:5432/openbot`, which a
generated password produces often enough -- is a string `new URL` accepts and `decodeURIComponent`
rejects, so the server stopped with `URIError: URI error` and named neither the variable nor the
part. It now refuses with the same kind of sentence as every other malformed address: which part is
wrong, and that a literal `%` must be written `%25`.

A correctly encoded password is unaffected.

### An empty Bot `PORT` is unset, so NaN never reaches Bun.serve

`PORT=` on `agent-bot` and `agent-langgraph` used to parse as `NaN` (`??` does not treat empty as absent) and `Bun.serve` bound an ephemeral port while compose still published 4200/4201. A prefix typo (`42o0`) started on 42. Empty now means the shipped default; anything that is not a whole port number refuses to start.

### The server connects to Postgres on Windows, and `localhost` is no longer a coin toss

Two separate faults, both of which stop a deployment reaching its own database and neither of which
says so.

The connection address went to Bun as a URL. Bun reads such a URL's path, the database name, as the
path of a unix socket, ignores the host and the port, and fails to open a socket Windows does not
have (oven-sh/bun#27713). The server could not reach Postgres there at all, while `psql` inside the
container and a plain TCP connection from the same machine both worked, which makes it look like a
network fault rather than a parsing one. The address is now passed in parts, and `DATABASE_URL` is
removed from the environment as it is read, because Bun prefers that variable to the parts it was
handed and would otherwise put the address straight back through the same parser. A URL with no host
or no database is now refused by name instead of connecting somewhere nobody chose.

Separately, Compose published its loopback ports on `127.0.0.1` only. `localhost` resolves to `::1`
and `127.0.0.1` in an order the platform decides, and a client handed `::1` first does not fall back
to the other, so the same configuration worked on one machine and failed on the next for a reason
nothing in the error mentions. Every loopback port is now published on both addresses. Both are
loopback, so nothing became reachable from another host.

### A bad `COMPUTER_MEMORY_BYTES` refuses to start the supervisor, instead of capping a computer at 512 bytes

`COMPUTER_MEMORY_BYTES=512m` used to parse as `512` via `parseInt`, which Docker accepts as a memory
cap Chromium cannot live in. Empty `COMPUTER_MEMORY_BYTES=` is still unset (no cap). A value that is
not a whole number of bytes now exits before any computer is created.

### An IPv6 address in `AGENT_ENDPOINT_ALLOWED_HOSTS` now matches however it is written

The endpoint check compares the list against the address as the URL parser spells it, compressed
and lower-case, while the list kept each IPv6 entry as the operator wrote it. `[0:0:0:0:0:0:0:1]:8443`
was therefore a line that silently never matched, the failure the list's other refusals exist to
prevent. Stripping the brackets on both sides also folded two different names into one, so naming
`[fd00::1:8443]`, an address, admitted `[fd00::1]:8443`, another address on a port, and the other way
round. Bracketed entries are now stored in the parser's spelling, with the port kept as written, and
compared with their brackets on; an entry the parser does not read as an address is refused at boot,
naming the entry, as a URL or a wildcard already was. Names and IPv4 entries are unaffected.

### A Bot's own decline is only recorded against a Bot the caller may reach

A Bot reports that it declined a request through the person's session, and the audit row says
`reportedBy: the Bot itself`. The route wrote that row for any agent id in the path, without asking
whether the caller could reach that Bot, so any signed-in person could put a decline, in any words,
against any coworker, one they cannot see included, and an administrator reading the trail would take
it for something the Bot said. The route now asks the store first, as every other route on a Bot
does, and answers not found for a Bot the caller cannot reach, writing nothing.

### The engine socket the supervisor is given can be pointed somewhere else

Compose mounted `/var/run/docker.sock` into the supervisor as a fixed path. That is correct for
Docker, and for Podman on macOS, where `podman machine` symlinks it to the rootless socket inside the
virtual machine. It is wrong for rootless Podman on Linux, where the path is either absent or, with
`podman-docker` installed, a symlink to `/run/podman/podman.sock`, the rootful socket, which is not
the one running. The supervisor held a dead socket and every attempt to give a Bot a computer failed
with a message about not reaching Docker.

The mount source is now `ENGINE_SOCKET`, defaulting to `/var/run/docker.sock`, so nothing changes
unless it is set. On rootless Podman on Linux, set it to `$XDG_RUNTIME_DIR/podman/podman.sock`.

### A Bot's computer is waited for properly on Podman, and the supervisor can reach the engine there

Two things stopped OpenBot running on Podman, which nothing had tried before.

The supervisor could not reach the engine at all: `The supervisor could not reach Docker`. The socket
is there and the mount is right, but Podman's virtual machine runs SELinux and labels the socket in a
way a container is not allowed to read. The supervisor now declares `label=disable`, which is what
that needs and which changes nothing on Docker.

Then every cold start of a computer raced the first request to it. Readiness was read off the image's
`HEALTHCHECK`, and Podman does not report one: its images are OCI-manifest, the OCI image config has
no healthcheck field, and the instruction is dropped both when Podman builds an image and when it
pulls one that has it. With no health to read, the supervisor fell back to accepting a container that
was merely running, and a running container is not a browser that is answering, so the first request
arrived at a port nothing was listening on and came back as a computer that is not running. The
supervisor now states the healthcheck when it creates a computer instead of inheriting it, so
readiness no longer depends on how the image was built. On Docker the behaviour is unchanged.

## 0.0.7

### The published service images are zstd rather than gzip

An image pull was already a compressed transfer, so this is not compression where there was none; it
is a better algorithm for the same job. `agent-computer` goes from 962 MB to 886 MB on the wire, and
zstd inflates several times faster, which on 2 GB of Chromium is worth more than the 8%. The saving
comes from recompressing the layers that arrived from somebody else's registry, where nearly all of
the bytes are, so the images no longer share layers with a gzip pull of the same base.

This applies to the five `ghcr.io/copilotkit/openbot-<service>` images and not to
`ghcr.io/copilotkit/openbot`. Reading a zstd layer needs a client that supports it, which Podman and
current containerd do; the single image is pulled by deployments running whatever they have, so it
stays gzip.

### A release publishes every service's image, not just the one

`ghcr.io/copilotkit/openbot` was the only image a release produced, so anything running the Compose
stack built `agent-computer`, the supervisor, both Bots and the migration image from source on
every machine. That needs a toolchain and it needs several minutes, most of them Chromium, and it
is the difference between a deployment and a laptop being able to start at all.

Each of those is now published beside it, at `ghcr.io/copilotkit/openbot-<service>`, carrying both
`linux/amd64` and `linux/arm64` so one reference works on a server and on an arm64 laptop. Every
image gets its own build provenance attestation, and `container-images.json` on the release pins a
digest for all of them rather than for one.

Nothing changes for a checkout: unset, `COMPUTER_IMAGE`, `SUPERVISOR_IMAGE`, `BOT_IMAGE`,
`LANGGRAPH_IMAGE` and `SERVER_IMAGE` name local tags and Compose builds them as before. Point them
at published digests and set `IMAGE_PULL_POLICY=missing` to pull instead. `docs/releasing.md` shows
reading the references out of `container-images.json`; `docs/configuration.md` lists the settings.

CI now builds those five Dockerfiles too. Nothing did before, because they are built by
`docker compose up --build`, which only the smoke journey runs and which cannot run in CI, so a
broken one surfaced during a release after the first image had already been pushed.

### A skill can be written in the conversation instead of retyped into a form

A skill is four fields and an instruction a Bot follows, and the instruction is the one that decides
whether the skill works. The only place to write it was a textarea on `/skills`, which meant having
the conversation, getting a good draft in the transcript, and then copying it out and retyping it.
Mostly nobody bothered, which is how a deployment runs for months with no skills in it.

The example package now ships a `skill-creator` skill, granted to `general-assistant`. A Bot holding
it is offered four tools for listing, reading and saving skills; every other Bot is offered none of
them. It interviews you about the skill you want, looks at what already exists before naming it,
rehearses it against one realistic request, and then saves it.

The save is a card, not something that happens quietly. It draws the command, the title, the declared
tools and the whole instruction, and writes nothing until a button is pressed. A skill appears in
everybody's `/` menu with somebody's name on it, and saving is also how an edit is spelled, so an
unattended save could replace a skill somebody is already using.

The tools run in the browser as the signed-in person, over the same `POST /api/plugins/skills` a
person uses, so who may take a slug is answered the same way and the `configuration.changed` audit
row is written the same way.

### Resetting a computer clears the activity pane

Resetting a Bot's computer deletes the browser profile it worked on, but the activity pane beside the
chat went on listing the commands and file operations that ran there. They sat alongside anything the
Bot did afterwards with nothing to tell the two apart, and only reloading the page cleared them. The
pane now forgets a Bot's history when that Bot's computer is reset. Stopping a browser is unchanged:
the profile survives a stop and is meant to resume, so what it did is still true of the machine.

### A person can set standing instructions that every coworker follows

Settings now has a box for standing instructions: one piece of text per person, saved once and
spliced into every built-in coworker's prompt, in every channel, on every run, including the runs a
routine starts overnight. It is the place for what is true of every task rather than of any one of
them, such as how somebody wants to be written to or what their company is and is not to be called.
A coworker's role still decides what it does; these decide how it does it, and the prompt says so,
so an instruction cannot quietly redefine what a coworker is for.

Instructions belong to the person who wrote them. Nobody, administrators included, can read or set
somebody else's, and they are deleted with the account. A coworker running at a remote AG-UI
endpoint is not sent them, since this deployment does not compose that prompt. Nothing is added to
any prompt until somebody writes something, so a deployment where nobody uses this behaves exactly
as before.

This adds migration `0026_user_instructions`, which creates one table.

### A coworker can be made in the conversation, and it starts able to reach nothing

A coworker without an endpoint runs on its role description, which becomes the standing instruction
handed to a model on every turn in every channel it is in. It is the hardest thing anybody is asked
to write cold, so people write a sentence, get a coworker that answers vaguely, and never go back to
the field that decided everything.

The example package now ships a `bot-creator` skill, granted to `general-assistant`, with tools for
listing, reading and saving coworkers. It asks the follow-up your last answer calls for, reads the
roster to say when something already does the job, and can be told to make one like an existing
coworker but for a different job, then go and read what that coworker actually runs on.

The card shows the name, the job, the skills and the entire role description, scrolled rather than
clamped, because that text runs on somebody's behalf. What is made is granted nothing: it can reach
no connector, no tool and no browser until somebody grants it, and a conversation with it says so.

Like the skill tools above, these run in the browser as the signed-in person over the endpoints a
person uses, so who may create a coworker is answered the same way and `bot.created` carries the
actor.

### A conversation has a name of its own

A channel's name was only the names of the Bots in it, so asking one Bot about six unrelated things
gave six rows reading the same thing, told apart by a preview of whatever was said last, which is
usually the tail of an answer and says nothing about the question. A conversation is now named from
its opening exchange, and the roster's second line holds that name instead of the preview, falling
back to the preview until a name exists. A row is never blank and never worse off than before.

Two things a deployment should know. The opening exchange, up to 600 code points, is sent to whatever
`tenantPackage.model` names, which is the same provider the Bots already use, so it is not new egress
but it is sent as housekeeping rather than because somebody asked for it. And the second line now
says what the conversation is about instead of what was last said.

It runs on the work queue rather than as a headless turn, so naming a conversation never takes the
Intelligence thread lock and cannot refuse somebody's own next message with a 409. A deployment with
no model key names nothing and carries on.

### The trail says who a coworker was opened to

Making a coworker public admits every signed-in person to it, and being admitted to a coworker is
being allowed to act as it — with the connectors, the tools and the browser it was granted. It is one
click in the coworker dialog. The `bot.created` and `bot.updated` rows recorded the name, the
endpoint and whether a key was set, and said nothing about this, so an edit that opened a coworker to
the whole deployment was byte-identical on the audit page to one that corrected its title. Both rows
now carry the visibility, on every edit rather than only the edit that moved it, so reading the trail
forward says who could reach each coworker at any point.

### Duplicating a Bot in the box keeps its instructions

A coworker that runs on this deployment's own Bot has no endpoint — it has a prompt, which is the
whole of what makes it that coworker. Duplicate rebuilt every copy from the endpoint alone, found
none, and fell back to the managed Bot with the prompt dropped, so the copy carried the name, the
title, the role and the avatar and none of the instructions. Its entire instruction became the one
sentence of role description, which is the shape behind the compliance answer this repository
already has a note about. The two coworkers the default package ships are both of this kind, and one
of them is a careful do-not-fabricate instruction. A copy now keeps the prompt and stays a Bot in the
box, which also means it can still be granted the right to hand work on — written as a hosted
coworker it could never hold that grant, however the original was set up — and copying one no longer
needs a managed Bot to fall back to.

### Hiding a coworker no longer hides the grants pointing at it

Hiding a coworker is a preference about your own roster — one row per person — and the grants saying
which Bots may hand work to it are a deployment-wide fact an administrator set. The Handoff section
joined the two, so hiding a coworker from your roster took every grant aimed at it off the screen:
the switch was gone, no note said why, and the count above the list quietly dropped by one. Those
grants were still in force, because a hop is decided by the grant and not by anybody's roster, so
the coworker went on being asked while the only screen that could stop it had stopped listing it.
A coworker you have hidden now appears in that list when a grant already points at it, marked as
hidden from your roster, so it can be switched off. One you have hidden with nothing granted to it
stays hidden.

### A tool call that failed no longer reads as one that worked

The audit page draws a row it does not recognise as `Allowed`, which is right for the many rows that
are neither a refusal nor a failure. Two rows that are failures were falling through to it: a
connector tool call this deployment permitted and the vendor did not complete, and a component's
data read that was granted and then broke. Both were drawn in the same muted colour as a call that
went through, and neither appeared under `Did not happen`, so the view an administrator opens to ask
what did not work here was short by exactly the rows they came for. A per-person connector fails on
this path every time somebody's token expires, so this was the most common failure the product has
and the one the trail was quietest about. Both now read as `Did not happen`, and both are in that
saved view. Neither is filed as a refusal: nothing was forbidden on either row.

### A blank agentId on a channel activity says which field was wrong

`POST /api/channels/:id/activity` accepted an `agentId` of only spaces, trimmed it to nothing, then
looked that up and answered `404 Agent not found`. The field was malformed rather than the agent
missing, so the answer sent whoever was integrating to look for a coworker that was never named. It
is now a `400` naming the field, which is what the same endpoint already did for malformed text.

### Audit payloads are redacted by the store as well as by its caller

Redaction of secrets out of audit payloads happened in `recordAuditEvent`, and every caller in the
tree goes through it. The store underneath it is exported, though, and its `insert` wrote whatever it
was handed, so a future direct caller would have written secrets to the audit table in cleartext.
`insert` now redacts too. Redaction is idempotent, so nothing about the existing path changes; this
is the floor under it rather than a fix to it.

### A stray space in NODE_ENV no longer lets the public example key through

A deployment that never changed `KEY_ENCRYPTION_KEY` encrypts its credential vault with the key
printed in `.env.example`, so the server refuses to start with it under `NODE_ENV=production`. That
refusal compared the variable exactly as written, while the other production refusal beside it —
private-host browsing — trimmed first. Both read the same env file, and a trailing space there is
invisible: Docker's `env_file` preserves it and so does every hosting dashboard with a text box. So
`NODE_ENV=production ` tripped one refusal, slipped past the other, and started the deployment on the
public key with only a warning at boot. Both gates now ask the same question the same way.

### A tool result from an MCP server with an empty part no longer crashes the turn

Reading a tool result cast every part to an object and asked for its type. A `null` or missing entry,
which a vendor's MCP server is free to send, threw instead, and the turn that had just called the
tool failed. Such a part is now named `[unknown]`, which is the same naming-rather-than-dropping the
surrounding code already does for parts it does not recognise, so the rest of the result still
reaches the Bot.

## 0.0.6

### Setting up needs one Intelligence credential, not two

`COPILOTKIT_LICENSE_TOKEN` is no longer required. Managed Intelligence derives entitlement from the
project key, so the second credential people were sent to fetch had stopped existing, and startup
was still refusing to boot without it. A deployment now needs `INTELLIGENCE_API_URL`,
`INTELLIGENCE_GATEWAY_WS_URL` and `INTELLIGENCE_API_KEY`. A licence token is still read and still
forwarded to the runtime when set, which is what a self-hosted Intelligence with its own licence
needs.

The Helm chart failed harder than the docs did: it *required* `secrets.licenseToken`, so a
managed-Intelligence install was refused at `helm install` rather than merely misdocumented. That
value is now optional.

### Duplicating a coworker keeps the endpoint it was copied from

Duplicate used to point every copy at this deployment's own managed Bot, whatever the coworker being
copied ran on. Duplicating one you host yourself gave back something that looked identical on every
screen, carried the same name, title and role, and answered from a different process. The copy's
connection tab then said it ran here and stopped showing an endpoint at all, so the swap was
invisible in the one place you would have checked. A copy now runs where its original ran, and the
managed Bot is used only when the coworker being copied had no endpoint of its own, which is the
same fallback that applies when you create one without an endpoint. It does not inherit the
original's key: that is a reference into the vault, and two coworkers sharing one credential would
mean rotating either one's key silently changed the other's, so a copy starts without one. On a
deployment with no managed Bot configured, duplicating a coworker that brought its own endpoint now
works instead of being refused with advice to give it an endpoint it already had.

### Connecting an account survives a vendor that is down

Finishing a connection used to end on a blank server error if the vendor could not be reached at the
moment you were sent back, whether that was a refused connection, a name that would not resolve, or
fifteen seconds of silence. It now ends where every other failed connect already ended: back on
Connected accounts with a note, and nothing stored. Pressing Connect for a vendor this deployment
has not introduced itself to yet behaves the same way, answering 502 rather than a server error, and
that message now covers a vendor that could not be reached as well as one that turned the
registration down.

A connection whose grant cannot be written to the vault ends the same way, rather than on the blank
error it used to give somebody who had just finished consenting.

Because the person is told the same thing whatever went wrong, the server log is now where the
difference lives. Three lines to look for: `oauth-token-endpoint-unreachable` and
`oauth-registration-endpoint-unreachable` name the vendor and the cause, and
`oauth-connection-not-recorded` says a consent completed and could not be kept. A fourth,
`oauth-token-endpoint-unusable`, means the fault is this deployment's catalogue rather than the
vendor.

### A custom MCP server token is sent with the scheme it names

Every token stored against a custom MCP server went out as `Bearer`, whatever the vendor asked for.
A server that forwards the header to an API speaking Basic auth still answers the handshake and the
tool listing, so the Plugins page showed the connector connected and its tools offered, and every
real call came back 401. DataForSEO's hosted server behaves exactly this way.

A token that begins with `Basic ` or `Bearer ` is now sent as written, so paste the credential the
vendor gives you, scheme and all. A bare token is still sent as `Bearer`, so nothing already
working needs to change.

### A conversation is no longer stuck after a tool call went unanswered

A tool that runs in the browser can be torn down while its call is still open, most often because
the tab was closed or reloaded mid-run. The call stayed in the thread with no result, every retry
sent it back up, and the model API refused the whole conversation with `Tool result is missing for
tool call ...`. The next three things the person typed failed identically, and the only way out was
to notice that and start another channel.

A chat turn now drops a tool call nothing is going to answer before the conversation reaches the
model, on a built-in Bot and on a remote one alike. Routines already did this for the history they
seed, and now share the one filter, with a stricter rule than theirs was: a result counts as an
answer only if it arrives before the next thing the person said, matching what the model API
enforces, so a handler that resolves after the person has typed again no longer looks like an
answer. A routine's seeded history that held such a late result used to keep both halves and fail
at the model; it now drops both and runs. A result that sits ahead of its own call, or a second
answer to a call already answered, is dropped as well rather than sent where no provider accepts
it. Ids are never rewritten and the stored thread is untouched, so the transcript still shows what
happened and a call waiting on a resume still gets its result. The same filter also covers a Bot
answering a relayed question, whose seeded conversation kept every tool call and no tool result.

### Reopening a channel no longer hides the end of the last conversation

Opening a channel joins the realtime gateway, and the snapshot the join returns can lag the durable
store. When it did, the last exchange of a finished turn was missing from the transcript on every
reload, with no unread marker or anything else to explain the gap, and the stored copy never got a
chance to replace it because history was only restored into an empty channel.

The stored thread now wins whenever it holds more than the channel does and holds everything the
channel already shows. A message typed while history is still loading is not in the store yet, and
a run still streaming has messages the store has not seen, so neither is rolled back.

### The transcript stays with the question when an answer starts arriving

Sending a message carried it up to the top of the view, correctly, and then the Bot's first token
threw the conversation back to its very first message, with the answer being written several
screens below the fold. It happened on every turn, from wherever the reader happened to be
scrolled, so every answer began with a scroll back down to find it. The transcript now holds the
question in place for the whole turn, and the scroll that puts it there is animated rather than a
jump — unless the reader has asked their system for reduced motion.

### A conversation started from the sidebar is recorded like one started from the home screen

The trail had a `channel.routed` row for every conversation begun in the home composer — the
coworker it went to and why, whether inferred or named with `@` — and nothing at all for one begun
from the sidebar's +, a coworker's card or its profile, which read exactly like a row that failed
to write. Picking a coworker in that To: field is now recorded the same way an `@` is.

### A browser clock that runs ahead no longer hides what a routine said

The roster line and unread dot for a channel are moved by the last report that arrived, and only
ever forwards. A browser whose clock was ahead stamped its report into the future, and then every
report from a correct clock — a routine's reply, a relayed handoff answer, another member's browser
— was dropped without a word until the real time caught up: the reply was in the thread, and the
roster never said so. A reported time is now capped at the server's own clock.

### An empty supervisor PORT is unset, not an ephemeral bind

`PORT=` left blank in compose or a `.env` used to reach `Bun.serve` as `NaN`, so the supervisor
bound a random port while the published mapping still pointed at 4300. Empty now means the default
4300; a non-numeric or out-of-range value refuses to start instead of binding port 30 from a typo
like `30o0`.

### Tool arguments and results are redacted in the audit trail whatever their spelling

The sensitive-key list redacted `tool_result` and `tool_arguments` but not `toolResult` and
`toolArguments`, which is the spelling MCP and computer tool calls use. Those payloads were stored
verbatim in `audit_events.payload`, nested ones included, while every other sensitive key already
carried both spellings. New rows are redacted; rows already written are not rewritten, so a
deployment that has been running MCP or computer tools still holds unredacted arguments and results
in its existing trail.

### An IPv6 address listed in `AGENT_ENDPOINT_ALLOWED_HOSTS` is now actually allowed

A bracketed IPv6 host was normalised one way when the list was read and another way when an endpoint
was checked, so the two could never match: `[::1]:8080` became `::1]:8080` on one side and
`::1:8080` on the other. Registering a Bot at a listed IPv6 address was refused as a private
address anyway. IPv4 was unaffected.

### An empty `PORT` no longer starts the server on a port nobody asked for

`PORT` and `SERVER_PORT` name one number, and either is meant to move the server. A `PORT` that was
declared but empty — a compose file passing a variable the host never set, or `PORT=` left in a
`.env` next to a `SERVER_PORT` that was set — was read as "set to nothing": `SERVER_PORT` was
ignored, the number parsed to `NaN`, and the server came up on an ephemeral port while everything
that polls `SERVER_PORT` reported it had never started. An empty value now counts as unset, the way
every other setting already treats it, and a value that is not a whole port number (`30o1` used to
start the server on port 30) refuses to start instead.

### `TRUSTED_ORIGINS` falls back to the port the app is actually served on

Unset, it fell back to `http://localhost:3000`, while the app is served on 3010 everywhere else in
this repository. `appUrl` reads the first trusted origin, so a deployment that left the variable
blank built OAuth redirects against a port nothing was listening on.

### Coworkers are made in a wizard and managed in a dialog

Creating a coworker is now a three-step wizard — who it is, who may see it, then where it runs,
with **Built in** offered only when the deployment actually has a managed Bot to run it on.
Managing one is a dialog opened from wherever the coworker appears, with sections for its profile
(each field edited in place), what it may reach, its connection, handoff grants, routines, and the
hide/duplicate/delete verbs — usable on a phone, where the old side panel hid most of this. The
panel beside a conversation slims down to who-you-are-talking-to plus two buttons: start a new
channel, or open that dialog.

### Routines live on each coworker

The sidebar's global Routines entry is gone; a coworker's routines are a section of its own dialog,
since a routine is something *it* carries out. The `/routines` page still answers direct links.
Each routine row now wears its state as chips — the channel it posts to, how the last run went, and
either the next run, **Paused**, or **Due** when a firing is waiting on the sweep (which used to
render as "Next 5 hours ago").

### A built-in coworker is no longer asked for credentials it will never need

A coworker running on the deployment's own Bot was nagged for a callback token and shown an
endpoint form. Its connection tab now says what is true — it runs here, nothing to connect, nothing
to authenticate. In the same spirit, the handoff panel explains once when a coworker cannot hand
work on (it runs as its own agent, outside this deployment's loop) instead of offering switches the
server can only refuse; its existing grants stay visible so they can still be revoked.

### A conversation is given a name of its own

A channel was labelled with the names of the Bots in it, so every conversation with the same
coworker read the same on the roster, and the only thing telling two of them apart was a preview of
whatever was said last. That preview is usually the tail of an answer, which says nothing about the
question that prompted it. Once a conversation has an opening exchange, the deployment's own model
is asked for a few words naming what it is about, and the roster draws those words in place of the
preview. A deployment with no model key configured names nothing and looks exactly as it did before.

### A channel stops showing a working indicator once its turn has ended

Sending a message and then opening another channel before the reply arrived left the first channel
showing three bouncing dots on the roster, and they stayed there after the answer had landed and
been drawn into its preview, until the roster was refetched for some unrelated reason. A person's
own turn is reported by the browser, because the server is not told when one begins, and that
reporting was keyed on state belonging to the channel screen: opening another channel replaced the
screen, and the replacement reported the channel it had just opened rather than the one still
working. The report now belongs to the turn instead of to the screen, so the channel that was
running is the channel told when it stops. Opening a channel also no longer announces that it is
idle twice before anything has run in it.

### A hop the boundary refused now names the Bot that was refused

The audit page renders its Bot column from `payload.bot` and nothing else. `agent.handoff_offered`
and `agent.handoff_delivered` were given that key; the four rows either side of them — a hop
refused, a hop retried, and a hop that failed for good — were not, so they showed a dash where the
Bot belongs. Those are the rows somebody actually opens the trail for: a hop that happened is visible
in the transcript anyway, and a refused or lost one is visible nowhere else. All four now name the
asking Bot, exactly as the accepted pair and `agent.escalated` already did.

### A failed tool refresh no longer leaves a connector offering nothing

Refreshing a connector's tools replaced the list with a delete and then an insert, as two separate
statements. Whenever the second did not land — a pod killed mid-refresh, a dropped connection, or a
server answering `tools/list` with the same tool name twice, which the table refuses — the delete had
already committed on its own. The table is shared, so every replica lost that connector's tools at
once, every grant an administrator had made was silently un-offered, and the Bot was told it holds
none of that vendor's tools. Nothing brought them back until somebody read the error on the Plugins
page and pressed Refresh. The two statements are now one, so a bad refresh is recorded and the tools
already held are left alone, which is what the code always claimed to do.

### A rule tried in dry-run now says what it would have refused a Bot's tools

`dry-run` exists so a boundary can be measured against live traffic before it starts refusing
anybody. It worked that way for the browser, and not for connectors: a tool call the rule matched was
recorded only as the call that then went out, so `Blocked` on the audit page — and any query behind
it — answered "this rule would have refused none of them" about calls it would have refused. A rule
about `mcp.server`, `mcp.tool` or `mcp.effect` therefore looked inert, and enforcing it started
refusing Bots with nothing in the trail to have warned anybody. A refused tool call is now recorded
whatever the mode does with it, carrying `carriedOut` so a reader can tell a call this deployment
stopped from one dry-run recorded and let past. Enforcing deployments behave exactly as before.

### A policy dry-run no longer counts a failed action twice, or invents a change it did not make

Testing a boundary against recent history replayed three kinds of audit row, and one of them is a
duplicate: a permitted action that fails is recorded both as the decision that allowed it and as a
separate failure row, so every failed action was scanned and scored twice. Worse, a dry-run policy
carries a refused action out, so a refused action can fail too — and its two rows disagree, the
decision row saying "refused" and the failure row reading as "allowed", so a candidate policy that
refused it identically was reported as a new refusal it never introduced. The replay now scores each
action once, from the row that recorded its decision.

### A message no longer routes to a specialist because a longer word contained a connector's name

When the intent router falls back — it is unreachable, or it declines — and exactly one coworker can
reach a system the message names, the message goes to that coworker. The name was matched as a bare
substring, so "how do I deal with a slacker" matched the **slack** connector and "una jirafa" (a
giraffe) matched **jira**: a message naming neither system was pinned, for the life of the thread,
to a specialist that could not answer it. A connector's name now has to appear on a word boundary,
so a system named on its own still routes and one buried inside another word does not.

### The audit page no longer says "Allowed" about six kinds of refusal

A hop one Bot was not allowed to make, an endpoint this deployment would not dial, a rotation the
vault refused and a sign-in it turned away were all drawn as **Allowed**, in the muted colour every
ordinary row uses, and none of them appeared under **Blocked**. The same for a hop that ran out of
attempts and a question that reached nobody, which are "Did not happen" rather than allowed. The
page recognised six refusal types and the six added since were never added to it. Refusals now read
as refusals, the two saved views are built from the same lists the rows are labelled from, and a
refusal added later is added in one place or in none.

### A conversation deleted while a server was reconnecting no longer lingers on the screen

Announcements between servers travel as Postgres notifications, which reach whoever is subscribed at
the moment they are sent and are never replayed. While a server's subscription was down — a database
restart, a failover, a rolling upgrade — every channel deletion, pin and message announced in that
window was lost, and nothing afterwards asked for it again.

The browser could not notice. Its own connection to the server stayed open throughout, so the
refetch it already does when that connection comes back was never triggered, and the roster went on
showing a conversation that had been deleted until the page was reloaded.

A server now tells the browsers it is holding to refetch when its subscription is re-established.
Nothing to configure, and no change for a deployment whose database connection never drops.

### A Bot can answer with a picture instead of describing one

Ask for a chart and a Bot replied in prose, or handed back a fenced block of HTML for somebody to
read instead of look at. Set `OPENBOT_GENERATIVE_UI=true` and it may answer with an interface it
writes itself, drawn in the transcript. Off unless asked for, and deliberately so: it runs code a
model wrote, so a deployment acquires the capability by choosing it rather than by upgrading.

### The sidebar collapses, and the roster is reachable on a phone

The sidebar could always collapse, but nothing in the app ever drew the trigger. The only
affordance was a 16px transparent rail carrying `tabIndex={-1}`, which the eye could not find and
the keyboard could not reach. Below 768px that same sidebar becomes a sheet whose open state starts
false, so with no trigger the roster was unreachable on a phone, and the roster is how you reach a
channel, Skills, Agents and your own account. There is now a toggle in the header each screen
already draws, with Cmd/Ctrl+B on it, and the collapsed choice survives a reload: the state was
written to a cookie that nothing ever read back. Fifteen screens that previously drew no header bar
gain 40px above their heading, because the toggle has to sit at the pane's edge.

### A button drawn as a link answers the keyboard and announces itself

Six controls navigate rather than submit, so they render a router link through the shared button:
New skill, New agent, the sidebar's new-channel control, two empty-state returns, and the back
button that draws on five routes. Base UI was told each was a native `<button>`, so it wrote
`type="button"` onto an anchor, where it means nothing, and skipped the two things a non-button
needs: the `role="button"` that tells a screen reader what the control is, and Space-key
activation, which a `<button>` gets from the browser and an anchor does not.

### A Bot's answer comes back to the conversation that asked

**This reverses what 0.0.5 shipped.** The 0.0.5 notes below say the asking Bot does not relay text
on the addressed Bot's behalf, and the answer lands in that Bot's own conversation. In practice
that meant reading the answer somewhere you never asked anything, so it is now the other way
around: the addressed Bot works in a scratch conversation nobody is shown, and the asking Bot
relays what came back — attributed by name — into the conversation you are watching. What you read
is the asking Bot's account of the answer rather than the answer verbatim; very long answers are
clipped to keep the relay itself from failing.

### Channels say when a Bot is working in them

A channel whose Bot is mid-turn shows a working indicator on its roster avatar — including turns no
browser started, such as a handoff running on the server or a routine. An open conversation also
picks up turns that arrived while nobody here streamed them, so a relayed answer appears without
leaving and coming back.

### First sign-in gets an onboarding wizard

A new person lands in a short welcome wizard before the app; everyone who signed in before this
upgrade is stamped as already onboarded by the migration and sees nothing.

### Shift+N starts a new chat from anywhere

Bound across the signed-in app, shown under **Settings → Keyboard shortcuts**, and inert while you
are typing in a field. Handoff work is also picked up the moment it is queued rather than at the
next poll, so an answer's round trip no longer pays up to two seconds per leg.

### A Bot's shell can no longer reach the embedded database without a password

In the all-in-one image the cluster was `trust`-auth on loopback, and the Bot's shell runs in the
same container: it could `psql -h 127.0.0.1 -U openbot` with no password and read the audit trail,
the policy store, and the credential vault as the instance owner. The cluster now uses
`scram-sha-256` with a password generated on first init and kept beside the data, handed to the API
over the container environment. The shell has no way to learn it, so the connection is refused. An
external `DATABASE_URL` deployment is unaffected.

### A live screen that ends says so, instead of freezing the last frame

When a Bot's live screen ended — the computer stopped, or the socket failed — the message explaining
why was drawn only by a component the take-the-wheel view does not mount, so the screen sat frozen on
its last frame with nothing said. The reason is now shown where the live screen is.

### A Bot's browser drops the automation flags a person needs gone to sign in

The browser announced itself as automated (`navigator.webdriver`, the enable-automation switch),
which sites like Google refuse even when a real person has taken the wheel. Those flags are now off
at the source — the browser flag, not a script that patches `navigator.webdriver` and leaves the
other tells. A headless build still reports `HeadlessChrome` in its user agent, which only running
headed under a virtual display removes; that heavier change is tracked separately.

### An empty model reply, or a run with no question, no longer ends in silence

Two failures on strict OpenAI-compatible providers (z.ai GLM, Anthropic): a follow-up run that
carried only tool deltas and no human turn was refused outright, and a reply with no text and no tool
call ended the run with nothing on screen. A run with no human turn now carries a neutral
continuation, and an empty reply ends on a visible line rather than in silence. OpenAI, which
tolerated both, is unchanged.

### Embedded PostgreSQL initialises on a platform volume, and says so when it cannot

`EMBEDDED_POSTGRES=on` could not create its cluster on a platform whose persistent volume is an ext4
mount — Railway, and by the same mechanism most others — and it failed differently depending on where
the volume was mounted. Neither of the two paths this repo suggested worked, and the two suggestions
disagreed with each other: `docs/deployment.md` said `/var/lib/postgresql/data`, the `Dockerfile`
comment said `/var/lib/postgresql`.

Mounted at the parent, the mount arrives owned by root, `data` is not in it, and the image's
build-time `chown` is hidden underneath — so `initdb`, which has already dropped to the `postgres`
user, cannot create the directory. `postgres-init` now creates and chowns it first, as root, which is
the only step in a position to. This also fixes the plain
`docker run -v openbot-data:/var/lib/postgresql` case, which relied entirely on that hidden chown.

Mounted directly on the data directory, the mount arrives holding a `lost+found`, and `initdb` will
not initialise into a directory with anything in it. **The documented mount is now the parent,
`/var/lib/postgresql`**, which leaves `data` an ordinary subdirectory — what PostgreSQL's own hint
asks for, and what the `Dockerfile` already said. A volume already mounted at
`/var/lib/postgresql/data` and working — a Docker named volume, which arrives empty rather than with a
`lost+found` — keeps working and needs no change.

**The failure said nothing useful.** `api` waits on `postgres` and `migrate`, so neither started, the
container came up anyway, the platform reported the deploy a success, and the public URL served a
persistent 502 with the real reason visible only in the container log. A data directory that holds no
cluster and is not empty is now refused with a sentence naming the mount to use instead.

Reported by [@jerelvelarde](https://github.com/CopilotKit/OpenBot/issues/269) with the container logs
for both mount paths, which is what made the two failure modes separable.

### Turning on network policies no longer leaves the culler pod open

`networkPolicy.enabled` rendered policies selecting the server and the computers. The culler
CronJob's pod carries `component: culler` and was selected by neither, and a pod no policy selects
keeps the cluster default rather than being denied. So the switch fenced the API and the computers
and left open the one pod that wakes every five minutes carrying the API's whole environment,
`KEY_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` included, with a token allowed to create, patch and
delete Sandboxes. It has a third policy now, narrower than the other two, and
`networkPolicy.cullerExtraEgress` narrows its database egress separately from `extraEgress`. A
render that leaves any pod unfenced is refused by the chart checks.

### A sign-in a site opens in a new window is shown, and can be clicked

A Bot's browser was bound to the page it launched with, and to nothing the site opened afterwards.
Anything arriving in a new window or tab was invisible on the live screen and unreachable by input,
so the popup sign-ins that a person takes the wheel to complete were exactly the ones they could not
complete. Worse than invisible: a click at the place the popup's button was drawn went to the page
underneath it, so a person trying to finish a sign-in could navigate the page the Bot was working on
without seeing either result.

The browser now follows the window the site opens, and returns to the opener when it closes, which is
what a sign-in popup does when it succeeds. A snapshot taken before the change of page is refused
afterwards with the same "take a new snapshot" it already gives after a navigation, so a stale ref
cannot act on the wrong document.

Nothing to configure.

### Stopping a Bot's computer stops it, and the person watching is told

A computer somebody stopped came back up on its own about a second later, and reset did the same. The
live screen kept a loop asking for the Bot's current page once a second, asking for a page is what
starts a browser, and nothing tore that loop down when the browser it was showing went away. The same
loop kept the browser marked recently used, so a Bot with somebody watching was also immune to the
idle timeout and came straight back after being closed to stay under the cap on running browsers.
Those last two never involved a request at all, so nothing on the stop path could have covered them.

Two smaller failures went with it. A person who reconnected, leaving their old window open, could
have that old window's typing land in the page the new one was watching, with nothing said to either.
And a window closed while the browser was still starting left a screencast and its loop behind for a
connection that had already gone.

The screen is now held per connection rather than per Bot, so closing one only ever ends its own, and
teardown hangs off the browser closing rather than off the two requests that ask for it. A viewer
whose screen ends is sent a message saying why, whether the computer stopped, was reset, or the
screen was taken over by another window.

Nothing to configure, and no change for a deployment where nobody watches a Bot work. **The app does
not yet show that message**: it arrives at the browser and is held in state the live screen does not
read, so a person still sees the last frame until they reopen the screen. That half is tracked
separately in #287.

## 0.0.5

### One Bot can hand work to another, and reach a person when no Bot will do

A Bot asked something it is not the right Bot for can now put the question to one that is. The
addressed Bot answers **as itself, in its own conversation**, with its own tools and its own
knowledge. The asking Bot does not relay text on its behalf, so what you read is the answer that
Bot actually gave rather than another Bot's summary of it. *(Reversed since: see Unreleased — the
answer is now relayed back into the conversation that asked.)* The asking conversation records
that the question was put and to whom. A Bot that judges no other Bot will do can instead reach
the person who asked it.

**No Bot may address any other until an administrator says so.** Which Bot may reach which is an
ordinary grant, made per Bot on that Bot's own screen under **Bots it may ask**, and a Bot with no
grant is told it cannot rather than quietly trying. The pair is directional: that list is who this
Bot may ask, not who may ask it, so letting two Bots ask each other is two switches. A Bot addressed
by a name two Bots answer to is refused and both are named, because picking one would be a guess
about which colleague a person meant.

Two ceilings, because a Bot deciding to ask another Bot is a Bot deciding to spend a run:
`BOT_HANDOFF_MAX_DEPTH` is how many Bots deep a chain may go and defaults to `1`, and **`0` switches
the capability off entirely**: the tool is not offered rather than offered and refused.
`BOT_HANDOFF_MAX_PER_RUN` is how many Bots one run may address and defaults to `3`. The Helm chart
takes the same two as `config.handoff.maxDepth` and `config.handoff.maxPerRun`.

A hop that fails is reported back by the Bot that asked, after its attempts are spent, rather than
leaving the person watching a conversation that never finishes. One rough edge to know about: a hop
that is retried leaves one "asked" line per attempt in the addressed Bot's own transcript, so a hop
that took three attempts reads there as having been asked three times.

No new tables: this uses the work queue that already fires the culler.

### A conversation that used a tool no longer stops answering for good

A channel could reach a state where every turn in it failed and the only thing it said was
`Tool result is missing for tool call call_…`. Not the turn: the conversation. Everything sent
afterwards failed the same way, including a question as ordinary as what two plus two is, and there
was nothing a person could do to it from the screen.

A tool result is matched to the call above it, and a thread read back from the platform does not
always carry the two in that order. Where the result was stored ahead of its own call, this
deployment counted the call answered, sent the history on unchanged, and the model provider rejected
the whole conversation while assembling it. Handing work to another Bot, asking a person, and
calling a connector's tool could each leave a thread in that shape.

A result now only answers a call it follows. One that arrives early is moved to sit after its call,
keeping what it actually said, and a result whose call is nowhere in the thread is dropped. Affected
conversations start answering again on their own; there is nothing to run and nothing to reset.

### The framework Bot answers on 5.6-tier models, and can be told how hard to think

Pointing `BOT_MODEL` at a `gpt-5.6-*` model gave a Bot that started, reported healthy, and then said
nothing: every run was a RUN_STARTED and a RUN_FINISHED with no text between them. Those models are
run on the Responses API, which streams content blocks where chat completions streams a string, and
the run read only the string — so every delta was dropped on the floor. Both shapes are read now.
Nothing changes for a deployment on 5.5 or on Anthropic or Google.

`BOT_REASONING_EFFORT` sets how hard a reasoning model thinks: `none`, `minimal`, `low`, `medium`,
`high`, `xhigh` or `max`. Unset, the model keeps its provider's default. A value the API does not
have, or one set where it cannot be sent — a provider that is not OpenAI, or a model not on the
Responses API — stops the Bot at startup with a message naming what to change, rather than starting
with a setting that goes nowhere.

### A Bot can be asked to do something on a schedule

"Every weekday at nine, post the standup notes here" is now something a Bot can be asked rather than
something somebody has to remember. A routine created this way runs under its own creator's grants —
it can do exactly what they could do in chat, and nothing more — and its reply lands in the channel as
an ordinary Bot message: it lights the unread dot the same way any other message does, and it appears
in the transcript rather than anywhere separate. A routine that fails posts one message about its
first failure and, after ten in a row, switches itself off with a final one rather than failing
forever unnoticed.

The deployment gains two tables, via migration `0021`.

**This needs a new process.** A worker fires due routines by calling this deployment's own API server,
and a deployment that never starts one schedules nothing — the routine sits on the Routines page with
a next run time like any other, and nothing on the screen says a worker is missing. `WORKER_SHARED_SECRET`
is the credential the worker presents; a deployment without it configured refuses every handoff rather
than accepting one it cannot attribute. `scripts/start.sh` runs the worker locally; the Helm chart
turns it on with `routines.enabled` and takes the secret as `secrets.workerSharedSecret`. No new port
is opened for any of this — the worker only ever calls out to the server it already trusts.

### Turn screenshots are swept in every deployment, not one

A page a Bot opens is photographed and kept in `computer_page_frame`, so a conversation read back
later shows what it was looking at. The reaper for those rows had one caller: the idle-computer
culler, which refuses to run unless each Bot has its own computer and is scheduled only by the Helm
chart's CronJob, which exists only when `computers.mode` is `sandbox`. On Compose, on the all-in-one
image, and on the chart's own default of `shared`, nothing ever called it. One browsing Bot over
ninety days is several hundred megabytes of rows that nothing was ever going to remove.

The sweep now runs on the server, on the same hourly timer that removes old audit rows, and does not
wait for a retention policy to be configured: a month of screenshots is what the store already meant
to keep. It also removes them in batches, because one statement over that much data held its locks
for seventeen seconds.

Deployments using `computers.mode: sandbox` are unaffected in what they keep. The culler no longer
purges frames, because the server does it there too and one owner is better than two.

**On upgrade, the first sweep removes the backlog.** A deployment that has been keeping every
screenshot since it was installed will lose the ones older than a month, about a minute after the
server starts. That is the window the store has always documented and the one sandbox deployments
have been enforcing, but it has never been applied anywhere else, so it is worth knowing before the
upgrade rather than after. It is drained in batches, forty thousand rows an hour, rather than in one
statement.

### A channel a Bot has spoken in unseen shows a dot

The sidebar marks a channel when a Bot has said something since you last had it open: a dot beside
the preview, the name a touch heavier. Opening the channel clears it, your own messages never set
it, and the channel you are looking at never shows it. The marker is yours alone — per member, on
the membership row like the pin — so one person reading does not clear anybody else's dot.

The deployment gains one nullable column, via migration `0019`.

### The API can reach Intelligence and sign-in when a NetworkPolicy is on

`networkPolicy.enabled` wrote a rule for the API server that named DNS, the database and the Bots'
computers, and nothing on 443. On a cluster that enforces policy the server could therefore reach
neither CopilotKit Intelligence, nor an identity provider, nor a Bot: nobody could sign in and no
conversation ran. Two of the five shipped `ci/` targets turn the policy on, and on GKE enforcement is
the default and cannot be switched off.

Nothing said so. The pod passed every probe and stayed Ready, because `/health` answers from a
literal, so the first evidence was a timeout to a hostname that read as the internet being down.

The API now reaches HTTP and HTTPS everywhere outside the cluster's private ranges, in every
`computers.mode` rather than only `sandbox`, cut by the same exception list the computers' own policy
uses. It still cannot address another pod, a node, or a cloud metadata endpoint.

`mode: sandbox` had been working only because a rule meant for the Kubernetes API server carried no
destination and so permitted everything. That rule now covers the API server alone, and
`networkPolicy.kubernetesApiCidr` narrows it to your cluster's service range; left empty it stays as
it was, because a chart cannot know that range.

### Taking the wheel stops the Bot's shell, not just its clicks

While a person held the wheel the Bot was refused on the page, and not in the shell. `/exec` and a
workspace write went through, so a Bot could keep running commands and rewriting its `/workspace`
underneath somebody who had taken the browser at a login wall. The guard existed and covered
navigation and the four page actions; the shell arrived later and was never wired to it.

Every acting path now asks the same question in one place, so the property the documentation states
is the property the computer has. Reading is deliberately not acting: `/files/read` and
`/files/list` still answer while a person drives, because a Bot that has just been stopped still has
to be able to say what it was doing.

Nothing to configure. A Bot that acts during a takeover gets the refusal it already got for a click,
and the trail records the attempt and the failure the same way.

### A computer that was suspended once suspends again

Scale-to-zero worked once per Bot. A computer suspended, resumed, used and then left alone again was
offered for suspension on every sweep after that and never suspended, and stayed awake until the next
day. Nothing reported it, because a sweep that offers work and suspends nothing looks exactly like a
fleet that is busy.

The queue keys a suspension on the Bot id and keeps the finished row so that a late offer of the same
key collides with it rather than running the work twice. Both are right. What was wrong is that the
finished row was kept for a day, which is the window the other half of the sweep needs: a suspension
that keeps failing is held back that long before anything tries it again. One number could not be
both, so there are now two, and a finished suspension is kept for the idle window instead. That is
the same clock the offer runs on, so a Bot cannot come back round as idle until its row has gone.

Nothing to configure, and the sweep already runs on a schedule. A deployment where each Bot has its
own computer stops paying for browsers that were used once.

### A Bot's egress proxy is reachable on Kubernetes, or the install is refused

The chart named no egress variable anywhere, so a Helm deployment read the per-Bot proxy settings
nowhere and every Bot went out directly. They were always settable through `computers.extraEnv`,
which reaches the computer in both the shared and the sandbox arrangement, but nothing in the chart
or its README said so, and a setting whose whole purpose is to give a security team a per-Bot
address is not one to leave undocumented.

The other half is that setting it was not enough. A computer is allowed 80 and 443 to public
addresses and nothing else, which is almost no proxies: they sit on a private address, or on 3128 or
8080. So a proxy the network policy provably blocks is now refused at `helm install`, naming
`networkPolicy.computerExtraEgress`, rather than found later as a Bot that fails on every page.
Nothing changes for a deployment that sets no proxy, or one that already opened a path to it.

### A finished turn shows the page it opened, not the one open now

Reopening a conversation made every past turn fetch the screen as it is now, so an answer about
Hacker News from an hour ago sat under a picture of whatever the Bot had open since.

A page is now photographed where it is opened. The server takes the frame the moment a navigation
succeeds and keeps it in `computer_page_frame` under the computer and the address, which is the one
moment the screen is certainly showing the page that was asked for. Reopening the conversation shows
that frame rather than the live screen, and a turn with nothing kept names the page instead of
drawing the wrong one.

The surface used to capture it itself once the turn went quiet, and that is a race it cannot win: a
reopened turn and one that has just finished are indistinguishable from inside the component, the
same computer is driven by other conversations in between, and a resumed computer starts blank. It
filed pictures of pages the turn never opened, or none at all. It only reads now.

**Redeploy the computers with the server.** A screenshot only says which page it is of on an
`agent-computer` built after that field was added, and this is what decides whether a frame is kept.
Where each Bot has a computer of its own there is nobody to race with, so an old computer's picture is
accepted and the feature works through a rollout. On ONE SHARED COMPUTER it cannot be: another Bot's
navigation lands between the navigation and the picture, and a frame that cannot be told apart from
theirs is refused. So a shared-computer deployment that updates the server and not the computer keeps
no frames until it does, and says so in the server log each time rather than leaving somebody to
wonder.

Two things followed from making a past turn a record. Its placeholder is decided by the turn being
over rather than by whether a live frame happens to be in hand, because a tile that was live a moment
ago keeps its last screenshot and used to fall through to "Waiting for the assistant's screen…" and
wait there for ever. And opening one full size shows that same kept frame, with no live stream and no
wheel: zooming a past turn used to mount the socket and offer Take control, so the one gesture for
looking closer at what a turn did replaced it with whatever the Bot has open now.

### A conversation keeps the browsing that produced its answers

Every turn in which a Bot used a tool was disappearing from the transcript on reload. The sentence
the Bot wrote stayed; the browsing that produced it did not, the inline screen went with it, and the
footer said some messages could not be read.

The history store writes a tool call as `{id, name, args}`. AG-UI describes
`{id, type: "function", function: {name, arguments}}`. The reader validated against the second,
treated the first as damage from an interrupted run, and dropped it. It is not damage: it is how
every tool call is stored, so what looked like a guard against one bad turn was deleting all of the
real ones. Observed on a live thread where every browsing turn was counted unreadable and every one
of them was well formed in the store's own dialect.

The two spellings are now read as the same thing. The check stays for turns that really are
malformed, and a mixed or unrecognised array is still refused rather than half-translated, because a
reader that rewrites what it does not recognise is worse than one that refuses it.

### Run this on Kubernetes

A Helm chart under `charts/openbot`, Bots and all, and the fixes that installing it for real turned
up. Proven on a real EKS cluster: five workloads, replicas across two nodes, EBS volumes bound, and a
Bot opening a real page from inside AWS with the decision in the audit trail.

One chart, five targets: EKS with a shared browser, EKS with a computer for each Bot, GKE, AKS and
somebody's own cluster, with nothing but values between them. There is no cloud branching in any template. Every place the clouds genuinely differ is a
value whose default is what a plain self-hosted cluster does: the cluster's own default StorageClass,
no RuntimeClass, a plain Kubernetes Secret, an Ingress. Identity is one `serviceAccount.annotations`
map, which is all IRSA, Workload Identity and AKS workload identity are. Secrets are a plain Secret
by default and an ExternalSecret against any backend when asked, so Secrets Manager, Secret Manager
and Key Vault are a values block rather than three code paths. Gateway API is supported beside
Ingress rather than instead of it. `charts/openbot/ci` holds a values file per target.

Two replicas by default, because horizontal is the point and one replica hides every bug that is
not. A bad install is refused at `helm install`, naming the value to change, rather than discovered
in a crash loop: no database or two of them, nobody who could sign in, nobody who would be an
administrator, a key of the wrong shape, both routers enabled, or a browser asked for inside more
than one replica.

**A Bot's computer is not in an API pod.** The image runs one beside the API so that a single
container works on its own, and `EMBEDDED_COMPUTER=off` turns it off. A replica must not carry a
browser: it is a few hundred megabytes holding one Bot's logins, so scaling the API would scale
those with it.

**Migrations no longer need a development tool.** `bun x drizzle-kit migrate` cannot run in the
shipped image at all. The CLI reads a TypeScript config, which needs the esbuild that
`bun install --production` correctly leaves out, so it printed "Reading config file", exited 1 and
said nothing else. `EMBEDDED_POSTGRES=on` was therefore starting a container whose database was
never migrated, and the first symptom was the API reporting that `users` does not exist.
`server/scripts/migrate.ts` uses the migrator inside `drizzle-orm`, which is a runtime dependency
already, and keeps the same journal, so a database migrated by either tool is migrated.

**A computer for each Bot, suspended when idle.** `computers.mode: sandbox` gives every Bot its own
browser as a `Sandbox` from `kubernetes-sigs/agent-sandbox`, which is built for this workload: an
isolated, stateful, singleton pod with a stable identity and persistent storage. Suspending is one
field, and it keeps the volumes, so a computer comes back with its logins rather than signed out of
everything. `shared` stays the default and needs nothing installed in the cluster.

**The NetworkPolicy would have fenced the API off from its own work.** Its egress named DNS and the
bundled database and nothing else, so on a cluster that enforces policy the API could not have
reached a Bot's computer or, with a managed database, the database. Both are allowed now, and turning
the policy on with an external database and no rule for it is refused rather than shipped. Worth
knowing either way: EKS runs its CNI with `--enable-network-policy=false`, so a policy there installs,
looks right, and does nothing at all.

**A cluster with no controller is refused at install.** `computers.mode: sandbox` needs the
agent-sandbox CRD, and without it the install succeeds, every pod is healthy, and the deployment
looks finished until the first Bot asks for a browser. The chart reads the cluster and refuses,
naming the one command that fixes it.

**What decides a computer is idle is the audit trail, not the browser.** Asking the browser would
wake it, so every computer anything asked about would come back up and the bill would never fall.

**Durable work, claimed by whichever replica gets there first.** `work_items` plus
`select ... for update skip locked` and a lease: no coordinator, no leader election, and a replica
added is throughput added. The idle-computer culler is its first user; scheduled routines and
hand-offs between Bots are the other two, which is why it is written once rather than three times
slightly differently. A CronJob runs the sweep, because a timer in the API fires in every replica and
suspending a browser somebody just started using is not something to do five times.

**Which run of a computer this is, across a suspend.** A resumed browser counts snapshot
generations from one again, so a ref the model still holds from before the suspend would match a row
nothing has overwritten and the boundary would decide about an element on a page that no longer
exists. The first answer here used the node and the pod address, and resuming a real computer
disproved it: a suspended sandbox is very often rescheduled onto the same node and handed the same
address back, so both were identical across a suspend and resume and the check would have said "same
run" for the exact case it exists to catch. It reads the `Ready` condition's transition time instead,
which moves every time a computer starts serving again.

**Which run of a computer this is, on more than one replica.** `sessionOf` answered from a map in
the process that started the computer, which is right until there are two: the replica that took a
snapshot is usually not the one handling the click, and the second had nothing to answer with. An
unknown session means "no opinion" and skips the generation check, so on exactly the deployment
shape it was written for, the check that stops a ref from a replaced computer resolving against a
live one was silently absent. It now asks the supervisor when it does not know, by listing rather
than by ensuring, so asking never starts a computer that had stopped.

### A routing trail says why a message was not routed, not only that it was not

Every untagged message writes a `channel.routed` row, and that row carried `fallback: true` for two
completely different situations: the router answering honestly that no specialist was a confident
match, which is the feature working, and the router not answering at all, which is an endpoint that is
down. Both read identically, so a deployment whose router had stopped working looked like one whose
messages were simply hard to route.

That is not hypothetical. The intent router spent an unknown period 404'ing on every deployment that
set `OPENAI_BASE_URL`, because a `/v1` was appended to a URL that already had one. It was fixed in
0.0.3, whose own note says untagged messages "silently stopped being routed and nothing said why".

The row now carries `undecided`, naming the cause: `unreachable`, `unparsed`, `off-roster`,
`unconfident`, or `one-candidate` — and `null` when the router did decide. Named values rather than a
sentence, because the useful question is how often, and a count needs something to group by.

Two smaller corrections came with it. A message routed to the only coworker that can reach the system
it names kept that as its reason and threw the cause away, so a router that had been down for a week
produced rows reading like reach-based routing working as intended; the cause now survives that path.
And an answer containing no JSON at all — a model replying in prose — was recorded as the router
naming a coworker off the roster, which sends whoever reads it to look at their roster rather than at
the model. It is now reported as unparsed, which is what it is.

Nothing changes about where a message goes. Every routing decision is the same decision it was.

### Notion joins the connector catalogue

Notion is now a governed MCP connector, reached through Notion's own hosted server on the
catalogue's default transport, as the person asking — the same grant, policy and audit machinery
Google Drive already runs through. Unlike Drive, it ships both read and write tools from the start;
the writing ones are named in the catalogue, and an advertised tool absent from that list classifies
as a read — so reconciling the write-tool names against what Notion's hosted server actually calls
them, on the first Refresh tools, is required, not cosmetic. A tool the server never advertised at
all still classifies as a write, same as any other connector.

There is no client to register: this deployment introduces itself to Notion on first connect. That
shortens setup but does not finish it — unlike Drive, whose tool list is this codebase's own code,
Notion's tool list is an answer from Notion's hosted server, so a deployment has recorded none of it
until Refresh tools has run at least once; and, like every other connector, a Bot gets nothing until
its tools are granted to it. Setup is enable at `/admin/plugins/notion`, connect an account at
`/settings/connected-accounts`, refresh tools, then grant — a bulk **Grant tools…** dialog on
`/admin/plugins/notion` grants a batch of tools to a batch of Bots in one pass, one grant and one
audit row per Bot per tool. No migration.

### Refresh tokens rotate in place, and replicas take turns spending them

A vendor that rotates refresh tokens invalidates the one it just handed out, so two replicas racing
to use a stale token would have the loser refused, or worse: a rotating vendor's reuse detection can
read that as a stolen token and revoke the whole connection. Every plugin call that mints an access
token now locks the credential's vault row for the length of the exchange, so a second replica waits
rather than races, and the rotated token is written back in the same transaction that held the lock.
Nothing to configure; a connection just stops going stale under concurrent traffic.

### An MCP token is spent only by its own server, and only at the address it was given

Pointing a server at a credential is the one place this deployment takes a reference to a stored
secret rather than the secret itself. Everywhere else, the value was typed into the same request that
stores it: a Bot's key is minted from what an administrator pasted and the id it gets is nobody's to
choose. So this is the one field where which secret and which address could be made to disagree, and
the add settles the disagreement by spending the credential: the tool refresh runs before the call
returns and sends what it decrypts to the URL from that same request.

Two ways they could disagree, and both are now refused. A server could be pointed at any `mcp`
credential in the vault, including one minted for a different vendor, so a token given to one server
was deliverable to another. And re-adding a server with a different URL rewrote the address while
keeping the credential, so the same token could be sent somewhere else entirely with no
cross-server trick at all: the token really did belong to that server, and only the address moved.

The second is why the first was not enough on its own. A credential now has to belong to the server
it is attached to, and a server that already holds one cannot be re-added at a different address.
Correcting a title or retrying an interrupted add sends the same URL and is unaffected. A server
holding no credential can still be re-addressed, because there is nothing to misdirect. Moving a
server that does hold one means removing it and adding it again with the token the new address is
meant to have, which is the honest description of what has happened anyway.

This matters more than "an administrator could misconfigure something". A stored credential cannot
be read back by anybody, by design: the credentials screen answers that a credential exists and
never what it is. These two shapes were the way around that, so a deployment where somebody has
used them should treat the credentials involved as disclosed and rotate them.

A token also stops outliving the server it was minted for. Re-adding a server without naming a
credential used to clear the pointer while leaving the credential live, and removing a server retires
its token by reading it off that pointer, so a cleared one meant the token survived its server and
could be attached to a freshly created one at any address, where there was no longer a stored address
to compare against. Three ordinary acts in a row and the binding above stopped meaning anything. The
pointer now survives a re-add that names none, removal therefore finds and retires it, and a retired
credential is refused rather than quietly attached to fail on its next call.

Curated servers keep working as they did. Their URL comes from the catalogue rather than the
request, and a per-instance hostname is matched against the vendor's own anchored pattern before
anything is stored, so re-adding one cannot point it at an address of the caller's choosing.

### A configured egress proxy reaches the browser that uses it

`EGRESS_PROXY_DEFAULT` and `EGRESS_PROXY_<BOT>` were documented as the way to give a Bot a stable
outbound address, and Compose passed neither to anything. `docker-compose.yml` named no egress
variable and had no `env_file`, so the shared computer resolved every Bot to no proxy and went out
directly, and under the supervisor the same emptiness meant there was nothing to forward into the
computers it creates.

The failure was silent, which for a setting whose purpose is to give a security team a per-Bot
address for network rules is the worst of the available failures. The stack started, the browser
left by the host, and the Computers screen reported "Leaves directly" because it was reading the
same empty environment.

They now live in `egress.env`, which both the computer and the supervisor are given. A file rather
than more `environment:` entries because `EGRESS_PROXY_<BOT>` is derived from a Bot's id and there
is no fixed set of names to list; a file of its own rather than `.env` because that one holds the
deployment's secrets and the container running a browser and a Bot's shell is deliberately not
given them. It is optional, so a deployment with no proxy is unchanged, and gitignored, because a
proxy URL can carry a password.

**Move these two out of `.env` and into `egress.env`.** In `.env` they reach no process.

### Screens without a conversation stop polling for a Bot that does not exist

Every surface asks which components its Bot holds, and asks again every few seconds so a revoked
grant leaves an open conversation quickly. The Bot it asked about was whichever one the surface
declared — and on a screen with no conversation at all, that was the placeholder id the routing
holder falls back to, which no package registers and the server answers 404 for. An admin page left
open polled a guaranteed miss every five seconds, indefinitely.

Nothing looked wrong. The screen rendered, because an absent grant list and an empty one draw the
same. The cost was the noise: a request log where the same 404 repeats forever is one where the 404
that matters is invisible.

The grant queries now wait for a surface to declare a real Bot, and simply do not run while the
placeholder holds. Conversation surfaces — the Bot page, channels — declare one and are unchanged.

### A rule can be tested against history before it is saved

A boundary was written blind: an administrator typed a CEL rule, saved it, and learned what it
actually matches from the refusals it produced in production. The trail already records every judged
computer action with the same facts the gateway judged it on, so the question "what would this rule
have done" had an answer nobody could ask.

The Boundaries page now has **Test first** beside **Add rule**. The candidate — the current policy
plus the drafted rule — is replayed over recent recorded actions, and the reply names each one it
would have decided differently and the rule that would have decided it. Nothing is saved and nothing
is decided; no audit row is written, because no action was permitted or refused.

Replay, not simulation: the context is rebuilt from the audit row exactly as the gateway built it at
decision time, through the same helpers, so a rule behaves here as it will behave live. The scan is
bounded and biased to recency, and the reply says how many rows it covered.

### A browser refusal names the element again

Every browser context carries a neutral all-empty `mcp` object, so a rule naming `mcp.effect`
evaluates to false instead of throwing. The refusal copy keyed on that object being present rather
than on its contents, so every live browser refusal took the tool-call branch and read
":  on  is blocked" — two empty strings where the element and the page belonged. The tests passed,
because their contexts omitted the field the gateway always attaches.

The branch now keys on the server and tool being named, which a real tool call always has. A refused
click reads "“Submit order” on shop.example is blocked by the rule ..." again, which is what the Bot
relays to the person asking.

### Knowledge searches instead of guessing

A package can say which of its skills each coworker gets, and the fintech example gives Knowledge the
four document skills it ships.

Knowledge is one of three coworkers in the box, described as answering company questions and citing
sources. The skills that would let it do that were seeded attached to nobody, so every clone started
with them paired to no Bot: the per-run narrowing that skills exist for was switched off until
somebody opened the Skills page and made the pairing by hand, in each deployment, again after each
new connector. The pairing belongs with the package, which wrote both files and knows which coworker
it meant them for.

THIS GRANTS NOTHING, which is what makes it safe to seed. A skill is an instruction; what a Bot may
call is its grants, and the offer each run is the intersection of the two. A skill naming a tool its
Bot does not hold loads nothing. Seeding an MCP grant would be the opposite, because those reach a
person's own account, so those stay an administrator's decision and are untouched here.

A redeploy takes back only what the package gave. Grants it made carry `tenant-package`, and a grant
an administrator made through the Skills page keeps their name and survives, because a deploy quietly
undoing a deliberate decision is the kind of change nobody traces back to the deploy that caused it.
A coworker naming a skill its package does not ship is refused at load rather than dropped, the same
as a channel naming an agent that is not there: a typo that silently attaches nothing looks exactly
like working.

### A Bot's computer is no longer on the same network as the database

Compose declared no networks, so every service shared one and reached the others by service name.
One of those services is the container a Bot's shell runs in, and another is PostgreSQL, whose
username and password are in the same file. A shell reaches whatever its container reaches, so a Bot
could open `postgres:5432` and authenticate: the audit trail, the policy store and the agent tables,
from the one container whose job is to run what a Bot asks for. The role Compose creates is the
instance owner, so the trail's append-only trigger was no defence either, being something its owner
can drop.

PostgreSQL and `migrate`, the only service that reaches it by name, are now on a `data` network of
their own. Everything else stays where it was. Nothing changes for a deployment that runs the API
server on the host, which reaches the database through the published port and never used the shared
network for it. **A deployment that runs the server inside Compose has to join that service to both
networks**, which is the one place the two are meant to meet.

The published port is now on loopback, as every other port in that file already was. Taking the
database off the Bots' network removes the name, not the address: a container's default gateway is
the host, and a port published on every interface answers there. From inside the computer container,
the gateway on `5432` accepted a connection and began authenticating as `openbot` on `openbot`, with
the password in the same file. **A deployment that reached the database from another machine over
this port has to reach it another way**, which is what publishing it on every interface was doing.

This does not reach back in time. A deployment that has been running with the two on one network
should assume a Bot could have read or written the database, and look at the trail with that in
mind.

### A credential in an MCP server address is refused in the query and the fragment too

Refusing `https://user:token@vendor.example/mcp` closed the userinfo spelling of a credential in the
address and left the two obvious ones open. `?token=`, `?api_key=` and their neighbours were still
accepted, and the address is stored and named in the trail exactly as given: audit redaction keys on
the field name, `url` is not a sensitive one, so the secret was written to `mcp_servers` and to an
append-only audit row in clear text. That is the same disclosure the userinfo rule exists to prevent,
one character away.

A parameter whose name reads as a credential is now refused, in the query string and in the fragment,
and the refusal points at the token field without repeating what was typed. The name is read rather
than matched against a list, so `?auth_token=`, `?x-api-key=` and `?X-Amz-Signature=` are refused
alongside `?token=`: a rule that only catches the spellings somebody thought of reads as a guard
while behaving like a gap. The test is on the parameter name rather than on the presence of a query,
because vendors route and version with parameters and a floor that refused every one of them would
be one an operator works around instead of with. `https://mcp.example.com/mcp?workspace=acme&version=2`
is unaffected, and so is an ordinary fragment. A credential written into the *path* is still
accepted: it is indistinguishable from a route, and at least one hosted provider addresses servers
that way. **A deployment where somebody has put a credential in an address should treat it as
disclosed and rotate it**, for the same reason as before: the audit row cannot be deleted.

`metadata.goog` is refused too. It is Google's own short name for the metadata server, published
beside `metadata.google.internal`, and it carries a dot and none of the suffixes this check lists, so
it read as an ordinary vendor name. The long spelling was only ever refused incidentally, by the
`.internal` rule. Both are now named, so the address this check was written for is refused on purpose
rather than by luck.

### A curated MCP server is pointed at its own kind of credential too

Adding a server by URL was made to check which credential it is being pointed at. Adding one from the
catalogue, the other half of the same screen, took the same field from the same request and stored it
unread, so a credential of any kind could be attached to a curated server and spent by the refresh
that runs before the add returns.

Worth being plain about the reach, because it is narrower than the path beside it. The column is a
foreign key, so an id naming nothing was already refused by the database, and the one entry in the
catalogue is reached with each person's own Google account, whose OAuth client is registered through
its own call and sent to an address pinned in code. Nothing could be delivered to an address a caller
chose. What was reachable was a credential of the wrong kind being accepted and spent on behalf of
somebody who never agreed to it, and a malformed id arriving as a database error rather than as a
refusal.

The rule now comes from the entry: a server the deployment holds one token for takes that token, and
a server answered as the person asking takes no credential when it is added, because its client
arrives through the call that mints it. Both add paths ask the same question in the same words, so a
credential that does not exist and one of the wrong kind are still refused identically and the
endpoint cannot be used to ask which ids are real. Adding a curated server the way the admin screen
does is unchanged.

Adding a curated server that is already there no longer clears the credential it points at. The
column holds the OAuth client that registering one put there, and re-adding the server to change an
instance host said nothing about that client, but cleared it anyway: the credential row was left
behind with nothing pointing at it and nothing to revoke it, and everybody who had connected their
account was told the deployment has no client registered. A re-add that names no credential now
leaves the one that is there alone.

### Name the private addresses an agent may live at

Refusing `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` in production closed a hole and took something with
it: bring your own agent is a headline capability, a company's own agent legitimately lives at an
internal address, and the only way to reach one was to lift the floor for everything. Telling people
to set that flag is exactly the advice that made it dangerous.

`AGENT_ENDPOINT_ALLOWED_HOSTS` names addresses instead. A comma-separated list of hosts, each
optionally with a port: `agents.internal` covers any port on that host, `10.0.0.42:9000` pins that
one. A deployment sets this and leaves the floor where it is.

It is narrow on purpose:

- **Agent endpoints only.** Browsing is not widened. A page can steer a Bot somewhere; an operator
  naming an address they run is a different act from a Bot following a link to it.
- **Exact matching.** No wildcards and no suffixes. A list written with a `*`, or written as URLs, is
  refused at startup with the entry named, rather than quietly never matching.
- **The never-allowed addresses stay never-allowed.** Cloud metadata is refused before the private
  rule is reached, so naming it changes nothing.
- **Every hop, not just the first.** A named address is reachable wherever it appears and an unnamed
  one is refused wherever it appears, so a redirect is not a way around registration.

Unset means none, which is what every deployment has today.

### A custom MCP server can only be pointed at its own token

Adding an MCP server by URL takes a credential id alongside the address, and the add is what spends
it: the tool refresh that runs before the call returns decrypts whatever that id names and sends it
to the address in the same request. Nothing checked which credential it was, so an administrator
could name any row in the vault, including one person's connector token, and have that person's
token delivered in clear text to an address of the administrator's choosing, before any Bot or grant
was involved. The credentials screen lists every row's id and, for a connector token, the person it
belongs to, so choosing one was a single read.

A custom server now has to be pointed at a credential of its own kind, the deployment's token for
that server. A person's connector token and the deployment's OAuth client are both refused, for the
same reason `POST /api/admin/credentials` already refuses to create either by hand: spending one
here uses a credential on behalf of somebody who never agreed to it. A credential that does not
exist is refused in the same words as one of the wrong kind, so the endpoint cannot be used to ask
which ids are real.

The field is unchanged for the case it exists for, and nothing changes for a server added through
the admin screen, which mints a token and points at the one it just made. If a deployment has a
custom server pointing at a credential of another kind, adding it again will now be refused, and the
answer is to give the server its own token.

### A failed action is recorded the same way it was decided

An action the policy allowed and the computer then failed is recorded twice, once for the decision
and once for the outcome, so the trail can tell an action that happened from one that was permitted
and did not. The second row was leaving out the command and the key that the first one carried.

A shell command that failed part-way therefore said a Bot had run something without saying what, in
the row somebody reading an incident reaches for first. The same omission picked the wrong element
branch, so that row also claimed the command had been looked for in the page snapshot and not found
— a page element a shell call never had. A failed file write kept its path throughout and is
unchanged.

Both rows now carry the same subject. Nothing about the boundary moves: the policy decided on a
complete context before and after, and no action is permitted that was not permitted before.

### Upgrading

**A deployment that sets `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` with `NODE_ENV=production` no
longer starts.** Remove the line and it starts again. Nothing else needs changing, and a deployment
that never set it is unaffected.

The switch lets a Bot reach addresses inside the deployment's own network — `10.0.0.5`,
`192.168.1.1`, `127.0.0.1:5432`, a link-local address — and it does that in two places, not one:
browsing, and the endpoint a Bot may be registered against. It exists for a laptop, where the
services a Bot is asked to look at are the ones running beside it.

The reason this is a refusal rather than a warning is how a deployment came to have it. `.env.example`
shipped the line on, and copying that file is the ordinary way an environment gets filled in, so the
path to a hosted deployment reaching its own network was not forgetting to set something, it was
inheriting something. It now ships commented out, which means a laptop that wants the old behaviour
uncomments it and everything else arrives without it. Under any other `NODE_ENV` the switch works
exactly as before, with a warning at boot saying it does not travel.

**The one-container image shipped with the switch on, and no longer does.** It set both
`AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` and `NODE_ENV=production`, so the image really did run
with private-host browsing enabled. Two things that worked there stop: a Bot browsing a private
address such as an intranet page, and registering a coworker at a private endpoint like
`http://10.0.0.20:8000/ag-ui`. Because the image bakes in `NODE_ENV=production`, there is no
override — a deployment that needs either of those wants the compose setup or its own image rather
than the all-in-one. The image continues to start, and everything else in it is unchanged.

The cloud metadata addresses — `169.254.169.254`, `metadata.google.internal`, and the IPv6 and
NAT64 spellings of them — were refused whatever this switch said, before and after. That floor has
not moved. What changed is that it is no longer the only thing left standing in a production
deployment that copied the example.

### The supervisor answers on loopback, not on every address the host has

The supervisor's port was published without an interface in front of it, so it bound every address
the machine had and answered anything that could route to it. This is the service that holds the
Docker socket, so reaching it is root on the host by way of four verbs, and `SUPERVISOR_TOKEN` is a
shared secret rather than a network boundary. The documentation already said not to expose it
outside the deployment network; the compose file did.

It is now published on `127.0.0.1`, like the computer's own port and the two Bots'. If you reach the
supervisor from another machine, that stops working and it was the thing worth stopping: put the
caller on the host, or run the server inside the compose network, where it reaches the supervisor as
`supervisor:4300` and never uses the published mapping at all. `SUPERVISOR_PORT` still chooses the
host port.

Nothing changes for a default deployment. `scripts/start.sh` already reached it on `localhost`.

### An agent's address is checked where it ends up, not only where it starts

`checkAgentEndpoint` decides whether this deployment will dial an address, and the request was then
handed to a fetch that followed redirects. The checked address and the dialled address were the same
address only while nobody redirected. An agent answering `307 Location: http://169.254.169.254/` put
the server on its own cloud metadata endpoint, on every run rather than once.

Every hop is now checked before it is followed, capped at three. Redirects are still followed,
because a deployment that puts its agent behind one has done nothing wrong, and each destination has
to be somewhere registering it directly would have been allowed to reach. The stored address is
checked before it is dialled too, which is the one address a check reading only `Location` headers
never looked at.

A hop that leaves the host the request was authorised for arrives with nothing that proves who we
are. The customer's key was given to us for their host, and this deployment's signed run assertion
names the Bot and the person and can spend their grants, so both stop at that boundary and do not
come back if the chain returns. A scheme upgrade to the same host and port keeps them.

Refusals are now on the audit trail as `agent.dial_refused`, with the address and the reason. A
refused run already told the person what happened; nothing told the deployment, and an agent that
has quietly started redirecting somewhere it should not is worth being able to count.

### A connector says which of its granted tools it no longer offers

A grant names `serverId/toolName`, and a Bot is told about a tool only when the grant and the vendor's
current tool list agree — so a grant on a tool the vendor has stopped listing reaches no model. That
is a property of what the vendor advertises today rather than of the grant, and nothing said it was
happening: the plugins page built its grant list from the advertised tools, so such a grant appeared
nowhere at all. The one screen an administrator reads to answer "what may this Bot do" was quietly
leaving some of the answer out.

A connector's page now has a "Held but not offered" section listing them, with how many Bots hold
each, and a refresh that leaves any behind writes an audit row naming the refs and the Bots. The
grants themselves are untouched: a tool the vendor starts listing again is offered again, and revoking
stays a decision somebody makes rather than a side effect of a vendor's bad afternoon.

Nothing changes for a connector whose grants all match its tool list, which is the normal case — the
section is not drawn and no row is written.

### Opening a new chat no longer logs a server error

A thread id is minted before the thread exists — the platform creates it on the first run — so reading
history on a brand-new conversation asks about a thread nothing has heard of yet. The platform answered
404, the runtime reported that as `500 Failed to fetch thread messages`, and every new chat left one in
the log with a stack trace behind it. Nothing was visibly broken, because the browser only reads a
history it got a 200 for; what was missing was any way to tell a thread that does not exist yet from a
history store that is down.

A thread the platform does not have now reads as having no messages. A 404 and only a 404: a 500 stays
a 500, because an outage answered with an empty history would tell the browser the conversation is gone
and invite somebody to start it over.

### Reconnecting a live screen no longer stops the screen you just reconnected

A Bot's screen allows one viewer, and opening a second `/stream` replaces the first. The replaced
socket is left open, because it belongs to a client that may still be using it, so on an ordinary
reconnect, where the browser opens the new connection before dropping the old one, the old socket
closed after the new one was already casting. Closing it stopped the session's viewer without asking
whether the closing socket was the one casting, so it stopped the replacement.

Both halves were silent. The screen stopped updating, and anything typed afterwards was dropped
without a word, because the input path looks for a viewer before it looks for anything it can report.

A close now stops casting only when the socket closing is the one that was casting.

### A sidebar channel row can be pinned or deleted

Right-click on a channel in the sidebar and a menu opens with two entries: Pin channel and Delete
channel.

Pin is held per member rather than per channel, so pinning one holds it at the top of your own
roster — newest first among pinned channels — and leaves every other member's roster unaffected.

Delete is confirmed in a dialog first, and it is soft. The channel disappears from every member's
roster and from a direct fetch of it, while the row, its transcript, and its Intelligence thread all
survive. That disappearance is live, not just on next load: every member's open tabs drop the row as
the delete lands, and a tab parked on the channel itself is sent home. The deletion is audited as its
own `channel.deleted` row. A channel the deployment package defines is refused, with the reason
named. Recovery today is clearing `channels.deleted_at` in the database directly; there is no restore
control in the product.

The deployment gains two nullable columns, via migration `0016`.

### An MCP server address that points inside the deployment is refused in three more spellings

Adding an MCP server by URL is checked before the address is stored, because that form is otherwise a
way to point the deployment at its own network. The check compared the literal hostname, and three
spellings of an address it means to refuse were getting through.

A trailing dot is the root-anchored form of the same name and reaches the same place, but it changed
the string enough that every rule missed it, so `https://localhost./`, `https://printer.local./` and
`https://metadata.google.internal./` were all accepted. `kubernetes.default.svc`, which is how a
service is addressed from inside a cluster, carries dots and none of the listed suffixes, so it read
as an ordinary vendor name.

The third is worth acting on rather than just noting. A credential typed into the address itself,
`https://user:token@vendor.example/mcp`, was accepted, and the address is stored and named in the
trail as given. Audit redaction works on field names and `url` is not one of the sensitive ones, so
the token was written to `mcp_servers` and to an audit row in clear text. The trail is append-only by
design, so that row cannot be deleted afterwards: **a deployment where somebody has done this should
treat that credential as disclosed and rotate it.** The address field now refuses a credential and
points at the token field instead.

A deployment that reaches its MCP servers by ordinary vendor hostnames sees no difference.

### One unreadable turn no longer takes a whole conversation down

Restoring a thread cast whatever the history store held straight to messages and handed it to the
transcript. A turn stored in a different shape — a tool call written `{id, name, args}` rather than
AG-UI's `{id, type: "function", function: …}`, which interrupted runs have produced — reached a
renderer that read `toolCall.function.arguments` and threw, so a single bad turn made the whole
conversation unopenable rather than that one message unreadable.

Each stored turn is now parsed against the schema AG-UI ships, and one that does not parse is left
out instead of being drawn. Checked where history enters the app rather than in one renderer, so
every surface that reads a transcript is covered by the same check.

**A turn that is left out is said out loud.** The conversation shows a line above it naming how many
earlier messages could not be read, because a record people read back must not have a hole in it that
nothing accounts for — a turn that silently disappears reads as one that was never sent. Multimodal
content and every well-formed tool call are unaffected, and a history that cannot be read at all
still opens the composer rather than blocking it.

### Refreshing no longer flashes white before the theme arrives

A person with the dark theme selected saw a white frame on every reload. The stored preference was
read early enough, but it was applied one paint too late: the browser had already drawn a frame
against the light palette by the time the app got to it. The document now decides its theme before
anything is drawn.

The browser was also drawing its own surfaces — scrollbars, form controls, the overscroll area —
light under a dark app, for the whole session rather than for a frame. Both themes now declare which
one they are, so those match too.

No configuration changes and nothing is stored differently; a deployment that was already on the
light theme sees no difference at all.

### `start.sh` refuses a port that answers but is not OpenBot

The startup checks asked whether a port answered, and treated that as proof the port belonged to this
stack. Those are not the same claim. Any single-page app serves its index.html for every path it does
not recognise, so an unrelated dashboard on a default port answers `200` to `/api/capabilities` as
readily as this server does.

The cost was not a wrong answer, it was a wrong answer three stages later. `require_free_or_ours`
reported "already up", so the server was never started; `wait_for` then printed a green
"server ready"; and the run failed at stage 3 inside `json.loads`, parsing that stranger's HTML. The
error names `char 0`, which reads like an empty response rather than a `<`, so the visible symptom
pointed nowhere near the port.

Each surface is now asked for something only it can produce: a `licenseStatus` field for the server,
its own `<title>` for the app, `/health` for the compose services. When a check gives up it says
whether the process failed to start or the port belongs to something else.

The root cause was in `.env.example`, and is fixed there too. The server reads `PORT`, this script
reads `SERVER_PORT`, `docs/configuration.md` documents `SERVER_PORT` as the setting, and only `PORT`
shipped. Moving the server by editing that one line left the script still looking at 3001. Both names
are now present, next to each other, saying they have to agree.

**A run may now stop where it used to continue.** That is the point: it stops at the port that is
wrong, naming it, rather than several steps later on a parse error.

### `docker compose up -d` configures the same stack `scripts/start.sh` does

`SUPERVISOR_TOKEN` and `COMPUTER_TOKEN` defaulted to the empty string in `docker-compose.yml`, so
which stack you got depended on how you brought it up. `scripts/start.sh` resolves both to their
`openbot-dev-*` defaults and exports them before calling compose. A plain `docker compose up -d` —
which this project's own shutdown notes tell you to use — passed an empty string instead.

`agent-computer` refuses to start without one, so that half failed loudly. The supervisor half was
the quiet one: the server kept the token it started with while the supervisor held an empty string,
and every call between them was refused at the door.

Both now carry the same defaults `start.sh` applies, as `COMPUTER_IMAGE` already did two lines down.
A value set in `.env` still wins, and a deployment should set one.

## 0.0.4

### A click citing a ref this deployment cannot resolve is refused

A Bot acts on a page by citing a ref from a snapshot, and the server turns that ref back into the
element before the boundary judges it. When the lookup failed, the action went ahead anyway with the
element half of the decision left empty — so a rule like "never click anything named submit" was not
declining to match, it was never shown the element, the shipped default permitted, and the click
landed on whatever that ref points at now.

The computer's own staleness check does not cover this. It compares a citation against its own
counter, so it catches the cases where the two disagree; the case that bites is the one where the
computer is content and only this deployment is out of step, which is what restarting a computer
under a stored snapshot leaves behind. The same click on the same button under the same policy was
refused before a redeploy and carried out after it.

A citation this server holds a snapshot for and cannot resolve is now refused, and the person is told
to take a fresh snapshot. Actions that name no element — scrolling, a page-level keypress, a shell
call, a file read — are untouched, and a computer this deployment holds no snapshot for still has its
citation forwarded, because there it is the only party that can answer. The refusal is raised after
the decision row is written, so an action somebody tried to take still appears on the trail.

**A deployment may see refusals it did not see before.** That is the point: those are the actions that
were being carried out without the boundary seeing what they touched. A Bot that meets one takes a
fresh snapshot and continues.

### A package ships its skills, so tool selection works on a clone

Tool selection narrows a Bot's tools to the ones its matching skills declare, and a deployment starts
with no skills at all. There was no `skills.yaml`, nothing seeded any, and nothing ever created one
— so on every fresh clone there was nothing to match against and the narrowing never switched on.
Left to a screen it would have stayed that way until somebody sat down and mapped tools to skills by
hand, in each deployment, again after each new connector.

A tenant package may now carry `skills.yaml`. Each skill has a slug, a title, a summary, its
instructions, and the `serverId/toolName` refs it needs. They are seeded on boot as deployment
skills, everybody sees them in the `/` menu, and connecting a connector is the only step left.

`skills.yaml` is optional, so every existing package loads unchanged and ships no skills. A package
may declare tools for a connector nobody has added: an unknown ref sits inert, because the offer is
still intersected with the Bot's grants. Naming a tool in a package grants nothing, exactly as
before.

A skill somebody wrote in the deployment keeps its name. If a package ships a slug a person already
took, theirs stands, the package loses that one, and the deployment starts — a name is not worth
refusing to boot over.

The example package ships four: `/find-a-document`, `/whats-changed`, `/who-owns-this` and
`/check-a-claim`.

### The tools a skill needs can be picked where the skill is written

A package's skills arrive with their tools declared. A skill somebody writes here could not: the
`tools` field existed on the save endpoint and on no screen, so a skill written in the product declared
nothing, and the only way to change that was to call the API by hand. Writing or editing a skill now
lists the tools of every connected server, grouped by server, with the ones that change something
marked.

Picking a tool here is not granting it. The offer is still intersected with what the Bot was granted,
so a skill naming a tool its Bot does not hold selects the skill and loads nothing — which is why
anybody may write a skill while connecting a server stays an administrator's decision. The screen says
so, next to the choice.

A tool the skill names that no connected server offers is shown too, under its own heading, rather
than left out. A package ships skills declaring tools for connectors nobody has added yet, and a
skill outlives the server it was written against, so a screen that drew only what matched was
stating part of the declaration as though it were all of it.

## 0.0.3

### A Bot is offered the tools its message needs, not every tool it holds

A model chooses the right tool reliably out of about ten and unreliably out of thirty, and it fails
quietly: it calls a plausible neighbour, or calls nothing and answers from what it already knew. Two
connectors is enough to cross that line, so a Bot holding more than twelve tools is now offered, for
each run, the tools of the skills that match the message.

Skills already declare the tools they need. That declaration is now what the offer is built from:
the deployment asks its own model which skills a message needs, and the Bot gets those skills' tools
plus every granted tool no skill has claimed. Nothing here can widen a Bot: the offer is intersected
with the grants, so naming a tool in a skill still grants nobody anything.

Nothing changes for a deployment that has not declared tools on any skill, or whose Bots hold twelve
tools or fewer. Those Bots are built exactly as before, with no extra model call.

There is a new audit event, `mcp.tools_discovered`, written before the run. It says how many tools
were offered out of how many granted, and why: the skills chosen, or that nothing was declared, or
that the choice could not be made. It answers "why did it call that", and the harder question, "why
did it not call anything at all" — which until now left no trace.

### The intent router works again behind a gateway

`OPENAI_BASE_URL` is documented ending in `/v1`, and the router appended `/v1/chat/completions` to
it, so every call went to `/v1/v1/chat/completions` and 404'd. The router reads a failure as "not
sure" and falls back to the default coworker, so on any deployment that set the variable — a
gateway, a proxy, a self-hosted model, which is the only reason to set it — untagged messages
silently stopped being routed and nothing said why. The version segment is now added only when the
configured URL does not already carry one.

## 0.0.2

### Upgrading

`AGENT_TOOL_TOKEN` is generated for you on a laptop. `scripts/start.sh` mints one and writes it to
`.env`, the way it already did for `MANAGED_AGENT_TOKEN`. Without it no Bot could call a tool back
through the deployment, which is the correct default for a deployment and made every MCP tool dead
on arrival on a fresh clone. A value already set is kept, and `.env.example` still ships it empty,
so a deployment not using `start.sh` is unchanged and still fails closed.

`start.sh` also stops skipping work for services that are already answering. A Bot container is now
handed to `docker compose` on every run and the server is restarted when this run minted a secret,
because answering says a process is alive and not that it still agrees with the deployment. The cost
is that a run which rebuilds an image recreates the Bot containers, about five seconds; `supervisor`
already behaved this way.

Two configurations now refuse to start:

- A provider configured with no `INITIAL_ADMIN_EMAILS`. Set it to at least one address.
- No provider at all and no `OPENBOT_SINGLE_USER=true`. Configure a provider, or set that to say you
  meant a deployment where every visitor is one administrator. This no longer depends on `NODE_ENV`,
  which is unset by default and so let exactly the dangerous case through. A deployment already
  running open needs the line added before it will start again.

Registering an OpenID Connect provider needs every host in its discovery document in
`TRUSTED_ORIGINS`, not only the issuer. Better Auth 1.7 checks each endpoint it finds, so a Google
issuer also needs `oauth2.googleapis.com` and `openidconnect.googleapis.com`. Registration is
refused with the untrusted host named.

A Bot id may now contain only letters, digits, hyphen and underscore, and must start with a letter or
digit. The same rule container and volume names have always followed. A deployment whose
`COMPUTER_BOT_ID` breaks it refuses to start and says so, rather than answering 400 to everything.

`AUDIT_RETENTION_DAYS` is new and unset, which keeps the audit trail forever, as before. Set it to a
whole number of days to have old rows removed.

The local document index and the old connector tables are dropped by migration. `documents`,
`chunks`, `document_acls` and the four connector-bookkeeping tables are removed and their rows go
with them; this cannot be rolled back. A deployment that had been syncing into the local index loses
that copy, which is the point: answering now goes through a live system's own search.

**An MCP server pointed at a credential that no longer exists loses the pointer.** `mcp_servers`
now names its credential with a real foreign key, where the column was `text` against a `uuid`
primary key with nothing checking it — so a deployment is allowed to be holding a pointer to a vault
row that was deleted underneath it, and the screens read as though the server were still configured.
The migration clears those before adding the key, because it cannot add it otherwise. If this
happens, that connector correctly reports having no credential and an administrator registers it
again; nothing else is affected, and a deployment with no such pointer sees nothing.

**The old Google Drive connector is gone, and it is not the new one renamed.** It configured a
service account with domain impersonation and had the worker sync documents into a local pgvector
index guarded by our own ACL rows, so every person got the same answer computed from what one
credential could see, and revoking somebody's access left a cached copy of their documents behind.
`/admin/connectors` and its two screens, the connector catalogue and admin service, the sync
persistence and the worker's connector runner have all been removed. A deployment that was syncing
this way stops syncing and should enable the new connector at `/admin/plugins/google-drive`, where
each person connects their own account.

`knowledge.yaml` is still parsed and still refused when malformed, because it is part of the
deployment-package contract. Its `sources:` are now read by nothing.
`MANAGED_AGENT_AG_UI_URL` is no longer required to start. The one-container image does not carry a
Bot, so requiring it registered the shipped Risk Analyst against a host that was not there and every
conversation with it failed. Leave it unset for that image. A laptop `scripts/start.sh` still points
it at `agent-langgraph`. A URL with no `MANAGED_AGENT_TOKEN` still refuses to start; a leftover
token with no URL is ignored.

A `.env` copied from an older `.env.example` still has `MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui`.
Unset it before `docker run --env-file .env`, or the coworker comes back.
The built-in Bot refuses to start without `OPENAI_API_KEY`. It used to start, report healthy, and
then fail every conversation, so a missing key looked like a working deployment. The LangGraph Bot
already refused the same way.

Sessions survive and nobody signs in again.

### Changed

- **This deployment does not search documents itself.** A Bot answers from a live system by calling
  that system's own search as the person asking, so the vendor decides what they may see and there is
  no second copy of anybody's documents here to keep in step, to secure, or to leave behind when
  somebody is removed. The local index that was being filled — `documents`, `chunks` and
  `document_acls` — and the connector that filled it have both been dropped. Retrieval over
  a copy of a customer's corpus is not a thing OpenBot does.

### Added
- **A skill can say which tools it needs.** `POST /api/plugins/skills` takes a `tools` list of
  `serverId/toolName` references, stored against the skill and returned with it. This is the unit
  tool retrieval will select over: a model picks a skill from its summary, and the skill says
  what to load. **It grants nothing.** A skill naming a tool a Bot was never granted still cannot
  call it, which is what keeps writing a skill open to anybody rather than to administrators
  only. A reference naming no tool this deployment has seen is refused when the skill is saved,
  so a typo is an error where it was written. Leaving the field out of a save leaves whatever was
  declared before, so nothing that predates it clears a declaration; sending an empty list is how
  a skill stops asking. Nothing consumes these yet — selection is the next piece, and until it
  lands a deployment behaves exactly as before.
- **A message with no `@` goes to the coworker it is for.** Typing without naming anyone used to
  reach the default coworker; to get a specialist you had to `@` them. Now an untagged message is
  routed to the coworker whose purpose matches it, chosen against each coworker's own description by
  the deployment's own model, before the channel is pinned. It is named, not silent: the channel
  header is the coworker it went to, and a `channel.routed` row records the choice, the reason, and
  the candidates it chose between (never the message itself). `@` still wins as an explicit override
  and skips routing entirely. If the router is uncertain or unreachable, it falls back to the same
  default the composer always used, and says so, rather than misroute or drop.

- **A Bot can answer from Google Drive, as the person asking.** Ask a Bot a question whose answer is
  in a document and it answers from the live file rather than from an index, citing a link that opens
  it. A Bot granted these tools reads Drive on the asker's own grant, so two people asking the same
  question get the answers their own accounts can see, and neither sees the other's documents.
  Read-only: the scope requested is `drive.readonly`, so a write is refused by Google before this
  deployment has to. Nothing is cached — the refresh token is stored and an access token is minted
  per call, so revoking access at Google takes effect on the next one rather than when a cache
  expires.

  Setting it up takes two people and neither can do the other's half. An administrator registers a
  Google Cloud OAuth client and enables the connector at `/admin/plugins/google-drive`; each person
  then connects their own account, and there is deliberately no endpoint for an administrator to
  connect one on somebody's behalf. The redirect URI has to match what is registered character for
  character, and the connector page states the exact string to paste, because a mismatch fails at
  Google with a message that never mentions OpenBot. See
  [docs/plugins/google-drive.md](docs/plugins/google-drive.md) for the whole setup and for what each
  failure means.

  **Disconnecting is not built yet.** The account page says so and points at Google's own third-party
  access settings, which is what withdraws it today.
- **Each tool a connector offers has its own screen**, at `/admin/plugins/<connector>/tools/<tool>`,
  with a switch per Bot. The connector page previously drew a button per Bot inside every tool row,
  which is a control per Bot per tool stacked in one list, and grew without bound as Bots were added.
- **Connected accounts**, at `/settings/connected-accounts`. What a Bot may read as you, and the
  scope the vendor actually granted rather than the one that was asked for.
- **A tool result that found nothing says so.** An empty result used to reach the model as an empty
  string, which reads as "the tool had nothing to say" rather than "there is nothing there" — and a
  model closes that gap from memory, which for a knowledge connector is the failure worth preventing.
- **The shipped Knowledge Bot answers from the tools it has.** Its instructions in
  `examples/fintech` told it to say no source was connected, which was honest when none could be:
  the connector this replaces had been removed and nothing had taken its place. With a connector
  granted it became the opposite of honest — the Bot called a tool, was handed a file listing, and
  said it had no access anyway. It now reports what its tools return, says so plainly when it has no
  tool or a tool reports a problem, and does neither of the two things worth forbidding: answering
  from its own memory as though it came from a source, or claiming to lack access to something a tool
  has just returned. A deployment with its own tenant package is unaffected.
- **`mcp.call_failed`.** A call this deployment permitted and the vendor did not complete now leaves
  a row of its own, carrying the vendor's own sentence. `mcp.call_succeeded` was written before the
  network call rather than after, so a call that died at the vendor recorded success and the Admin
  page agreed with it.
- **Releases are cut by a workflow, not by hand.** `Create release PR` bumps the version and promotes
  `## Unreleased` to a numbered section; merging the pull request it opens is what publishes. Merging
  builds and pushes one image to `ghcr.io/copilotkit/openbot`, signs a build provenance attestation
  for its digest, tags the commit and creates the GitHub Release with `container-images.json` so a
  deployment can name an exact digest rather than a tag somebody could move. See
  [docs/releasing.md](docs/releasing.md).
- **CI now runs the thing it ships.** Two checks were added. `migrations` refuses a schema change
  with no migration written for it, and a snapshot that has drifted from the schema. `image` builds
  the container, boots it with embedded PostgreSQL, and fails if it does not answer or if a
  supervised service is respawning. A single `verify` check covers every job, so branch protection
  needs one entry. The same checks run again against the release commit when a release is published,
  so they gate the release rather than the proposal for one.
- **Sign in with Google, Microsoft or Okta.** Any one of them turns sign-in on; configure several
  and the sign-in screen offers each, on matching buttons carrying each provider's own mark.
  `INITIAL_ADMIN_EMAILS` says who is an administrator. It is required whenever a provider is
  configured, because nothing else grants the role, and it is now a floor rather than a one-off:
  an address it names is made an administrator at every sign-in, so adding somebody to the list
  works even after they have already signed in.
- **SAML and OpenID Connect, registered while running.** `/admin/identity-providers` takes the
  metadata a company's identity team supplies and registers their own IdP. Somebody then types their
  email address on the sign-in screen and the domain decides which provider they are sent to, so a
  company mid-merger can run two. Registering, changing or removing one is administrator-only, which
  the upstream plugin does not require: it guards those routes with a session, and anybody who could
  reach them could register a provider for a domain and mint themselves colleagues.
- **A People screen.** `/admin/people` lists everybody who has signed in, with the provider they came
  through and when they were last here, and lets an administrator promote, demote, or remove
  somebody. Removing ends the session they are using and stops the next sign-in, keyed on the
  address so signing in again through the provider does not quietly create a new account. Every
  change is on the audit trail. Somebody named in `INITIAL_ADMIN_EMAILS` cannot be demoted or
  removed here, and nobody can do either to themselves.
- **One container that runs the whole thing.** The root `Dockerfile` builds an image carrying the
  app, the API, a Bot computer, and optionally PostgreSQL, supervised together. Point `DATABASE_URL`
  at a database you already run and the built-in one never starts; leave it unset and the container
  is self-contained. See [docs/deployment.md](docs/deployment.md) for the measured minimum sizes and
  the platforms it has been run on.
- **Bots can run commands.** `computer_run_command` runs a command in the Bot's `/workspace`, so a
  Bot can install a tool, unpack what it downloaded, or run what it was asked to run instead of only
  driving a browser. Governed like every other action: the policy decides, the audit row is written
  first, and a rule can refuse a shell outright with `intent == "run_command"` or refuse particular
  commands. The command is recorded; its output is not.
- **The audit trail shows the command.** A command row names what ran, the way a file row names the
  path, rather than reporting an element it was never about.
- **`COMPUTER_SANDBOX=on`** turns on Chromium's own sandbox where the host permits user namespaces.
  Which way it went is printed at start-up either way.
- **New chat.** The direct Bot chat has a button that starts a fresh conversation, which it had no way
  to do before: the thread was minted once and remembered for that Bot forever, so the only way out
  of a conversation was to clear the browser's storage by hand.
- **You can watch what a Bot is doing, not only what it is looking at.** The screen answered half the
  question: a Bot spending two minutes in a terminal showed a blank browser and one grey line per
  command, with the output nowhere. A command line in the transcript now opens to show what it
  printed, its exit code, and whether it was cut short or stopped. Beside the screen there is an
  Activity tab carrying every command, file read, file write and listing as they happen, newest
  first, with a count on the tab so a Bot working away from the browser is visible without switching
  to it. A saved file shows its path and size, never its contents. This is a live view of the open
  conversation; the record is still the audit trail.
- **Sign-in is on the audit trail.** Rows for signing in, for being refused, and for the configured
  administrator list granting somebody the role. Two questions had no answer before: who granted
  themselves administrator by editing `INITIAL_ADMIN_EMAILS`, and whether somebody just removed had
  ever been here, since removing them deletes the sessions that were the only evidence. A trail that
  is unavailable never blocks a sign-in.

### Fixed
- **A ref could resolve against a page from a computer that no longer existed.** The generation a
  computer stamps on a snapshot is unique only within one run of it, so a replaced container counts
  from one again and a ref the model is still holding matches a row nothing has overwritten. The
  policy then decides on an element from a dead page, and the audit row names it. Wiping a computer
  cleared the row for that reason and was the only thing that did; replacing one whose image changed
  did not, and the server was never told. A snapshot now carries which run of the computer took it,
  refs from an earlier run resolve to nothing, and the first snapshot of a new run replaces the old
  row however low its generation.
- **A migration stamped in the future silently swallowed the next one.** Drizzle runs a migration only
  when its journal timestamp is later than the newest one the database has recorded, so a migration
  stamped ahead of real time raises that ceiling and every migration written after it is skipped
  until the clock catches up. `drizzle-kit migrate` reports success the whole time. One migration was
  hand-written a day into the future and did exactly that to the next one to arrive: the table was
  never created, and the only sign was an integration test failing on a relation that did not exist.
  The timestamps are corrected, an older inversion between two earlier migrations is corrected with
  them, and the journal is now checked by a test, because nothing else in the build would notice.
  **If you ran a build between these, your database has the wrong ceiling recorded and will skip the
  next migration.** Repair it with
  `update drizzle.__drizzle_migrations set created_at = 1787359000000 where created_at = 1787444747113;`
  or start from a fresh database, where migrations all run in one pass and ordering cannot bite.
- **Every Bot ran a model two generations old, and it was costing tool calls.** The example package
  shipped `gpt-4.1` as the default for every built-in Bot. Asked to open a page behind a sign-in,
  those Bots answered "would you like me to prompt you to sign in?" and called nothing, three times
  out of three, while the prompt forbids that sentence in as many words. On `gpt-5.6-terra` the same
  question produces the tool call first try, so the package now runs `gpt-5.6-terra`. It is a
  default, not a commitment: `model.yaml` still decides.

  The Bots that answer over AG-UI stay on `gpt-5.5`, each for its own measured reason. The framework
  Bot answers nothing at all on `gpt-5.6-*` through the Responses API — `RUN_STARTED`, then
  `RUN_FINISHED`, no text — and the hand-written one cannot use function tools on
  `/v1/chat/completions` with a 5.6 model unless reasoning is turned off, which is the wrong trade
  for a Bot whose job includes deciding when to ask a person for help. It refuses to start on such a
  model now rather than failing one silent tool call at a time. Where a 5.6 model is set deliberately,
  the Responses API is switched on for it automatically, because a deployment that set the model and
  did not know about that switch got a Bot which started, looked healthy, and failed on its first
  tool call.
- **A Bot browsed to a vendor this deployment already connects to.** A Bot holding no grants was told
  nothing about connectors at all, so it treated a connected vendor as an ordinary website: asked
  about Google Drive it opened `drive.google.com`, met a sign-in page, and asked the person to sign
  in to an account the deployment had already connected. Every Bot is now told which vendors exist
  here, held or not, and says plainly which one it has not been granted rather than reaching for the
  browser.
- **A conversation was destroyed by a declined take-the-wheel.** A Bot that asks for help with a
  sign-in and never gets it left a tool call nothing ever answered, and every later turn in that
  thread failed at the provider. This was fixed once for the framework Bot and not for the Bot in the
  box, which is the one behind the Browser Bot, so it went on happening where most people would meet
  it. Both now answer their own unanswered calls with the truth rather than a fake success.
- **A Bot refused because a person had the wheel was told its refs were stale.** The computer flags a
  takeover, the surface branches on that flag, and the flag did not survive the server, so a Bot was
  sent back round the same action against the person who had just taken the browser. Reported and
  fixed by @beardthelion.
- **A person could not take the wheel unless the Bot offered it.** The button appeared only after a
  Bot called for help, so the control a person needs depended on the Bot getting one instruction
  right, and when it did not there was nothing to press. It is there whenever the Bot is driving now.
  The Bot asking for help is still its own row, with its reason.
- **The first message of a new channel could be lost.** A new channel's thread does not exist until
  its first run, so the join that restores history had nothing to settle against; the message was sent
  anyway after a deadline, while that join was still in flight, and the join finishing replaced it
  with the thread's messages, which were none. The deadline now ends the join and waits for it, so
  nothing is left in flight to overwrite anything. The transcript also says it is loading rather than
  showing an empty conversation, and the thinking line is visible for the first time: a CSS rule
  blanked the colour a gradient was built from, so the glyphs were painted with nothing. Reported and
  fixed by @zopeVaibhav.
- **The in-memory snapshot store disagreed with the table.** The database only ever moves a snapshot
  forward; the in-memory one, which is what a test reaches for when it has no database, took whatever
  arrived last. A test could therefore prove a boundary property that is false in a deployment.
  Reported by @beardthelion, fixed by @NathanTarbert.
- **A computer that had opened nothing still reserved a browser-sized frame.** That put a placeholder
  the height of a browser window into the middle of a conversation, above an answer that never
  involved the browser.
- **A Bot named after a deployment route was served without its guard.** The computer router steps
  aside for `/policy` and `/fleet`, which are its own paths and not about a Bot, because Hono matches
  `/*` against zero segments and a single-segment path arrives as a Bot id. It stepped aside on the
  name alone, so it covered everything under those names too: `/policy/status` is `/:botId/status`
  with a Bot called `policy`, and for that whole subtree the access check was never called at all.
  The guard now steps aside only for the deployment path itself, and a Bot may no longer be named
  after one: a package declaring it is refused, and a deployment that already holds such a Bot
  refuses to start and names it rather than serving it. Reported and fixed by @beardthelion.
- **Upgrading never reached a Bot's computer.** A computer is a container the supervisor makes, and it
  was reused by name whatever image it was built from, so once a Bot had one, rebuilding the image
  moved the tag and the container went on running the old one indefinitely with nothing to say so.
  `docker compose down` does not touch these either, because compose did not make them, so even a
  full teardown left them behind. That is worse than stale code: the computer is the browser, the
  workspace and the confinement around both, so a fix to any of them silently did not apply. A
  computer built from a different image is now replaced on next use. Its profile and its workspace
  are volumes and are kept, so a Bot comes back on the new image still signed in to what it was
  signed in to, with its files where it left them.
- **The audit trail could be erased with one statement.** It is append-only because a database
  trigger refuses updates and deletes, and that trigger is row-level, so `TRUNCATE` never reached it:
  anything holding `DATABASE_URL` could empty the table and nothing raised. That is the case the
  guarantee exists for, since it is enforced in the database precisely because the application is not
  the only thing that reaches the table. A statement-level trigger now refuses a truncate, and it
  answers before the retention setting is read, so declaring a retention window no longer permits one
  either. Retention itself is unchanged: rows older than the window are still removed, and recent
  ones are still refused. The connection the application uses is the database owner in the shipped
  compose file, and an owner can still disable or drop a trigger; closing that needs a role with
  `INSERT` and `SELECT` only, which is a separate change. Reported by @beardthelion, who also named
  the failure mode of the obvious fix and saved it from shipping as one.
- **A declined take-the-wheel destroyed the conversation.** A Bot that asks for help with a sign-in
  and never gets it left an assistant message holding a tool call that nothing ever answered, and
  every later turn in that thread failed at the provider. Declining once meant nothing you typed
  afterwards got an answer, with no way back but a new chat. Unanswered calls are now answered when
  the history is rebuilt, with the truth rather than a fake success: no result came, the run has
  ended, carry on without it and say what could not be done.
- **The audit trail could not say why a conversation went where it did.** It recorded the router's
  choice and recorded nothing at all when a person named a coworker with `@`, which is
  indistinguishable from a row that failed to write. A mention is now recorded too, as the person's
  own choice, without asking the model a question they had already answered. The audit page names the
  coworker and separates the three cases: chosen by the person, matched by the router, or the default
  because nothing matched.
- **A Bot with half a connector sent people to a sign-in box.** Granted a vendor's search but not its
  read, it found the document, could not read it, and opened the vendor's website to try, where it
  met a sign-in wall and asked the person to take the wheel. They already had access; the missing
  thing was the Bot's grant, and nothing said so. A gap in what a Bot holds is now reported as a gap:
  it names the capability it would need and says an administrator can grant it on that connector.
- **Answers arrived with no sign of where they came from.** Asked a compliance question, a Bot
  replied with a filing obligation, a dollar threshold, a deadline and a retention period, and the
  audit trail for that turn held one row: the routing decision. A confident unsourced answer is
  indistinguishable from a confident wrong one. Every Bot is now told to cite what it read and to say
  plainly when an answer is from its own knowledge instead. It is told this by the deployment rather
  than per agent, so it cannot be missing from the next Bot somebody adds, and it is explicitly not
  an instruction to go hunting for a source.
- **A Bot browsed to a vendor it already had tools for.** Granted Google Drive, asked what was in a
  document, it opened `drive.google.com` in its own browser, met a sign-in page that browser can
  never satisfy, and asked the person to sign in to an account they had already connected. A tool
  array says a tool exists; it does not say the tool is the way to reach that system, and it was
  competing with a page of prose about the browser that mentions connectors nowhere. A Bot is now
  told which systems it holds tools for, generated from its grants and placed before that prose, so
  enabling a connector changes what the Bot is told on its next run.
- **A question went to a coworker that had no way to answer it.** Routing read the sentence somebody
  wrote about what a coworker is for, which is not the same as what it can reach, so a question about
  a Drive document went to the one whose description says "company knowledge" and which held no Drive
  grants. Candidates now carry the systems they hold tools for. Purpose still decides first: a
  specialist with no connectors is still right for a question about its specialism.
- **A deny rule about submitting a form was walked around by typing.** `computer_type` takes a
  `submit` flag that presses Enter once the text is in, and the policy never saw a key, so a rule
  refused at the button and at the keypress let the third route through. Both shipped copies of that
  rule name both tools now, the key reaches the policy, and the audit row carries it — without it a
  row said a field was filled in rather than that a form was sent.
- **A Bot refused at the door left no trace.** A callback that could not prove which Bot it was
  returned 401 and wrote nothing, so a Bot holding a token the deployment no longer accepted had
  every call refused, returned nothing to its own model, and the model told the person there were no
  results. A false negative delivered as an answer, with the audit trail agreeing nothing had
  happened. Recorded now as `mcp.callback_refused`, naming the tool and the reason but no Bot or
  actor, since both arrive in the credential that just failed to verify.
- **An unanswered request for the wheel followed a Bot around.** Control belongs to a Bot's computer
  rather than to a conversation, so a request nobody took sat there indefinitely and every later
  conversation with that Bot showed a live prompt for work it was not doing, captioned with a reason
  written for somebody else. An unanswered ask now stops being shown after ten minutes and its reason
  goes with it. A person actually holding the wheel is never timed out.
- **`/admin/computers` listed nothing, ever.** Admin addressed the fleet through a per-Bot route with
  a placeholder id, which stopped working when that route began checking whether the caller may act
  as the Bot in the path. The screen renders nothing while the list is null, so a deployment with two
  running computers looked like one with none. The fleet has a route of its own, still
  administrator-only.
- **Every shipped component was recorded twice on a first start.** Two browsers announcing at once is
  ordinary and the insert was already safe for it; the answer was not, so the loser of that race
  named every component anyway and the caller wrote an audit row per name.
- **A Bot could reach the deployment's own network by writing the address a different way.** The
  guard refused `169.254.169.254` and the private ranges as usually written, but not the same
  addresses spelled as an IPv6-mapped or NAT64 form, an integer, or with a trailing dot, so a Bot
  talked into fetching one still reached cloud metadata or an internal host. The address is
  canonicalised before it is checked now, the mapped form of `0.0.0.0` (which reaches every local
  port) is refused, and the container credential endpoints a hosted deployment must never expose —
  ECS and Fargate's `169.254.170.2`, Alibaba's `100.100.100.200` — are refused even when the
  private-host opt-in is on. The same guard backs agent registration, so it is closed there too.
- **The supervisor could adopt a container it did not create.** When starting a Bot's computer hit a
  name already taken, it started whatever held the name and handed it the deployment's computer
  token, so on a Docker host shared with anything else it could drive a stranger's container as a
  Bot's. It now refuses a container that does not carry its own namespace label, read from the
  container rather than inferred, so a second deployment on the same host is never adopted.
- **Removing somebody left the credentials they had granted this deployment sitting in the vault.**
  Removing them from the People screen ended their sessions and stopped the next sign-in, and left the
  refresh token behind, unrevoked. They could not use it — the account comes from a session they no
  longer get — but "we removed their access" was not true of the token, which for a connector read as
  the person asking is the part that matters. Removing somebody now retires it, and each retirement is
  on the audit trail as `mcp.account_disconnected`. Deleting a person's row used to be worse, because
  it took the connection record with it and left the credential reachable by nothing at all; those are
  found and retired too. This stops the deployment holding a usable secret. It does **not** withdraw
  the grant at the vendor, which needs revoking there until disconnect ships, and the audit row says
  which of the two happened rather than implying both.
- **The one-container image registered a coworker it could not run.** `MANAGED_AGENT_AG_UI_URL`
  defaulted to `localhost:4201` and was required, so Risk Analyst appeared on the roster and every
  conversation with it failed. The URL is optional; the package omits that coworker when it is
  unset. `scripts/start.sh` still points it at `agent-langgraph` on a laptop.
- **A boundary rule applied on one server out of N.** The policy is read from memory on every action,
  which is right, but memory was only ever filled at boot. An administrator's new deny rule was
  enforced by whichever process served the request and roughly one action in N went through it, while
  the admin screen reported success because the row really was saved and the audit trail agreed
  because it records the boundary each process started with. Both honest, and both describing
  something other than what the fleet was enforcing. A write now announces on Postgres in the same
  transaction and every server re-reads, including on reconnect, so a server that was down when the
  rule changed catches up rather than waiting for a restart. Reset travels the same way.
- **A ref resolved on one replica and nowhere else.** The gateway turns the opaque ref in a click into
  the element it points at, and that mapping lived in a `Map` in the process that took the snapshot.
  On any other replica the ref resolved to nothing, so a deny rule written about the element did not
  match and the click went through, recorded as allowed with no rule. It is in Postgres now, keyed on
  the generation the computer stamped, so a ref from a superseded page still resolves to nothing.
- **Anybody signed in could act as anybody's Bot.** The Bot id travels in the path and the acting
  routes checked only that somebody was signed in, so a signed-in person could drive another person's
  private Bot, reset its browser, read its screen and fire its granted tools. Every route under a Bot
  id now asks the store the same question the roster already asks, and a Bot that does not exist and
  one belonging to somebody else answer identically.
- **The computer fleet listing was open to any signed-in person.** It ignores its `:botId` and returns
  every Bot's machine, so it told anybody who could reach it every Bot id in the deployment and
  whether each was running, private coworkers included. Administrator-only now.
- **A Bot id could name a directory outside the profiles volume.** The id arrives as a URL segment or
  a header, was joined onto a filesystem path, and `reset` deletes that path recursively as root, so
  `../../tmp/something` deleted it. Refused at the request boundary and again where the path is built.
- **A mistyped deny rule permitted instead of refusing.** A rule that parsed and evaluated but
  answered with something other than true or false was neither a match nor an error, so
  `deny: ["Submit order"]` — what somebody writes who reads the list as labels — let the action
  through with nothing logged, while the rule sat on the Boundaries page looking as though it were in
  force. Any non-boolean answer is now a broken rule and takes the existing fail-closed path.
- **Rotating a Bot's key left the old one live.** Editing a key wrote a new vault row and repointed
  the Bot at it, leaving the previous credential decryptable and still valid with nothing listing it,
  so rotation did not do the one thing rotation is for. Deleting a Bot left its key live too. Both
  revoke now.
- **Nothing recorded what changed about a Bot.** Ten mutating routes wrote one audit row between them
  and there was no event type for any of the other nine. A Bot's endpoint is where conversation
  content is sent, so "who pointed this Bot at that host, and when" is the first question in an
  incident and could not be answered. Eight event types and eight rows now, recording what changed and
  never a value.
- **The people list and the channel list grew without bound.** Both were read in full on every render,
  and reading one person ran the whole people aggregate over the deployment twice per role change.
  Both are paged now, and the people screen searches on the server so somebody can be found without
  walking pages.
- **A computer accumulated one browser per Bot, forever.** `COMPUTER_MAX_BROWSERS` and
  `COMPUTER_BROWSER_IDLE_MS` set the two limits. Nothing closed an idle one, so a deployment
  where every employee has a Bot trends toward a resident Chromium per employee in one container until
  it is killed for memory. There is a cap and an idle timeout, and closing one costs only a relaunch
  because the profile is on disk.
- **The audit screen's filters were sequential scans.** It filters by event type, by who did it and by
  what it was done to, and the only index was on the timestamp, over what becomes the largest table in
  the deployment. Each filter leads its own index now.
- **A deployment with no identity provider came up open by default.** Covered under Changed above,
  and listed here too because it is the one on this list that was reachable from the internet.
- **Registering a company's identity provider was owned by whoever registered it.** Better Auth
  answers its own listing route with only the providers the person asking registered, and refuses a
  removal from anybody else, so a second administrator opened the Identity providers screen, found
  it empty, and registered one that already existed. Worse, the row cascaded from that person's user
  row: deleting the administrator who set sign-in up deleted the company's sign-in with them. What is
  registered is a fact about the deployment, so reads and removals go through OpenBot's own
  administrator-only routes against the whole table, and a provider outlives the person who added it.
- **A customer's client secret was in the clear.** The SSO plugin writes `oidc_config` and
  `saml_config` as plaintext JSON, with the OAuth client secret for that company's directory inside
  them: the one secret here not going through `KEY_ENCRYPTION_KEY`. Both are now encrypted at rest.
  Rows written before this still read, and are re-encrypted the next time they are written. OAuth
  access and refresh tokens use Better Auth's own encryption, keyed on `BETTER_AUTH_SECRET`.
- **A failed provider registration looked like a button that did not work.** The error was rendered
  on the page behind the dialog, which was covering it.
- **Deleting a component in the playground could release one the build ships.** `DELETE
  /api/sandboxed/:name` deleted from the shared components table by name, without checking
  which kind of component the name belonged to. Naming a compiled component removed its
  governance row, and the foreign keys took that component's per-Bot withholdings and its
  function grants with it. Withholding is the half that fails open: a published component is
  available to every Bot unless a row says otherwise, so the next catalogue announcement brought
  the component back published, and available to a Bot it had deliberately been kept from. The
  audit row called it `kind: "sandboxed"`. The endpoint now refuses a name this surface does not
  own and answers 404, the way publishing already did. A governance row whose source is already
  gone is still this surface's to clear.
- **A write could follow a symlink out of the Bot's workspace.** The confinement resolved the
  directory a write would land in but not the name it would land on, so a link left at `notes.txt`
  pointing outside was followed by the write; a read through the identical link was already refused.
  The gateway had already decided and written the audit row against the path as it was asked for, so a
  rule written for `credentials/` never saw the file that was written and the trail named a file
  nothing had touched. A dangling link escaped the same way, because resolving the path throws where
  the write would still land. Links pointing back inside the workspace continue to work.
- **A Bot could become root inside its container.** `sudo` was granted as `NOPASSWD: ALL`, and the
  comment above it named the two conditions that made that acceptable: the container being one Bot's
  alone, and not holding a database. The image meets neither, because the supervisor is deliberately
  not in it and `EMBEDDED_POSTGRES=on` is a documented way to run it. So root read another Bot's
  workspace, the API's environment, and the audit database recording what it did. The grant now names
  the package managers, so `apt-get install` still works and `sudo cat /proc/1/environ` does not. It
  is a floor rather than a boundary: code a model wrote needs a computer per Bot with
  `COMPUTER_SUPERVISOR_URL` and a sandbox under it with `COMPUTER_RUNTIME=runsc`, both of which this
  already supports and neither of which the single-container image can reach.
- **A command could take the computer down, or outlive being stopped.** Output was accumulated in
  full and only trimmed at the end, so `cat` of a large file allocated until the process that owns
  the browser died; it is now bounded as it arrives, and still reports that it was truncated rather
  than quietly ending. A stop signalled bash alone, so `sleep 30 | cat` left its children holding the
  pipes and the call never returned; the whole process group is signalled now. A `timeoutMs` of zero
  or less killed the command before it started and called it a timeout; it has a floor as well as a
  ceiling.
- **Stop did not reach a running command.** The `/exec` route never took the person's abort, so the
  plumbing for it was dead code and a stopped run left the command finishing inside the container.
- **The live-screen socket did not check the address it was given.** Every acting path resolved
  through the gateway, which refuses a foreign or cloud-metadata address; this one asked the provider
  directly and then put `COMPUTER_TOKEN` in the query string of whatever it was told.
- **`COMPUTER_SHELL_ENV` refuses the names that run before a command.** Naming `GITHUB_TOKEN` is an
  operator deciding a Bot may use a token. Naming `BASH_ENV`, `ENV`, `LD_PRELOAD` or the shell option
  variables is handing a Bot a hook into every later command, which is unlikely to be what was meant,
  so those are refused and said out loud rather than passed. A name that is not a variable name is
  now reported too, instead of quietly disappearing.
- **A deny rule naming one field refused every action that did not have it.** `deny:
  contains(command, "rm -rf")`, the example the documentation gives, refused every click, keypress,
  navigation and file read in the deployment. Two correct behaviours combined into a wrong one: the
  policy context left out fields an action did not have, cel-js treats a missing field as an unknown
  identifier and throws, and a thrown deny counts as a match so that a mistyped deny refuses rather
  than quietly permitting. Every field is now bound, with a neutral value where the action has
  nothing to put there, so a rule about a shell answers honestly about a click instead of refusing
  it. Rules about the action they are for are unchanged. The audit row still omits what did not
  happen.
- **A command longer than 45 seconds reported failure while it carried on running.** The transport
  gave every call the same deadline, which was shorter than the shell's own 120 second default and
  600 second maximum, so `apt-get install` told the person the computer had not responded and then
  finished installing inside the container. A command now gets a deadline that outlasts the shell,
  which reports a timeout itself and says so.

- **A Bot's shell no longer inherits the deployment's environment.** Commands ran with the computer
  process's own environment, so `env` in the one-container image printed `KEY_ENCRYPTION_KEY` and
  the rest of `.env`. The shell now receives PATH, locale and terminal names, and the proxy
  variables. Userinfo is stripped from a proxy URL, so a password in `HTTP_PROXY` is not in `env`.
  Anything else is named in `COMPUTER_SHELL_ENV`.
- **A deployment served over plain HTTP could not start a conversation.** The chat surface minted
  identifiers with `crypto.randomUUID`, which browsers withhold outside a secure context. On a
  laptop `http://localhost` counts as one, so this never showed up in development; on a real
  address it does not, and the surface did nothing at all when you pressed send. No message, no
  error. Ids now come from an API with no such restriction.
- **A Bot asked to be signed in, in words, and nothing happened.** Handing over the browser is a tool
  call, and a sentence in the transcript is not one: "please sign in and let me know" leaves the
  person with no wheel to take and the page where it was. Bots wrote that sentence anyway, and one
  went further and asked for a username and password to be typed into a sign-in page nobody could
  reach. The guidance now says that calling `computer_request_help` is what asking means, names the
  sentences that are not it, and says the person cannot see the page at all until control is handed
  over. Asked to file an issue on a site it was not signed in to, a Bot now offers the wheel on the
  first attempt instead of the third.
- **A package Bot did not know it had a computer.** The instructions that make the computer usable —
  snapshot before acting, and ask a person to take the wheel at a sign-in rather than reporting the
  task as impossible — were imported by the two shipped Bots and by nothing else, so a built-in agent
  knew only the role its package gave it. The tools were on offer to it the whole time. Asked to file
  an issue on a site it was not signed in to, it browsed to the page, said it could not, and never
  called `computer_request_help`, so nobody was ever offered the wheel. Built-in agents are now told
  the same thing the shipped Bots are told, wherever a computer is configured.
- **A chat could quietly forget everything and carry on.** The browser remembers a thread id for each
  Bot, and nothing ever asked whether Intelligence still had that thread. Where it did not, the
  transcript loaded empty, every later message silently recreated an empty thread under the same id,
  and the Bot answered as though the conversation were new — with the reason nowhere but the server
  log, as a 404 flattened into a 500 by the time it reached the browser. A remembered thread is now
  checked before it is used: one the platform provably does not have is replaced, because there is no
  conversation left to lose, and a check that fails for any other reason keeps the thread and says on
  screen that earlier messages could not be loaded. A person reading a confident answer can now tell
  whether the Bot has read what came before it.
- **The first browser action a Bot was ever asked for failed.** Creating a computer and starting it
  are two calls to Docker, and a name the daemon has not published yet answers the second with a 404.
  The supervisor treats that as a lost race and rebuilds, which is right, but it went straight back
  round: the retry landed a millisecond later, saw the same unpublished name, and spent the only
  other attempt on it. The whole request then failed as Docker being unreachable, the person was told
  the computer could not be started, and the next message worked. It waits one poll interval before
  rebuilding now, which is what the health wait already uses for the same question.
- **A framework Bot asked for a browser action and nothing happened.** `agent-langgraph` ends a run
  when the model calls a tool the surface owns, which is how a tool that lives in the browser is
  supposed to work: the run finishes, the surface acts, and the next run carries the result. But the
  call was only reported to the surface from the node that executes this deployment's own tools, and
  that node is exactly what an ending run skips. The person saw their own message, no answer under
  it, and no explanation, because a run that finishes carrying nothing is not an error. Every Bot
  action in the browser was affected: opening a page, filling a form, asking for help at a sign-in.

### Changed

- **A retention policy for the audit trail.** `AUDIT_RETENTION_DAYS` removes rows older than the
  window it names, swept hourly by whichever server holds an advisory lock. Unset by default, because
  deleting somebody's audit trail because a default said so is the worse of the two failures. The
  trail stays append-only: the database permits a delete only when the transaction declares a
  retention window and only for rows already outside it, so removing recent rows is still impossible
  and an `UPDATE` still is under every condition.
- **`allowed_groups` is documented as a declaration, not a control.** The tenant package writes it and
  nothing reads it on any access path, and `users.groups` is written by nothing either, so both halves
  of the rule are waiting on group membership arriving from the identity provider. Channel access is
  membership alone. The columns stay, because they are the right shape for the rule they are named
  for. Thanks to [@NathanTarbert](https://github.com/CopilotKit/OpenBot/pull/92) and
  [@andreolf](https://github.com/CopilotKit/OpenBot/issues/82).
- **Running with no sign-in takes a flag and nothing else.** It used to be locked with
  `NODE_ENV=production`, which is exactly backwards: `NODE_ENV` is unset unless somebody sets it, so
  a container on a VM with a hand-written env file and no identity provider served every visitor on
  the internet as an administrator, silently, because nothing looked wrong from the outside. A
  deployment with no provider now refuses to start unless `OPENBOT_SINGLE_USER=true` says it was
  meant. `.env.example` ships that line switched on, so a clone still runs with no configuration at
  all, and the line is greppable in a way a default never was. `OPENBOT_DEV_NO_AUTH` is still
  honoured.
- **Requires Better Auth 1.7**, which adds an `issuer` to every account. Migrations `0002` and `0003`
  add the column and backfill existing rows with their provider's real issuer, so nobody is asked to
  sign in again. The column stays nullable on purpose: a rolling deploy runs migrations and then
  serves from old and new replicas at once, and an old replica writes an account without it, so
  making it required in the same release would break the first sign-in of everybody who landed on a
  replica that had not been replaced yet. The constraint belongs to a later release.
- **Where a Bot's computer runs is now a plug.** One `ComputerProvider` interface sits under the
  gateway, with the Docker supervisor as one implementation and a shared computer as another. A
  computer somewhere else is an adapter rather than a change to the governed path. Thanks to
  [@mu-hashmi](https://github.com/CopilotKit/OpenBot/pull/57) for the refactor.
- The address a provider hands back is checked before anything is sent to it, and the cloud metadata
  addresses are refused whatever a provider says.
- The container image runs as an unprivileged user rather than root.

## 0.0.1

First tag.
