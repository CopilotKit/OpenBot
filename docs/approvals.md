# Approvals

A Bot asks you before some actions. What asks is decided in this order, in
`server/src/approvals/policy.ts`, and the first answer wins:

1. **Kinds of action.** Deleting, sending to other people, sharing, posting, paying, and changing a
   password or account settings ask, in every edition, whatever your own switch says. They are open
   by default: you can allow each one once, for the conversation, or always. An admin can close a
   kind for everybody (see [What an admin can close](#what-an-admin-can-close)).
2. **Rules.** Yours, the admin's in the team edition, and what you allowed for this conversation.
   The strictest one that matches wins, so a team rule that asks beats anything you allowed.
3. **Auto-review**, when you or the admin turn it on.
4. **Extra vigilant**, your own switch in Settings → Approvals. It is off unless you turn
   it on, in both editions.

A task started from a check-in asks before every change, whatever the above says.

## Answering a card

| Answer | What it does |
| --- | --- |
| **Allow once** | The Bot does it this time. The next one asks again. |
| **Allow for this conversation** | The Bot does it now, and does the same action again in this conversation without asking: the same Bot, the same tool, the same place and the same account. It doesn't reach another conversation, another Bot or another tool. It ends when you turn it off (the line above the message box says what is allowed, with **Turn off**) or delete the conversation. |
| **Always allow here** | The Bot does it now, and the same action anywhere from now on. It is saved as one of your rules in Settings → Approvals, where you can remove it. |
| **Deny** | The Bot doesn't do it, and is told you said no. |

Every action run under one of these answers is still on the audit trail. A conversation answer's
row says **Allowed for this conversation**.

An allow reaches a kind of action only when it was given on that kind's card. "Always allow here" on
an ordinary click on a site does not let the Bot press that site's Send or Place your order button,
and a rule you type in Settings, or a team rule, doesn't open a kind either. A rule that asks or hands
off always applies.

## What asks

| What the Bot is about to do | How it is recognised |
| --- | --- |
| Pay, buy or move money: a payment, a checkout, a refund, a transfer or payout, placing an order, paying an invoice, running payroll, a paid plan | Payment words anywhere in the action and its page. A transfer, payout, withdrawal, charge, order, purchase, paid invoice or order, payroll run, plan upgrade or change, or app subscription in an app's tool name. A button labelled Transfer, Withdraw, Pay, Buy, Place your order, Complete purchase, Upgrade, Downgrade, Change plan, or Send with an amount, and Subscribe when its label or page is about a paid plan. |
| Change a password, two-factor setting or other credential, or security and sharing settings | Credential and security-setting words anywhere in the action and its page. For credentials the page is read by its address up to the path: a query string or fragment that carries a signature or a token (`X-Amz-Credential=`, `access_token=`) doesn't make an ordinary form a credentials page, while a password field, a Change password button or a `/security/2fa` page still does. |
| Delete something | Delete, trash, destroy, erase, purge, wipe or discard in an app's tool name, or remove or archive as its action (removing a collaborator asks as sharing). Any app tool its app marks destructive, whatever it is called. A button labelled Delete, Move to trash, Empty trash, Discard, Erase or Destroy, or exactly Remove, Yes, remove or Remove permanently. |
| Send something to other people | Send, reply, forward, respond, notify, broadcast, invite, comment, a new message or a scheduled send in an app's tool name, or an app call addressed to someone's email address (a calendar event with attendees, for example). A button labelled Send, or exactly Comment or Reply. Cmd+Enter or Ctrl+Enter in the browser, and Enter in a box for writing a message, a reply or a comment. |
| Share something with other people | Share, sharing, a shared link, permissions, collaborators or granting access in an app's tool name. A button labelled Share, Invite or Add people. |
| Post or publish something | Publish, tweet, repost or a release in an app's tool name, posting something (a comment, a photo, a thread) or creating a post. A button labelled Post, Publish, Tweet, Repost or Go live. |

Each asks with Allow once, Allow for this conversation, Always allow here and Deny.

**One exception: changing a password or other credential on a website.** The Bot would type it into
a form, and only you have it, so no answer of yours can stand in for it. It is handed to you: **This
needs you.** You do it yourself and mark it done, or tell the Bot not to. A credential an app's own
tool changes (rotating an API key, say) asks like everything else.

This reverses [#998](https://github.com/CopilotKit/OpenBot/pull/998), which made deleting, sending,
sharing and posting ask every time with Allow once and Deny only, and handed payments and account
changes to you. OpenBot opens these by default; closing them is the organisation's call.

## What an admin can close

In the team edition, **Admin → Approvals → Actions that ask first** sets each kind for everybody:

| Setting | What members see |
| --- | --- |
| **Members choose** (the default) | Allow once, Allow for this conversation, Always allow here, Deny. |
| **Ask every time** | Allow once and Deny only. What members allowed before for that kind stops applying. |
| **Members do it themselves** | **This needs you.** The Bot never does it. |

A team rule that asks or hands off also beats anything a member allowed, saved or for the
conversation. Turning **Let members set personal rules** off turns off members' conversation answers
too. Each change is on the audit trail.

You are asked once. A Bot OpenBot runs is told that OpenBot asks before these, so it doesn't put
its own approval card in front of OpenBot's (`APPROVAL_GUIDANCE` in `shared/bot-prompt.ts`). A tool
its app marks destructive can be called anything, so its description, as the Bot is offered it, also
says that OpenBot asks before it runs (`DESTRUCTIVE_TOOL_NOTE`). A remote Bot is not told so, because
its own tools don't go through this policy.

They are recognised by what the action is called, never by what it carries. A document that says
"delete the old draft", a note about a purchase, or an email draft addressed to someone is an
ordinary change. In an app's tool name the action is its first verb, so a word that only names what
it acts on doesn't count: marking a comment as spam, bookmarking or liking a post, editing a
comment, cancelling a scheduled send, listing archived mail or reading archive settings, or a
request sent with the web's POST method (`STRIPE_POST_V1_PLANS_OVERVIEW`). A button counts when its
label starts with the action ("Delete", "Yes, delete"), so opening a folder called Sent, a tab called
Posts or a list called Shared with me is browsing.

Archive asks as deleting because some apps call their delete that: HubSpot deletes a contact with
`HUBSPOT_ARCHIVE_CONTACT`, and Gmail's archive takes mail out of the inbox. Unarchive is not archiving.

An app can also say a tool destroys something, whatever it is named: an MCP server with the tool's
`destructiveHint` annotation, Composio with the same tag, and Arcade with its `destructive` flag.
OpenBot records that when it lists the app's tools (`destructive` on `mcp_tools`), and such a tool
asks as deleting does. Composio tags `HUBSPOT_ARCHIVE_CONTACT` this way. An action a broker says
nothing about (no flag from Arcade, no label from Composio) is not destructive: it is an ordinary
change, which asks only when Extra vigilant or a rule says so.

## What doesn't ask

With Extra vigilant off, a Bot reads and makes ordinary changes without asking: drafting
an email, editing your documents, creating a calendar event for yourself, labelling mail, saving a
page, writing a file on its own computer.

A Bot's own computer is its scratch space. Writing, reading and deleting files there, and the
commands it runs there, are not account actions and don't ask unless Extra vigilant,
Auto-review or a rule says so. A folder on your own computer is different: the OpenBot desktop app
asks before every edit or command in it, and **Commands on your computer** in Settings → Approvals
can refuse commands there altogether. Settings → Approvals says this above its switches.

## What isn't recognised

- **A button with no label**, such as an icon with no accessible name. There is nothing to read.
- **Other keyboard sends**, such as Enter in a box whose label doesn't say it is for a message,
  or a mail app's own shortcut like Alt+S. Ctrl+Enter that only inserts a page break asks too.
- **A button labelled with another word**, such as Confirm or Done on its own, or Remove with more
  after it. Editors and filters use that for ordinary changes ("Remove filter", "Remove formatting").
- **An app tool that names none of the words above and that its app doesn't mark destructive**, such
  as one that trashes mail by changing its labels (`GMAIL_BATCH_MODIFY_MESSAGES` with the `TRASH`
  label). Turn on Auto-review or Extra vigilant, or add a rule, to cover it.
