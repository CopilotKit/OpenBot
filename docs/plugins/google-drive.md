# Google Drive

A Bot with this connector granted reads Drive **as the person asking**. Two people asking the same
question get the answers their own accounts can see, and neither sees anything they could not open
themselves. Read-only: the scope requested is `drive.readonly`, so Google refuses a write before
this deployment has to.

Setting it up takes two people, and neither can do the other's half:

| Who               | Does                                                    | Where                                    |
| ----------------- | ------------------------------------------------------- | ---------------------------------------- |
| An administrator  | Registers the OAuth client and enables the connector    | Google Cloud console, then `/admin/plugins/google-drive` |
| Each person       | Consents with their own Google account                  | `/settings/connected-accounts/google-drive`              |

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

## What an administrator does

### 0. Enrol the project in the Developer Preview Program

The Workspace MCP servers are, in Google's words, "available as part of the Google Workspace
Developer Preview Program". A project that is not enrolled can have every other step below correct —
APIs enabled, client registered, a token Google's own `tokeninfo` endpoint validates — and still be
refused, because this gate is checked against the project rather than against the credential.

It refuses with `The caller does not have permission`, which says nothing about enrolment. Do this
first; it is the step with the least evidence that it is missing.

### 1. Enable both APIs

In a Google Cloud project, enable **both** of these:

- `drive.googleapis.com` — the Drive API
- `drivemcp.googleapis.com` — the Drive **MCP** API

Enabling the first does not enable the second. They are separate APIs, and the connector talks to the
second one. This is the single most likely reason a correctly-configured connector still returns
`403`; see [Troubleshooting](#troubleshooting).

Each other Workspace product is its own pair — Gmail is `gmail.googleapis.com` and
`gmailmcp.googleapis.com` — so the same step returns for every connector added later.

### 2. Configure the OAuth consent screen

- Scope: `https://www.googleapis.com/auth/drive.readonly`.
- While the app is in **Testing**, only accounts listed as test users can consent. Everyone who will
  connect needs to be on that list, or their consent fails with an access-denied error that says
  nothing about test users.

### 3. Create an OAuth client

Type **Web application**. Under **Authorised redirect URIs**, add this deployment's callback:

```
<OPENBOT_PUBLIC_URL>/api/plugins/oauth/callback
```

Locally that is `http://localhost:3001/api/plugins/oauth/callback` — port 3001, the API, not 3010,
the app. The callback lands on the API and redirects back to the app afterwards.

It has to match character for character: scheme, host, port, path, no trailing slash. OpenBot shows
the exact string to paste under the **Connection** section of the plugin page, built from
`OPENBOT_PUBLIC_URL` rather than from the incoming request — a redirect URI assembled from a request
header is one an attacker has a say in. Copy it from there rather than typing it.

Keep the client ID and client secret for the next step.

### 4. Enable the connector in OpenBot

At `/admin/plugins/google-drive`:

1. Turn on **Enable for this deployment**.
2. Open **OAuth client** and paste the client ID and secret. The secret is encrypted with
   `KEY_ENCRYPTION_KEY` and never read back out to the browser.
3. Press **Refresh tools**, which records the four read tools this connector implements.

That completes setup. No personal account is needed to get this far — the tool list for this
connector is OpenBot's own code rather than an answer from a remote server, so there is nothing to
authenticate in order to read it.

To check it actually works, use **Your account** on the same page: it connects *your* Google account
and returns you here. That is a personal grant like anybody else's, reaching your documents only, and
it is not part of configuring the connector — a deployment is correctly set up whether or not the
administrator ever connects.

### 5. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Every call then checks the grant, evaluates the action policy, and writes an
audit row.

## What each person does

At `/settings/connected-accounts`, Google Drive appears once an administrator has enabled it. Open it
and press **Connect**. That leaves OpenBot for Google's own consent screen — the arrow on the button
says so — and returns to the same page, which then reads **Connected** with the scope Google actually
granted.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each
call, so revoking access at Google takes effect on the next call rather than whenever a cache
expires.

### Disconnecting

**Not built yet.** Until it is, revoke it in Google's own third-party access settings
([myaccount.google.com/connections](https://myaccount.google.com/connections)), which stops this
deployment reading anything immediately. The page says the same thing rather than offering a control
that would report access withdrawn when it had not been.

## Troubleshooting

Every message below is what OpenBot actually shows. They are worth reading literally: the connector
distinguishes "the credential was refused" from "the credential was accepted and the request was
refused", and those have completely different fixes.

**Look at the audit trail first.** Every call leaves one row, written after the attempt, and the
event type is the answer to "whose problem is this":

| Row                  | Means                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| `mcp.call_rejected`  | This deployment declined. A missing grant, or a policy rule — `decision.rule` names which. |
| `mcp.call_failed`    | Permitted here, failed at the vendor. `failure` carries the vendor's own sentence. |
| `mcp.call_succeeded` | The vendor answered.                                                    |

A Bot that appears to have no access and leaves **no rows at all** never called the tool, which is a
grant problem rather than a connection problem: check that the tool is granted to *that* Bot at
`/admin/plugins/google-drive`. Enabling the connector and connecting your account both being done
still leaves each tool ungranted.

### `redirect_uri_mismatch` on the consent screen

Google is comparing the `redirect_uri` OpenBot sent against the list on the OAuth client, as exact
strings. Compare the value shown under **Connection** on the plugin page with what is registered,
character for character. Common mismatches: `127.0.0.1` against `localhost`, the app's port instead
of the API's, `https` against `http`, a trailing slash.

The client the error is about is the one whose ID is in the URL. A deployment with more than one
Google client can have the URI registered on the wrong one.

### "The vendor rejected this credential (401)"

Google will not accept the token at all. Reconnecting the account is the usual fix. If it persists,
the scopes granted do not cover this server — check what the **Access** section reports as granted
against what the connector asks for.

Worth knowing when reading raw logs: Google's MCP servers answer an unauthenticated `tools/list`
with **401 and a complete, valid tool list in the body**. A wall of successful-looking JSON in an
error is a refusal, not a parsing bug.

### "The vendor accepted the credential and refused the request (403). It said: …"

The credential is fine. Read the sentence after "It said:" — it is Google's own, and for the most
common cause it names the API and includes the console URL to enable it. That cause is
[step 1](#1-enable-both-apis): `drivemcp.googleapis.com` is not enabled, even where
`drive.googleapis.com` is.

Enabling an API takes a few minutes to propagate. Wait, then press **Refresh tools** again.

If the sentence is about access rather than an API, the account genuinely cannot see what was asked
for, which is the connector working as intended.

### "The caller does not have permission"

Google's `PERMISSION_DENIED`, arriving as an `isError` result rather than an HTTP status. It is a
statement about the **project**, not about the credential, which is what makes it so misleading: the
token is fine, and every check that a person can run says so.

Worth knowing how thoroughly fine, because it saves repeating the work. Minting an access token from
the stored refresh token and asking `https://oauth2.googleapis.com/tokeninfo` about it returns 200
with the right `aud`, the right `azp` and the granted scope — Google validating its own token. The
refusal is downstream of everything OpenBot controls.

In order of likelihood:

1. **The project is not enrolled** in the Developer Preview Program ([step 0](#0-enrol-the-project-in-the-developer-preview-program)).
2. **A scope is missing.** Google's guide lists Drive as needing `drive.readonly` *and*
   `drive.file`, added together. OpenBot requests only `drive.readonly`, deliberately: `drive.file`
   is write-capable, and the connector's read-only guarantee is currently the scope itself rather
   than only the tool classification. Widening it is a decision about what this deployment may do to
   somebody's Drive, so it is not done pre-emptively.

A missing scope usually reads as "insufficient authentication scopes" instead, which is why
enrolment is the first thing to check rather than the second.

### "You have not connected your Google Drive account."

The Bot was asked to read as somebody with no connection stored. Connect at
`/settings/connected-accounts/google-drive`. There is no fallback to a deployment-wide credential —
by design, since a fallback would answer with somebody else's access.

### The connection worked and stopped about an hour later

That is an access token with no refresh token behind it, which OpenBot refuses to store precisely so
this cannot happen; if you see it, say so, because it means something got past that check. Google
returns no refresh token when it believes the person already consented, which is why the
authorization URL sends both `access_type=offline` and `prompt=consent`.

### "The tool returned no content. Nothing was found, so there is nothing here to answer from."

Not an error. The tool ran and matched nothing, and this sentence exists so a model is told that
rather than handed an empty string it would fill in from memory.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`,
  `KEY_ENCRYPTION_KEY`.
- [Google's own guide](https://developers.google.com/workspace/guides/configure-mcp-servers) to
  configuring Workspace MCP servers.
