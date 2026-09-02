# Mailbox

The Mailbox connector gives a Bot the deployment's mail: it can list what has arrived, open a message, search
for one, and send mail, including a threaded reply. "Check the support mailbox and tell me what came
in overnight" is a mailbox question, and so is "reply to Dana and say we will have it by Friday."

The mailbox belongs to the deployment. It is not the mailbox of whoever is asking, and no person
connects an account to it. That is the difference from Google Drive or Notion, where each person
consents for themselves and sees only their own; here everybody granted the tools reads the same
mail. Decide that before granting it, because it is the whole of the access model.

A deployment may configure several accounts on one pair of hosts, which is what a shared host gives
you: `support@`, `sales@` and `billing@` are three mailboxes on one IMAP and one SMTP server, with a
password each. Every tool takes an optional `account` to say which one to work in; leaving it out
works in the first configured, the default.

**Grants are per tool, not per account.** A Bot granted `list_messages` can list every configured
account, and one granted `send_message` can send from any of them. There is no per-account grant and
no way to give a Bot one mailbox out of three. If an account must stay out of a Bot's reach, do not
configure it on this deployment.

## The prerequisite

Two things, and both are an administrator's:

1. **Configuration**, which says where the mailbox is and which accounts are on it (below).
2. **Grants**, which say which Bots may use it. Mailbox is a catalogue entry like any other, at
   `/admin/plugins/mailbox`, and enabling the entry hands no Bot anything. Each of the four tools is
   granted per Bot, so "may read the mail" and "may answer it" are two separate decisions.

`send_message` is the connector's only write tool, and it is a write in the strongest sense this
product has: it reaches people who never agreed to talk to a Bot, and there is nothing to recall once
it has run. Grant it deliberately, and consider a policy rule that requires approval for it the same
way one would for any other irreversible action.

## Configuration

| Variable             | Default | What it is                                                        |
| -------------------- | ------- | ----------------------------------------------------------------- |
| `MAILBOX_IMAP_HOST`  | unset   | The IMAP server messages are read from.                           |
| `MAILBOX_SMTP_HOST`  | unset   | The SMTP server mail is sent through.                             |
| `MAILBOX_USERS`      | unset   | Comma-separated addresses on those hosts. The first is the default account. |
| `MAILBOX_USER`       | unset   | The singular this shipped with, read as a list of one. Both set refuses to start. |
| `MAILBOX_IMAP_PORT`  | `993`   | Implicit TLS. Set only for a server that listens elsewhere.        |
| `MAILBOX_SMTP_PORT`  | `465`   | Implicit TLS. Set only for a server that listens elsewhere.        |
| `MAILBOX_ALLOWED_RECIPIENT_DOMAINS` | unset (anywhere) | Comma-separated domains a Bot may send to. See [Bounding where mail can go](#bounding-where-mail-can-go). |

The three hosts-and-users variables are needed together. Set one or two and the server refuses to
start, naming the ones that are missing, rather than booting with half a mailbox that fails at the
first login, at run time, in front of somebody, with nothing but an authentication error from a
server that will not say which half was wrong. Leave all three unset and the connector is still
listed, still grantable, and every tool call answers with the sentence naming what to set.

`MAILBOX_USERS` is a list, so `support@example.com,sales@example.com` is two accounts and
`support@example.com` is one. The order matters: the first is the default. Addresses are lower-cased
and deduplicated, and an entry that is not an address refuses to start, naming it, rather than
becoming an account a model can select and nothing can unlock. `MAILBOX_USER` is still read as a
list of one for a deployment that already had it; setting both refuses to start, because they are
two answers to the same question.

Both ports default to the implicit-TLS ones rather than the STARTTLS ones, so the connection is
encrypted before the password is sent rather than negotiating for it in the clear.

### The passwords are not environment variables

They are the only secrets in this feature, so they live where this deployment's other secrets live:
the encrypted credential vault. Store **one credential per account** at `/admin/credentials` as:

- **kind** `mcp`, the vault's name for "the one token this deployment holds for this server", which
  is exactly what a mailbox password is: one secret, the deployment's, used for every Bot granted the
  tools, never anybody's own grant.
- **provider** `mailbox`
- **key id** the address exactly as it is configured, lower-cased: `support@example.com`.

So a deployment with three accounts holds three rows, each rotated and revoked on its own. An
account with no stored password is refused by name, naming that account and the key id to store it
under, while the accounts that do have one keep working.

Rotate in the same place. A password is read from the vault at the moment a call needs it and thrown
away after, so a rotation takes effect on the next tool call rather than on the next restart, and
revoking it stops that account within a call.

Nothing prints one. IMAP logging is off at the client, which matters because one of the commands it
would log is the authentication one; and a failure sentence from a mail server that quoted the login
back is scrubbed before it reaches an audit row, a transcript or a model. The scrub covers the
base64 forms as well as the plaintext, because neither client sends the password as typed: IMAP
authenticates with `AUTH=PLAIN` or `AUTH=LOGIN`, both base64 on the wire, so a quoted command
carries an encoding of it rather than the password itself.

## The four tools

Every one of them takes two arguments about where to look, and they are different things:

- **`account`** is an email address, one of the configured ones, and it says which mailbox to open.
  It defaults to the first configured. An account this deployment does not have is refused before
  the vault is read and before anything is dialled, and the refusal lists the ones that exist.
- **`folder`** is an IMAP folder inside that account, such as `INBOX`, `Sent` or `Archive`, and it
  defaults to `INBOX`.

**A configured address in `folder` is adopted rather than refused.** If the value is one of this
deployment's own accounts, and `account` is either unset or the same address, it is taken as the
account, the folder falls back to `INBOX`, and the answer opens with one line saying so: "[folder
took the address support@example.com; it was used as account, reading INBOX.]" There is exactly one
mailbox that value can mean and the model named it, so refusing would spend a whole turn teaching
vocabulary before any work happens, and live runs show the mistake on the first mailbox call of a
turn. The note teaches the same lesson on the way past.

Two neighbouring cases are still refused before anything is dialled, because neither is unambiguous:

- **An address in `folder` that is not a configured account.** There is nothing to adopt, so the
  refusal says to pass it as `account` instead.
- **`folder` holding one configured address while `account` names a different one.** Two arguments
  naming two mailboxes is a model that has lost track of which it is reading. The refusal names
  both.

**The part before the @ of a configured account is refused too**, and deliberately not adopted:
`support` is not an address, and a folder genuinely called `support` can exist.

None of this is hypothetical. A smaller model given a `mailbox` argument and an `account` argument
put the address in the first one, was answered "Character not allowed in mailbox name" by the IMAP
server, and never tried the second; refused that, it retried with `support` and then `webmaster`,
which are the local parts of two configured accounts, and was answered "Mailbox doesn't exist:
support". The argument is named `folder`, says in its own description that it is neither an address
nor half of one, and is listed after `account` so that is the argument a model meets first.

A folder that genuinely is not there is answered with the folders that are: "No folder named
Newsletters in support@example.com. Folders here: INBOX, Sent, Archive. The account is chosen by
`account`, not by folder; leave folder unset for INBOX." The listing costs one `LIST` on the
connection that was already open, inside the same deadline, and it is what turns the vendor's
"Mailbox doesn't exist" into something a model can act on rather than retry against.

Every answer names both, so a turn that reads two accounts cannot merge them and a model reading the
result learns the vocabulary: "showing 10 of 236 messages in folder INBOX of support@example.com,
newest first."

- **`list_messages`**: the newest messages in a mailbox, newest first: uid, date, sender, subject
  and whether it has been read. No bodies. `limit` defaults to 10 and is capped at 50.
- **`read_message`**: one message by `uid`, with its headers and its text.
- **`search_messages`**: messages whose subject, sender or text match `query`, newest first.
  `limit` defaults to 20. The match is the mail server's own IMAP `SEARCH`: a plain substring, with
  no ranking and no boolean syntax.
- **`send_message`**: sends `to`, `subject` and `body` from the deployment's mailbox, and files a
  copy in the account's Sent folder. Give `in_reply_to` as the uid of a message and the reply
  threads: the original is fetched, its `Message-ID` becomes `In-Reply-To`, its own `References`
  chain plus that id becomes `References`, and `Re: ` goes in front of the subject if it is not
  already there. Without it, the message opens a new thread however the subject is worded.

The sender is always the selected account, and the confirmation says which. There is no `from`
field, so a Bot cannot send as somebody else.

### The copy in Sent

SMTP delivers a message; it does not file one. So a send that did nothing else would leave the
account's Sent folder empty, webmail showing nothing sent, and a Bot unable to find its own outgoing
mail. That is not hypothetical: a person checking the mailbox concluded three messages had never
been sent, and all three had been delivered.

So the message is built once as raw bytes, those bytes are what SMTP delivers, and the same bytes
are appended to the account's Sent folder, marked `\Seen`. Delivered and stored are then byte for
byte the same message, down to the `Message-ID`, which is what makes a send verifiable: the
confirmation names the folder ("A copy is in folder Sent.") and the message id, so a Bot can list
that folder and find what it just sent.

The folder is resolved by its IMAP special-use flag first, which is the answer that survives a
localised server, and by the names `Sent`, `Sent Items` and `Sent Messages` on a server that marks
nothing. An account where neither finds one files no copy rather than guessing, since appending to
the wrong folder would put outgoing mail where a person reads it as incoming.

**A copy that could not be filed is never reported as a send that failed.** Filing is a separate
operation against a separate server and happens after delivery, so it can fail on a message that has
already gone. The confirmation then says the mail was sent, names the reason no copy exists, and
says not to send it again. A model told only that something failed would send the message a second
time, and mail cannot be recalled.

**A server that stops answering mid-send is reported as unconfirmed, not as failed.** SMTP confirms
a message with one reply after the data has gone, and a socket that times out, drops or hits the
deadline before that reply arrives leaves this deployment not knowing whether the message was
delivered. That case gets its own sentence: delivery is unknown and may have happened, do not send it
again, tell the person who asked, and here is the message id so a duplicate can be found if they
decide to resend. A refusal the server actually wrote ("Relay access denied", a rejected recipient)
is still a plain failure, since that message was not sent and may be corrected. The rule errs
towards unconfirmed: the transport cannot tell a greeting that never arrived from a reply that never
arrived after the data, so both are held back, and one look by a person costs less than a
recipient's second copy. No copy is filed in Sent for an unconfirmed send, because a Sent folder
holding a message that may never have gone would mislead the other way.

**Uids are per folder, and a folder belongs to one account.** A uid from a listing of `Archive`
names a different message in `INBOX`, and a uid from `support@`'s INBOX names a different message in
`sales@`'s, so every tool that takes one also takes the `folder` and the `account` it came from. A
uid that is not there is refused by name rather than guessed at, and for `send_message` nothing is
sent.

**Every result is bounded.** At most 512 KB of a message is read off the wire, so one mail with a
large attachment cannot become a gigabyte in this process; a message body is then cut at 8,000
characters and says so, with the full length, so a model can tell a message that has said what it
came to say from one that has not; and the whole result is capped again at the same 20,000
characters every other connector's is. A listing or a search that had more behind it says
"showing 10 of 4321" rather than presenting a page as the whole mailbox. Truncation is always
visible, never silent.

**Every call has a deadline.** Sixty seconds of wall clock per network operation, on top of the
thirty-second inactivity timeouts, and the socket is closed when it expires. The inactivity timeouts
alone would let a server that drips one byte at a time hold a turn open forever.

**Nothing is changed by reading.** Opening a message does not mark it read, move it or delete it, and
there is no tool that does. A connection is opened, used and closed per call; no session is kept.

## Bounding where mail can go

`MAILBOX_ALLOWED_RECIPIENT_DOMAINS` is a comma-separated list of domains (`example.com,partner.example`;
a leading `@` is accepted and dropped). Set it and `send_message` refuses any recipient outside the
list before it opens a connection, naming the domain that was refused and saying nothing was sent.
Unset or empty means anywhere, so a deployment that has not set it behaves exactly as before.

**Why this exists rather than a policy rule.** The policy engine sees a tool call's name and its
effect. It does not see the arguments, so no rule can say "may email the company and nobody else":
the only thing a rule can express about `send_message` is whether it happens at all. That leaves a
deployment two controls, and they do different jobs:

1. **An approval rule on `send_message`** in your boundaries. Wholesale, per send, with a person in
   the loop. This is the control that decides whether mail goes out.
2. **This allowlist.** Bounds where anything can go, with nobody in the loop.

**The shape worth protecting against.** The read tools pull text that somebody else wrote into a
model's context, and that text can contain instructions. A Bot holding the read tools and an
unconstrained `send_message` can therefore be talked into mailing the mailbox out, by an email
addressed to it, with no person involved at any point. That is why `send_message` should be
approval-gated wherever the mailbox holds anything worth keeping, and why the allowlist is worth
setting even when it is gated: it is the half that still holds if a rule is edited or a mode is
switched to dry-run.

## Governance

Nothing about a Mailbox tool call is special. It goes through `plugins/store.ts` like every other
connector: the Bot's grant is checked and the policy is evaluated with the tool's effect
(`send_message` as a write, the other three as reads) before any mail server is dialled. There is no
second path to the mailbox and no bypass.

The audit row is written in the same order as for every other connector, which is attempt first and
record second. A refusal is the only row written before the call goes out; the outcome row,
`mcp.call_succeeded` or `mcp.call_failed`, is written after the mail server has answered, so that it
records what happened rather than what was permitted. For `send_message` that ordering has one
consequence worth knowing: a process that dies between the server accepting the message and the row
being written has delivered a message the trail does not hold. The copy filed in Sent is the record
that survives that window.

The grant is per tool. It is not per account, and the policy engine cannot make it one, for the same
reason it cannot bound recipients: a rule sees a tool call's name and effect, never its arguments.
A Bot granted the mailbox tools reaches every configured account.

The audit trail records every call, and for a failure it keeps the mail server's own sentence, which
is usually the most useful thing available: "Invalid credentials", "Mailbox does not exist" and
"Relay access denied" each name a different fix.

## See also

- [Configuration](configuration.md): every environment variable, in one table.
- [Architecture](architecture.md): where a plugin call is decided, recorded and made.
- [Routines](routines.md): the other first-party connector that runs in-process, and the one to read
  next if you want a Bot to check the mailbox on a schedule.
