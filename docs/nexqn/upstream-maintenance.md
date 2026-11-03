# Upstream maintenance

NexQN tracks CopilotKit/OpenBot. Upstream ships several commits a day; a fork that edits upstream
files freely stops being mergeable within weeks. These rules keep it mergeable.

## Remotes

```sh
git remote -v
# origin    https://github.com/TinNVT/nexqn-ai.git
# upstream  https://github.com/CopilotKit/OpenBot.git
```

## Rules

1. **Additive first.** NexQN code lives in new files and directories: `docs/nexqn/`, a NexQN tenant
   package, `server/src/model-gateway/`, `server/src/subscription-cli/`, `server/src/knowledge/`, and
   new migrations. Upstream files are edited only at registration points (route mounting, schema
   index, tool registration).
2. **Small hooks in upstream files.** When an upstream file must change, keep the change to a few
   lines that call into a NexQN module, so a conflict is easy to read.
3. **Brand through config.** Never rewrite upstream copy to say "NexQN"; replace the literal with
   `appConfig.brand.productName`. That change is generic and can be offered upstream, which removes
   the conflict permanently.
4. **Migrations.** Upstream numbers migrations sequentially in `server/drizzle/`. A NexQN migration
   created between upstream merges will collide with the next upstream number. Generate NexQN
   migrations only after merging upstream, and renumber on conflict before merging to `main`.
   Never edit an upstream migration.
5. **Do not edit `docs/architecture.md` and other upstream docs.** NexQN documentation is in
   `docs/nexqn/`.
6. **Dependency patches.** `patches/@copilotkit%2Freact-core@<version>.patch` removes CopilotKit's
   "Powered by CopilotKit" bar. It is pinned to one version, so any bump of that package needs the
   patch regenerated (see [development-plan.md](development-plan.md#the-copilotkit-licence-bar)).
   `app/tests/copilotkit-license-banner.test.ts` fails if it is lost.
7. **Keep the MIT notice.** `LICENSE` stays; the NexQN About page and image labels credit
   CopilotKit OpenBot.

## Sync procedure (at least monthly, ideally weekly)

```sh
git fetch upstream
git switch -c sync/upstream-$(date +%F) main
git merge upstream/main          # merge, not rebase: main is shared
bun install --frozen-lockfile
bun run format:check && bun run lint && bun run typecheck && bun run test:ci
```

Resolve conflicts, check migration numbering, open a PR into `main`, and let CI (the upstream
workflow, unchanged) pass before merging.

## Candidates to contribute upstream

- The tenant `theme.css` actually reaching the page (upstream validates it and never applies it).
- `short_name` / `website_url` / `support_email` and later logo / favicon in `brand.yaml`.
- `<title>` from the tenant package.
- Replacing literal "OpenBot" in user-facing copy with the configured product name.
