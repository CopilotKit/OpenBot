# Email

Bots can read, search and send email from **your own mailbox**. OpenBot logs in to it directly over
IMAP and SMTP (TLS only) with an app password you save. There's no service in between.

## Set it up

| Who              | Does                                                     | Where                  |
| ---------------- | -------------------------------------------------------- | ---------------------- |
| An administrator | Enables the Email connector and grants its tools to Bots | `/admin/plugins/mail`  |
| Each person      | Connects their own mailbox with an app password          | Settings → Email       |

1. Make an app password for your mailbox. For Gmail, turn on 2-Step Verification, then make one at
   `myaccount.google.com/apppasswords`. Yahoo, iCloud, Fastmail, AOL and Zoho have the same thing.
2. In Settings → Email, type your address and the app password and press **Connect**. OpenBot
   logs in once to check it before saving. The password is encrypted with `KEY_ENCRYPTION_KEY` and
   is never shown again.
3. Grant a Bot the Email tools at `/admin/plugins/mail`.

Common providers have their servers filled in automatically. For anything else, OpenBot tries
`imap.<your domain>` and `smtp.<your domain>`, or you can type the servers yourself. Microsoft
accounts (Outlook, Hotmail) often don't allow app passwords any more, so they may not connect.

## The tools

| Tool            | What it does                                              | Kind  |
| --------------- | --------------------------------------------------------- | ----- |
| `list_emails`   | The newest emails in a folder, optionally unread only     | read  |
| `search_emails` | Emails that mention some words or come from someone       | read  |
| `read_email`    | One email in full, with the names of any attachments      | read  |
| `send_email`    | Sends from your address, including replies                | write |

- The mailbox used is always the one belonging to the person whose run it is. A Bot can't name
  another person's mailbox.
- Reading never marks mail as read or moves it.
- `send_email` is a write, so the action policy governs it, and a new grant asks you first.
- Email is other people's words. Everything a tool returns is marked as untrusted data before the
  model reads it, so an email saying "ignore your instructions" is only information.
