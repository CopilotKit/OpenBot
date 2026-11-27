# Accepted breaking changes to the live channels

CI fails a pull request on any change to `api/asyncapi.yaml` that could break a client (see
`api/asyncapi-diff.ts` for what counts). A line here lets exactly one such change through: it is
matched by the change's action and its path in the file, so any other change still fails. Add a line
only for a change that takes nothing from a client, or for an address that has been retired on
purpose, and say why on the line: the date, the change in backticks as the check prints it, and the
reason.

Once the change is on the base branch, the check no longer reports it and its line matches nothing.

- 2026-11-14 `remove /components/schemas/ThreadAgUiEventFrame/items/4/required/1`: `thread_id` is no longer required on an AG-UI event. A hosted gateway sends events without it (and without `run_id` and `organization_id`), which the file wrongly called impossible; the topic an event arrives on is its thread, and no client read the member.
- 2026-11-14 `remove /components/schemas/AgUiEvent/required/1`: the same change, where the event is defined.
- 2026-11-14 `remove /channels/legacyConversationEvents`: the address conversation events had before the API's, `/api/channels/events`, is retired. The web app opens `conversationEvents`, at `/api/v2/organizations/{organizationId}/conversation-events`, and nothing of OpenBot's opens the earlier address.
- 2026-11-14 `remove /channels/legacyBotScreen`: the address a Bot's screen had before the API's, `/api/computers/{botId}/stream`, is retired. The web app and mobile open `botScreen`, at `/api/v2/organizations/{organizationId}/computers/{botId}/screen`.
- 2026-11-14 `remove /channels/legacyBotTerminal`: the address a Bot's terminal had before the API's, `/api/computers/{botId}/terminal`, is retired. The web app opens `botTerminal`, at `/api/v2/organizations/{organizationId}/computers/{botId}/terminal`.
- 2026-11-14 `remove /operations/sendLegacyConversationEvents`: the operation of the retired conversation events address. `sendConversationEvents` carries the same messages.
- 2026-11-14 `remove /operations/sendLegacyBotScreen`: an operation of the retired screen address. `sendBotScreen` carries the same messages.
- 2026-11-14 `remove /operations/receiveLegacyBotScreenInput`: an operation of the retired screen address. `receiveBotScreenInput` takes the same messages.
- 2026-11-14 `remove /operations/sendLegacyBotTerminal`: an operation of the retired terminal address. `sendBotTerminal` carries the same messages.
- 2026-11-14 `remove /operations/receiveLegacyBotTerminalInput`: an operation of the retired terminal address. `receiveBotTerminalInput` takes the same messages.
- 2026-11-26 `add /channels/conversationEvents/bindings/ws/query`: the socket gains one optional query parameter, `capabilities`, naming the newer messages an app understands. A socket opened without it is sent what every release reads, so no client loses anything.
- 2026-11-26 `remove /components/schemas/ConversationWork/properties/kind/enum`: a kind of work is declared open (x-extensible-enum) with every value it had, so a turn the server carries can be named (turn). turn is sent only on a socket opened with the capability conversation-work-turn; every other socket is sent the work it was sent before, and busy while the turn goes on, so no released app reads a value it doesn't know.
- 2026-11-26 `add /components/schemas/ConversationWork/properties/kind/x-extensible-enum`: the same change, its open list.
- 2026-11-26 `remove /components/schemas/ConversationActivity/properties/work/items/properties/kind/enum`: the same change, where the message's work is resolved.
- 2026-11-26 `add /components/schemas/ConversationActivity/properties/work/items/properties/kind/x-extensible-enum`: the same change, its open list there.
