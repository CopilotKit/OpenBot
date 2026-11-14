# Accepted breaking changes

CI fails a pull request on any change to `api/openapi.yaml` that oasdiff calls breaking. A line here
lets exactly one such change through: oasdiff matches a line by its method and path and the change's
own words, so any other breaking change still fails. Add a line only for a change that takes nothing
from a client, and say why on the line: the date, the change as oasdiff words it, and the reason.

Once the change is on the base branch, oasdiff no longer reports it and its line matches nothing.

- 2026-11-14 GET /api/v2/organizations/{organizationId}/bots added the pattern `^[A-Za-z0-9_-]+$` to the `query` request parameter `cursor`. The server only issues cursors in URL-safe base64 and has always refused any other cursor with 400, so no request that worked stops working.
- 2026-11-14 GET /api/v2/organizations/{organizationId}/reactions added the pattern `^[A-Za-z0-9_-]+$` to the `query` request parameter `cursor`. The same cursor, and the same refusal of any other.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/bots request property `harness` was restricted to a list of enum values. The server has always refused a harness outside OpenBot's harness list with 400; the enum is that list, and api/openapi-harnesses.test.ts keeps the two the same.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/capabilities/translate removed the enum constraint from the `changes/items/capability` response property for the response status `200`. The operation was described today and no release serves it yet. When the model's changes don't check, they come back as written so the admin can see what failed, and a model can name a permission that isn't one; `check` says so.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/capabilities/translate the `changes/items/scopeId` response property's maxLength was unset from `200` for the response status `200`. The same changes, as the model wrote them.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/capabilities/translate the `changes/items/scopeId` response's property pattern `^[^\x00]*$` was removed for the status `200`. The same changes, as the model wrote them.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/network-policies/translate removed the enum constraint from the `rules/items/type` response property for the response status `200`. The operation was described today and no release serves it yet. When the model's entries don't parse, they come back as written so the admin can fix them; `check` says which failed.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/network-policies/translate the `rules/items/ports` response property's maxLength was unset from `100` for the response status `200`. The same entries, as the model wrote them.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/network-policies/translate the `rules/items/value` response property's maxLength was unset from `253` for the response status `200`. The same entries, as the model wrote them.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/network-policies/translate the `rules/items/value` response property's minLength was unset from `1` for the response status `200`. The same entries, as the model wrote them.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/people/{personId}/stop-computers removed the required property `failed/items/botId` from the response with the `200` status. The operation was described today and no release serves it yet. A computer that would not stop is a person's own or a Bot's, so it is named as `stopped` names it, in `computer`; the server has always answered that way.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/capabilities/preview the `changes/items/capability` request property's maxLength was set to `100`. The property was a list of the permission ids and is now any text the answer's `check` judges; every id the list held is shorter than that, so nothing accepted before is refused.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/capabilities/preview added the pattern `^[^\x00]*$` to the request property `changes/items/capability`. The same property; no permission id holds a NUL.
