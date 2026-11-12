# Task: Group the sidebar conversations into collapsible sections (Group chats / Direct chats / Projects)

> Handoff note (devops agent, 2026-11-12). Repo: `/root/repos/openbot-src` (bun 1.3.14, workspace
> `app` + `server`). Kaneo: DevOps project, task #8 (stages #9–#12).
> **The work is already ~70% done and uncommitted** — see "Current state" at the bottom.
> Do not restart from scratch: finish, verify, commit.

You are working in the OpenBot monorepo (CopilotKit/OpenBot). First read the existing sidebar /
channel-list components in `app/src/` and the channels routes in `server/src/`, and follow the
conventions you find there (naming, data fetching, state management, design tokens).

## Goal
The sidebar shows conversations in three collapsible sections, in this order:
1. Group chats — channels with more than one human member or more than one Bot.
2. Direct chats — 1:1 channels between the signed-in person and a single coworker.
3. Projects — user-defined folders a person can create, rename, delete, and move channels into.

## Requirements

### Backend (server)
- PostgreSQL migration: `projects` (id, owner user id, name, sort order, created_at) and a
  nullable `project_id` on channels (or a join table — justify the choice in the PR description).
  A channel belongs to at most one project.
- Routes per existing API conventions:
  - `GET /api/projects` — the caller's projects with their channels' ids;
  - `POST /api/projects`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id` (deleting a
    project must NOT delete its channels — they return to the ungrouped list);
  - `PATCH /api/channels/:id/project` — move a channel into a project or out (`null`).
- Authorization: only the project owner can rename/delete it and move channels into it; moving
  requires channel membership (the same check the channel routes use). Never leak channel titles
  to non-members through project endpoints.
- Persist per-user collapsed/expanded section state server-side (extend `agent_preferences` or
  an equivalent existing mechanism; no browser localStorage).

### Frontend (app)
- Section header: chevron, title, conversation count; click toggles collapse; state survives reload.
- Channels sorted by most recent activity (keep current ordering logic). A channel inside a
  Project does not also appear under Group/Direct.
- Group/Direct classification computed from data the app already fetches — no N+1 requests.
- Channel context menu: "Move to project ▸" (user's projects + "New project…"), "Remove from
  project" when applicable; shown only per the authorization rules.
- Projects section header has "+" to create a project (inline rename input).
- Per-section empty states; sidebar search (if present) filters across sections and
  force-expands sections with matches.
- Use existing design tokens/components; correct in light and dark themes; no new dependencies.

### Constraints
- Do not change the channel permission model: every existing channel route keeps resolving the
  caller in `channel_memberships`. This feature is organization-only.
- Do not break the desktop (Tauri) build; sidebar must work at narrow widths.
- Follow docs/development.md: run migrations locally; lint/typecheck/test targets must pass.
- Tests: server route tests for project CRUD authorization and non-member title isolation;
  component tests for section toggle and move-to-project menu if the repo has a component-test setup.
- Keep the diff reviewable: one migration, server routes + tests, frontend + tests, docs note.

## Definition of done
- Three sections render; group/direct classification matches membership.
- Create project "Website redesign", move two channels in, collapse/expand, reload — state persists.
- Deleting the project returns channels to normal sections, intact.
- Existing tests pass; new tests cover the rules above.

## Defaults (record any deviations in the PR description)
- A group channel CAN be in a project (any channel the user is a member of).
- Projects are per-user: the owner sees channels grouped, other members see them as usual.

---

## Current state in this checkout (measured 2026-11-12 05:2x UTC)

Uncommitted on `main`, 12 modified + 15 new files. Earlier session ran out of tool iterations
mid-frontend; verify everything, do not assume it is correct.

Server half (believed complete, unreviewed):
- `server/src/db/schema/projects.ts` — `projects` + `channel_projects` (join table with
  `owner_user_id`; decision recorded in the schema comments: a folder is per person, so a
  `project_id` column on `channels` would force one folder for everybody who sees the channel)
- `server/drizzle/0089_exotic_ultragirl.sql` + `meta/0089_snapshot.json`
- `server/src/projects/store.ts` (261 lines), `server/src/projects/routes.ts` (171 lines)
- wiring: `server/src/app.ts`, `server/src/index.ts`, `server/src/channels/routes.ts`
  (`memberCount`, `projectId` in the roster payload), `server/src/db/schema/index.ts`
- section collapse state: `shared/user-preferences.ts`, `server/src/user-preferences.ts`,
  `server/src/user-preferences-routes.ts`

App half (in progress):
- `app/src/components/app-sidebar/conversation-sections.tsx` (461 lines), `section-header.tsx`,
  `move-to-project-menu.tsx`, `new-project-dialog.tsx`, `delete-project-dialog.tsx`,
  `project-name-input.tsx`
- `app/src/lib/channels/sections.ts` (209), `order.ts`, `unread.ts`,
  `app/src/lib/projects/{queries,mutations}.ts`, `app/src/lib/settings/sidebar-sections.ts`
- `app/src/components/app-sidebar/app-sidebar.tsx`, `channel.tsx`, `app/src/lib/channels/queries.ts`

Gate status at handoff:
- `bun run typecheck` → **app fails**: 10 TS errors, all "Property 'sidebarSections' is missing in
  type 'UserPreferences'" in `tests/app-navigation.test.tsx`, `channel-pagination.test.tsx`,
  `narrow-sidebar-sheet.test.tsx`, `self-host-banner.test.tsx`, `skins-account.test.tsx`,
  `user-preferences.test.tsx`. Fix by one uniform mechanism (a fixture builder or a default in the
  type), not file-by-file patching.
- `server` typecheck was killed with SIGKILL (looked like OOM) and is therefore **unverified**;
  re-run it alone.
- No tests exist for projects yet. Docs untouched.

Environment notes:
- `bun` 1.3.14 at `/root/.bun/bin/bun`; deps installed (1.6G `node_modules`).
- Test Postgres: container `openbot-test-pg` on `127.0.0.1:55432`, db `openbot_test`
  (user/password `openbot`). Migration 0089 was applied there by the earlier session — re-run
  `bun run db:migrate` if in doubt.
- Running deployment: container `openbot` (server on `127.0.0.1:3001`). Do not restart or redeploy
  it from here without asking; verify the UI in a dev server instead (`bun run dev`).
- `gh` is **not installed**, the remote is upstream `https://github.com/CopilotKit/OpenBot` over
  HTTPS, there is no fork and no token: do **not** attempt to push or open a PR. Deliver a local
  branch `feat/sidebar-sections`, a `sidebar-sections.patch`, and a filled-in PR body draft.
- Repo git identity is empty: set it repo-locally before the first commit
  (`git config user.name "Sergey Shabalin"; git config user.email "mail@sshabalin.ru"`).