# Feishu Bot

OpenBot receives Feishu messages through the official Node SDK long connection. No public webhook is required.

## Configure Feishu

1. Create an internal app in Feishu Open Platform.
2. Enable Bot capability.
3. Under event subscriptions, select long connection and subscribe to `im.message.receive_v1`.
4. Grant permissions required to receive messages and send/reply to messages.
5. Publish the app and install it in the tenant.
6. Configure OpenBot:

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_TENANT_KEY=xxxxxxxxxxxxxxxx
OPENBOT_APP_URL=https://openbot.example.com
```

All three `FEISHU_*` values are required together. Without them, Feishu stays disabled. `OPENBOT_APP_URL` must be HTTPS except for local `http://localhost` development; OpenBot uses it for account-link URLs.

## Behavior

- Direct messages route to an accessible OpenBot coworker.
- Group messages run only when the Bot is mentioned.
- First message returns an account-link URL when the Feishu identity is not linked.
- Linked identities are re-authorized against current OpenBot role and revocation state on every message.
- Conversation binding includes provider, tenant, chat, and Feishu thread/message ID. Slack and Feishu IDs cannot collide.
- Replies use Feishu markdown and reply to the triggering message.
- OpenBot starts one long-connection client per process. Feishu dispatches each event to one client when replicas share credentials.

## Verify

Send a direct message naming a coworker. Complete the link flow if prompted, then send again. Confirm reply appears in Feishu and conversation appears in OpenBot sidebar with `Feishu` badge.
