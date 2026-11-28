# channel-telegram

OpenTag-shaped Telegram front for OpenBot **Reaching you**.

It holds a Telegram bot token, allow-lists only the chat that sends OpenBot's
`link <code>` message, forwards that chat's messages to OpenBot's OpenTag AG-UI
agent, and accepts proactive replies on `/openbot/deliver`.

## Why it lives here

OpenBot reaches Slack and Teams through [OpenTag](https://github.com/CopilotKit/OpenTag).
Telegram is not in OpenTag yet ("coming soon" there). This package is the
smallest front that speaks the same pairing OpenBot already has, so a server
that accepts provider `telegram` can finish two-way personal messaging without
waiting on OpenTag's own Telegram adapter.

## Run

```bash
cd channel-telegram
export TELEGRAM_BOT_TOKEN=…          # from BotFather
export OPENTAG_SHARED_SECRET=…       # ≥32 chars; same as OpenBot
export OPENBOT_AGENT_URL=https://openbot.example/api/delivery/webhooks/opentag/agent
export PUBLIC_URL=https://telegram-front.example
bun src/index.ts
```

On OpenBot:

```dotenv
OPENTAG_SHARED_SECRET=…   # same secret
OPENTAG_URL=https://telegram-front.example
```

Then under a Bot's **Reaching you**, use **Connect Telegram** once the
deployment lists Telegram among its notification transports (the OpenBot
server image must offer it).

## Allow-list

Only the Telegram chat that successfully sends the link code may talk. Other
chats are told how to link (if none is linked yet) or refused. That is the
safer default for a personal bot token.

## Server requirement

OpenBot's OpenTag sender parser must accept `telegram` beside `slack` and
`teams` (`parseChannelUser` in the delivery module). Until a published image
does, inbound turns will not bind. See [docs/channels/telegram.md](../docs/channels/telegram.md).
