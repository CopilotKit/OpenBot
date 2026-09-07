# Context.dev

A Bot with this connector granted reaches Context.dev **as the person asking**, through the official
hosted MCP server at `mcp.context.dev`. It can search the live web and company news, scrape and crawl
sites, extract structured data, parse files, retrieve brand intelligence, capture screenshots, run
large batches and monitor websites for changes.

Setting it up takes two people, and neither can do the other's half:

| Who              | Does                                   | Where                          |
| ---------------- | -------------------------------------- | ------------------------------ |
| An administrator | Enables the connector and its tools    | `/admin/plugins/context-dev`   |
| Each person      | Connects their own Context.dev account | `/settings/connected-accounts` |

There is no deployment-wide Context.dev API key. Each person authorizes their own account in the
browser, and calls use that account's access and credits.

## What an administrator does

### 1. Enable the connector

At `/admin/plugins/context-dev`, turn on **Enable for this deployment**. There is no OAuth client ID
or secret to paste: OpenBot registers itself with Context.dev on the first connection using dynamic
client registration and PKCE.

The deployment needs a public callback address derived from `OPENBOT_PUBLIC_URL`, or from the auth
base URL when that is not set. A local installation can use its loopback address.

### 2. Connect your own account and refresh tools

Use **Your account** on the same page to connect your Context.dev account, then press **Refresh
tools**. Context.dev's tool catalogue is discovered from its hosted server using the account of the
person who pressed the button; OpenBot does not borrow another person's grant.

### 3. Grant tools to a Bot

Enabling Context.dev gives no Bot access by itself. Grant only the tools that Bot needs. Every call
then passes through OpenBot's action policy and audit trail.

## What each person does

Open Context.dev under `/settings/connected-accounts` and press **Connect**. Sign in on Context.dev's
consent screen and approve the requested access. OpenBot stores the refresh token encrypted and
uses short-lived access tokens for calls.

Context.dev requests two scopes:

- `api.read` for read-only search, news, crawl, extraction, brand, screenshot and account-history
  tools;
- `api.write` for file parsing, browser-action-capable scrape tools, monitors and batch jobs.

The write classification is deliberately conservative. `web-scrape-html`,
`web-scrape-markdown` and `web-scrape-images` can run browser actions on third-party pages. Parsing,
monitor creation and batch submission can consume credits or create persistent work. These tools are
therefore governed as writes alongside updates, runs, cancellations and deletions.

## See also

- [Context.dev MCP documentation](https://docs.context.dev/install-mcp)
- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
