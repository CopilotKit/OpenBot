# Telegram (Reaching you)

Two-way personal messaging with a Bot through Telegram: the person pastes a
BotFather token under **Reaching you**, sends the one-time `link <code>` to that
bot, and only that chat is allow-listed afterwards.

## What this repository ships

| Piece | Where |
| --- | --- |
| API contract | `connectTelegramDestination`, transport `telegram` in `api/openapi/notifications.yaml` |
| Web UI | Bot → **Reaching you** → **Connect Telegram** |
| OpenTag-shaped front | [`channel-telegram/`](../../channel-telegram/) |
| Notification routing | Settings → Notifications lists Telegram once the deployment offers it |

## How it fits the existing pairing

Slack and Teams reach OpenBot through [OpenTag](https://github.com/CopilotKit/OpenTag):
OpenTag calls OpenBot at `/api/delivery/webhooks/opentag/agent`, and OpenBot
posts proactive replies to OpenTag's `/openbot/deliver`.

`channel-telegram` speaks that same contract for Telegram. It is a stopgap
until OpenTag's own Telegram adapter ships (OpenTag documents Telegram as
coming soon). Point OpenBot's `OPENTAG_URL` at it, and set the same
`OPENTAG_SHARED_SECRET` on both sides.

Prefer the **personal bot token** path under Reaching you when the OpenBot
server implements `connectTelegramDestination` (token stored encrypted on the
server, webhook on OpenBot). The `channel-telegram` front is for deployments
that pair Telegram the OpenTag way with one bot token on the front.

## Safer defaults

- **Allow-list only the linking chat.** Messages from any other Telegram chat
  are refused; nothing runs.
- **Link codes in a direct message.** A code posted in a group is refused (same
  rule as Slack Reachability codes).
- **Bot tokens never round-trip.** `connectTelegramDestination` accepts the
  token and never returns it. The answer carries the bot's username and the
  command only.
- **Away notifications on local Desktop still need a reachable server.**
  Telegram, like Slack, Teams, SMS and push, needs OpenBot where the internet
  can call it. OpenBot Desktop's local personal edition has nowhere for those
  callbacks to land until it is paired with a public deployment (see Settings →
  Notifications empty state).

## What the OpenBot server image must do

The public tree no longer contains `server/` ([#1530](https://github.com/CopilotKit/OpenBot/pull/1530)).
Reviewed against `CopilotKit/OpenBot` at `6d1919a3` (last commit with
`server/src/delivery`). Apply the same ideas to the private image build:

1. **`ChatTransport` / `BindingTransport`** — add `"telegram"`.
2. **`parseChannelUser`** in `opentag.ts` — accept provider `telegram` beside
   `slack` and `teams` (`telegram:<botId>:<chatId>`).
3. **`createOpenTagTransport.send`** — pass `platform: "telegram"` through to
   `/openbot/deliver` when the binding's transport is telegram.
4. **`listNotificationTransports`** — include `telegram` when the Telegram
   channel is configured (OpenTag-shaped front URL + secret, or built-in
   Telegram webhook support).
5. **`connectTelegramDestination`** — validate the token with Telegram
   `getMe`, store it encrypted, create a delivery challenge with transport
   `telegram`, return `{ botUsername, code, command, expiresAt }`. On the
   inbound webhook (or OpenTag agent path), when the allow-listed chat sends
   `link <code>`, bind `identity`/`address` to that chat id and realm to the
   bot id.
6. **Database** — `delivery_bindings.transport` is already text; no migration
   required to store `telegram` (expand-only). Keep 12-month API compatibility
   as in [api-and-migrations.md](../api-and-migrations.md).

Until those land, the UI shows Telegram only when the deployment lists it, and
`channel-telegram` can still be developed and tested against a server that has
the parser change.

## Follow-ups

- **WhatsApp** — same Reaching you / destination shape; Meta Cloud API token and
  phone number id instead of a BotFather token; allow-list the person's WhatsApp
  number after a link or OTP step.
- **Two-way SMS** — outbound SMS and STOP/START already exist via Twilio.
  Closing the loop for a full chat surface (not only notifications) needs the
  same destination binding semantics Telegram uses, with clearer product copy
  that a text thread is a conversation continuation.
