# The phone app

**Before you change a request this app makes, or the client generated from the API spec
(`src/api/generated`), read [docs/api-and-migrations.md](../docs/api-and-migrations.md). Not
optional.**

Released phone apps stay on people's phones for months. The server serves every app released in the
last 12 months, and this app works against any server released in the last 12 months. So this app
is a tolerant reader: it ignores a field it doesn't know, reads an enum value it doesn't know as
"other" and never sends it back, and shows a feature only when the server's `deployment` answer
offers it. `tests/tolerant-reader.test.ts` and `tests/unknown-statuses.test.ts` hold it to that.

Never edit `src/api/generated` by hand. Change the spec under `api/openapi/` and run
`bun run api:generate` from the repository root.
