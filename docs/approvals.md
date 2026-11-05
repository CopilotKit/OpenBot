# Approvals

A Bot asks you before some actions. What asks is decided in this order, in
`server/src/approvals/policy.ts`, and the first answer wins:

1. **Safety.** Fixed rules, the same in every edition. No setting, rule or reviewer can switch them
   off.
2. **Rules.** Yours, and in the team edition the admin's. The strictest one that matches wins.
3. **Auto-review**, when you or the admin turn it on.
4. **Ask before making changes**, your own switch in Settings → Approvals. It is off unless you turn
   it on, in both editions.

A task started from a check-in asks before every change, whatever the above says.

## What always asks

| What the Bot is about to do | What you see | How it is recognised |
| --- | --- | --- |
| Pay, buy or move money: a payment, a checkout, a refund, a transfer or payout, placing an order, paying an invoice, running payroll, a paid plan | **This needs you.** You do it yourself and mark it done, or tell the Bot not to. | Payment words anywhere in the action and its page. A transfer, payout, withdrawal, charge, order, purchase, paid invoice or order, payroll run, plan upgrade or change, or app subscription in an app's tool name. A button labelled Transfer, Withdraw, Pay, Buy, Place your order, Complete purchase, Upgrade, Downgrade, Change plan, or Send with an amount, and Subscribe when its label or page is about a paid plan. |
| Change a password, two-factor setting or other credential, or security and sharing settings | **This needs you.** | Credential and security-setting words anywhere in the action and its page. |
| Delete something | **Allow once** or **Deny** | Delete, trash, destroy, erase, purge, wipe or discard in an app's tool name, or remove as its action (removing a collaborator asks as sharing). A button labelled Delete, Move to trash, Empty trash, Discard, Erase or Destroy, or exactly Remove, Yes, remove or Remove permanently. |
| Send something to other people | **Allow once** or **Deny** | Send, reply, forward, respond, notify, broadcast, invite, comment, a new message or a scheduled send in an app's tool name, or an app call addressed to someone's email address (a calendar event with attendees, for example). A button labelled Send, or exactly Comment or Reply. Cmd+Enter or Ctrl+Enter in the browser, and Enter in a box for writing a message, a reply or a comment. |
| Share something with other people | **Allow once** or **Deny** | Share, sharing, a shared link, permissions, collaborators or granting access in an app's tool name. A button labelled Share, Invite or Add people. |
| Post or publish something | **Allow once** or **Deny** | Publish, tweet, repost or a release in an app's tool name, posting something (a comment, a photo, a thread) or creating a post. A button labelled Post, Publish, Tweet, Repost or Go live. |

None of these offers **Always allow here**: each one asks every time. A saved allow rule doesn't
reach them, because they are decided before any rule is read.

You are asked once. A Bot OpenBot runs is told that OpenBot asks before these, so it doesn't put
its own approval card in front of OpenBot's (`APPROVAL_GUIDANCE` in `shared/bot-prompt.ts`). A remote
Bot is not told so, because its own tools don't go through this policy.

They are recognised by what the action is called, never by what it carries. A document that says
"delete the old draft", a note about a purchase, or an email draft addressed to someone is an
ordinary change. In an app's tool name the action is its first verb, so a word that only names what
it acts on doesn't count: marking a comment as spam, bookmarking or liking a post, editing a
comment, cancelling a scheduled send, or a request sent with the web's POST method
(`STRIPE_POST_V1_PLANS_OVERVIEW`). A button counts when its label starts with the action ("Delete", "Yes, delete"),
so opening a folder called Sent, a tab called Posts or a list called Shared with me is browsing.

## What doesn't ask

With Ask before making changes off, a Bot reads and makes ordinary changes without asking: drafting
an email, editing your documents, creating a calendar event for yourself, labelling mail, saving a
page, writing a file on its own computer.

A Bot's own computer is its workspace. Writing, reading and deleting files there, and the commands
it runs there, are not account actions and don't ask. Commands on your own computer follow
**Commands on your computer** in Settings → Approvals.

## What isn't recognised

- **A button with no label**, such as an icon with no accessible name. There is nothing to read.
- **Other keyboard sends**, such as Enter in a box whose label doesn't say it is for a message,
  or a mail app's own shortcut like Alt+S. Ctrl+Enter that only inserts a page break asks too.
- **A button labelled with another word**, such as Confirm or Done on its own, or Remove with more
  after it. Editors and filters use that for ordinary changes ("Remove filter", "Remove formatting").
- **An app tool that names none of the words above**, such as one that trashes mail by changing its
  labels (`GMAIL_BATCH_MODIFY_MESSAGES` with the `TRASH` label). Turn on Auto-review or Ask before
  making changes, or add a rule, to cover it.
