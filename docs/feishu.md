# Feishu Bot

OpenBot receives Feishu messages through the official Node SDK long connection. No public webhook is required.

## Configure Feishu

1. Create an internal app in Feishu Open Platform.
2. Enable Bot capability.
3. Under event subscriptions, select long connection and subscribe to `im.message.receive_v1`.
4. Grant permissions required to receive messages and send/reply to messages.
5. Publish the app and install it in the tenant.
6. Create a server-local credentials file readable only by the OpenBot service account:

```json
[
  {
    "appId": "cli_xxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxx",
    "tenantKey": "tenant-a"
  }
]
```

7. Point OpenBot at it:

```env
OPENBOT_FEISHU_APPS_FILE=/etc/openbot/feishu-apps.json
OPENBOT_APP_URL=https://openbot.example.com
```

`OPENBOT_FEISHU_APPS_FILE` may be absolute or relative to the server working directory. An absent setting disables Feishu. Every entry requires non-empty `appId`, `appSecret`, and `tenantKey`; `appId` and `tenantKey` must each be unique. One long connection starts per entry.

Following Botmux's application-config boundary, credentials are local deployment state. They are never accepted by a browser or chat configuration endpoint. Add applications and rotate secrets by atomically replacing this file, then restart OpenBot. `OPENBOT_APP_URL` must be HTTPS except for local `http://localhost` development; OpenBot uses it for account-link URLs.

## Behavior

- Direct messages route to an accessible OpenBot coworker.
- Group messages run only when the Bot is mentioned.
- First message returns an account-link URL when the Feishu identity is not linked.
- Linked identities are re-authorized against current OpenBot role and revocation state on every message.
- Conversation binding includes provider, tenant, chat, and Feishu thread/message ID. Slack and Feishu IDs cannot collide.
- Replies use Feishu markdown and reply to the triggering message.
- OpenBot starts one long-connection client per configured application per process. Feishu dispatches each event to one client when replicas share credentials.

## Verify

Send a direct message naming a coworker. Complete the link flow if prompted, then send again. Confirm reply appears in Feishu and conversation appears in OpenBot sidebar with `Feishu` badge.
