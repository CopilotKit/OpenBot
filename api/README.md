# OpenBot's API spec

`api/openapi.yaml` is the REST API every client is generated from and every check reads: the app's
client (Orval), the breaking-change check (oasdiff), the lint (`bun run api:lint`) and the server's
contract tests. It is a bundle. Never edit it by hand: edit its sources and bundle.

## Sources

The sources live in `api/openapi/`, one file per area, so builders working on different areas do
not touch the same lines:

| File | What it holds |
| --- | --- |
| `common.yaml` | The root: info, servers, tags, security schemes and OAuth scopes, the list of paths, and what every area shares (problem details, paging, Idempotency-Key, shared headers and responses) |
| `bots.yaml` | Bots |
| `audit-events.yaml` | The audit trail |
| `accounts.yaml` | People, API keys, sessions, linked accounts and identity providers |
| `admin-settings.yaml` | Deployment, organization settings, capabilities, network policies, model usage, computer actions and the setup checklist |
| `conversations.yaml` | Reactions and conversation join tokens |
| `model-connections.yaml` | The vault, the model key, the model catalogue and model choices |
| `schedules.yaml` | Routines, check-ins and what they found, goals with their triggers and GitHub event sources, and a Bot's follow-ups |

An area file holds its operations under `paths`, and under `components` the schemas, parameters,
responses and examples only it uses. Inside the file, refer to them as usual
(`'#/components/schemas/Bot'`); refer to a shared one in `common.yaml`
(`'./common.yaml#/components/responses/Unauthenticated'`). The bundle names every component after
its own key, so pick a name no other area uses; a clash fails the bundle.

`common.yaml` lists each path once, as a `$ref` into its area file. A new component needs no line
there; the ones listed as `$ref`s into area files are listed only to keep the bundle's order. Keep
each tag, scope and path in `common.yaml` on one line, so a merge keeps every entry whole.

## The builder rule

1. Edit the area file (and, for a new path, tag or scope, append one line to `common.yaml`).
2. Run `bun run api:generate`. It bundles `api/openapi.yaml` first, then regenerates the client.
3. Commit the sources, `api/openapi.yaml` and `app/src/lib/api/generated` together.

After a rebase, run `bun run api:bundle` and `bun run api:generate` again and commit what changed.
`common.yaml`, `api/openapi.yaml` and the generated client's index files merge with git's union
driver (`.gitattributes`), which keeps both sides' appended lines instead of stopping on a
conflict; the bundle and the client are rebuilt from the merged sources, and CI's drift checks
(the bundle matches its sources, the client matches the bundle) catch anything the merge got
wrong. If both sides changed the same line of `common.yaml`, union keeps both: delete the stale
one.

## Adding an area

1. Create `api/openapi/<area>.yaml` with a `paths:` map (and a `components:` map if it has its own
   components), in the same shape as the other area files.
2. Point `common.yaml` at each of its paths, escaping `/` as `~1` in the pointer:
   `/api/v2/organizations/{organizationId}/things: { $ref: './things.yaml#/paths/~1api~1v2~1organizations~1{organizationId}~1things' }`
3. Add its tag and OAuth scopes to `common.yaml`, then run `bun run api:generate`.
