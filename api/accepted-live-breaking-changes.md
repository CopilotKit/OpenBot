# Accepted breaking changes to the live channels

CI fails a pull request on any change to `api/asyncapi.yaml` that could break a client (see
`api/asyncapi-diff.ts` for what counts). A line here lets exactly one such change through: it is
matched by the change's action and its path in the file, so any other change still fails. Add a line
only for a change that takes nothing from a client, and say why on the line: the date, the change in
backticks as the check prints it, and the reason.

Once the change is on the base branch, the check no longer reports it and its line matches nothing.

