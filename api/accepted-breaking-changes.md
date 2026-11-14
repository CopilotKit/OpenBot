# Accepted breaking changes

CI fails a pull request on any change to `api/openapi.yaml` that oasdiff calls breaking. A line here
lets exactly one such change through: oasdiff matches a line by its method and path and the change's
own words, so any other breaking change still fails. Add a line only for a change that takes nothing
from a client, and say why on the line: the date, the change as oasdiff words it, and the reason.

Once the change is on the base branch, oasdiff no longer reports it and its line matches nothing.

- 2026-11-14 GET /api/v2/organizations/{organizationId}/bots added the pattern `^[A-Za-z0-9_-]+$` to the `query` request parameter `cursor`. The server only issues cursors in URL-safe base64 and has always refused any other cursor with 400, so no request that worked stops working.
- 2026-11-14 GET /api/v2/organizations/{organizationId}/reactions added the pattern `^[A-Za-z0-9_-]+$` to the `query` request parameter `cursor`. The same cursor, and the same refusal of any other.
- 2026-11-14 POST /api/v2/organizations/{organizationId}/bots request property `harness` was restricted to a list of enum values. The server has always refused a harness outside OpenBot's harness list with 400; the enum is that list, and api/openapi-harnesses.test.ts keeps the two the same.
