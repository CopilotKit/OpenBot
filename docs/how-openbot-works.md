# How OpenBot works

OpenBot gives you Bots. A Bot is an AI teammate with a job, a memory and a computer. You talk to it,
it does the work, and it asks you before anything you would want to be asked about.

Everything else in OpenBot is one of eight things a Bot has. They come in four pairs, and each one
answers a single question.

| | Primitive | The question it answers |
| --- | --- | --- |
| **Works** | Conversations | How do I give it work? |
| | Routines | When does it work without being asked? |
| **Learns** | Memory | What does it know about me and my work? |
| | Skills | What does it know how to do? |
| **Uses** | Apps | Which of my services can it reach? |
| | Computer | Where does it browse, run commands and keep files? |
| **Answers to you** | Approvals | When does it stop and ask me? |
| | Activity | What did it do? |

If something in OpenBot is not on this list, it is a kind of one of these, or a setting of one.

## One request, start to finish

You write to your Bot:

> Every Monday, send my team last week's numbers from the sales sheet.

### 1. You ask in a conversation

A **conversation** is where you give a Bot work and where it reports back. You can write, talk, or
send a file. A conversation can hold more than one Bot, and each takes the part of the work that is
its job.

### 2. It becomes a routine

You said "every Monday", so the Bot makes a **routine**: work it starts by itself. Every routine has
the same four parts.

| Part | Choices |
| --- | --- |
| **What** | The instruction, in your words. |
| **Starts** | At a time, when something happens (a new email, a pull request), or now, once. A routine can have more than one start. |
| **Does** | Acts, within your approvals. Or only tells you what it found. |
| **Until** | You stop it. Or it is done, when you gave it an outcome to reach. |

This one starts every Monday, acts, and runs until you stop it. A routine with an outcome to reach is
what you would call a goal, and it shows its progress. A routine that only tells you is a check-in:
it watches something that keeps changing and raises what needs you.

A Bot's routines are one list, and each reads as a sentence:

- Every Monday at 9. Sends the sales numbers.
- When a pull request opens. Reviews it, until the release ships.
- Every day. Watches the launch brief and tells you.

A routine reports into the conversation you asked in. You make, change and stop routines by asking.
You can also make one on the Routines page, by answering the same four parts.

### 3. It checks its memory

**Memory** is what a Bot knows about you and your work: who is on your team, which sheet is "the
sales sheet", how you like numbers shown. Facts you add are shared with all your Bots. Facts a Bot
picks up while working stay with that Bot.

### 4. It follows a skill

A **skill** is a named way of doing a task, called with `/`. Here it is the report you approved last
month: the columns, the order, the tone of the email. A skill is made in one of three ways: you write
it, you show the Bot the task once and it records the steps, or OpenBot proposes one from your
conversations.

### 5. It reads the sheet through an app

An **app** is a service the Bot uses as you: Google Sheets, Gmail, Notion. You connect an app once,
on the Connections page.
The Bot never sees your sign-in. A service that takes a key gets it from your vault.

### 6. It opens the dashboard on its computer

One number lives on a website that has no app. The Bot has a **computer** with a browser, a command
line and files that stay between tasks. It signs in with a login from your vault, which fills the
page without the Bot reading it. When a page needs you, such as a passkey or a code on your phone, you take
control, do that step, and hand it back. Folders on your own machine that you let a Bot use are part
of its computer too.

### 7. It asks before it sends

**Approvals** decide when a Bot stops and asks. Sending, sharing, posting and deleting ask every
time. Paying is always handed to you. Everything else follows your rules: you can let ordinary
changes happen, or be asked about each one. The Bot shows what it is about to do, and you allow it
or not.

### 8. It is all on the record

**Activity** is the record of what a Bot did: what it read, changed and sent, what it was refused,
and what you approved. Approvals are the check before an action. Activity is the check after.

## The Bot itself

A Bot has a name and instructions that say what its job is. That is its **Setup**. You start with one
Bot, the Personal Assistant, which can do a bit of everything. Make another Bot when a job has its own
sources, its own schedule or its own rules. A Bot with one job builds memory and skills for that job,
so you explain it once.

## Your vault

The eight are things a Bot has. The **vault** is yours. It holds your saved logins and your keys, and
a Bot never sees what is in it: OpenBot fills the page or signs the app in, and the secret stays out
of the conversation and out of memory.

Apps and the computer both draw on the vault, and neither keeps secrets of its own. There is one
place to look for a secret, to change it and to remove it.

## Two scopes, and a third for teams

Each primitive can be set in two places, and nowhere else:

- **Every Bot**: your default. An app you connect, a skill you write, a rule you set. These are in
  Settings, and apps are on Connections.
- **This Bot**: what one Bot has that the others don't, or what it is kept from. These are on the
  Bot's page.

OpenBot for a team adds one scope above these:

- **Everyone**: what an admin sets for the whole team. The same eight primitives, with the admin
  deciding what people and their Bots may use. Admin groups its pages by them, in the same order,
  then Vault, then the team itself.

There is nothing in the team edition that is a ninth primitive. People, sign-in and policy are how an
admin sets the eight for everyone.

## Where you find each one

The eight keep one order wherever they are listed: on a Bot's page, in Settings, in Admin, in these
docs and in the first-run tour. The order is not a quota. A list shows a primitive only when there
is something to set there:

- **Conversations** has nothing to configure. It is where the work happens, so it leads the docs and
  the tour and is not a settings row.
- **Activity** for one Bot opens from the Bot's page itself, beside what it is working on, and is not
  a settings row either.
- **Memory** is listed only where OpenBot offers it. The personal edition does not yet.

| Primitive | Holds | Every Bot | This Bot | No longer a separate name |
| --- | --- | --- | --- | --- |
| Conversations | One Bot or several, messages, voice, files and results | The sidebar | The Bot's page | channel, group, chat |
| Routines | One list. Each has what, starts, does and until | Settings → Routines | Routines | Goals, Check-ins, responsibilities, triggers |
| Memory | Facts about you, facts a Bot learned, which apps it learns from | Settings → Memory | Memory | Capabilities |
| Skills | Skills you wrote, skills you taught, skills OpenBot proposed and their review | Settings → Skills | Skills | Learning, What it can do, Skills and access |
| Apps | Connected accounts and their tools | Connections | Apps | plugins, connected accounts |
| Computer | Browser, files, commands, folders on your machine | Settings → Computer | Computer | Browsers, This computer |
| Approvals | What always asks, your rules, auto-review | Settings → Approvals | Approvals | Approval rules, "Ask before making changes" |
| Activity | Everything allowed, refused and failed | Settings → Activity | The Bot's page | Audit |

The names in the last column may stay as labels inside a page, and "goal" and "check-in" stay as
words a Bot uses in conversation. They stop being places of their own. Teach a Bot stays as the page
where you record a task; the skills it makes are listed under Skills.

The vault sits beside the eight, in your settings. It replaces Saved logins, Passwords, Keys and
Credentials as separate places.

## Rules for adding to OpenBot

1. A new feature is described as a kind of one of the eight. If it can't be, it needs a strong case
   to become a ninth.
2. One question has one answer. Two pages never answer the same question at the same scope.
3. The order is fixed: Conversations, Routines, Memory, Skills, Apps, Computer, Approvals, Activity.
   A list may leave one out. It never reorders them or adds a row with nothing to set.
4. One word per thing, in the app, in the docs and in the copy glossary.

## Open decisions

- **A goal with several starts.** Today a goal can have several triggers and a routine that runs it.
  Here that is one routine with several starts. Check it against goals people have made.
- **Storage for routines.** Routines, goals and check-ins are three systems today. This page unifies
  what a person sees. Whether the storage merges is a separate decision.
- **One editor for skills.** A skill you wrote, a skill you taught and a skill OpenBot proposed each
  open in their own editor today. They are one list; whether they become one editor is not decided.
- **The vault in the team edition.** An admin's shared credentials are Admin → Vault, apart from
  your own. Whether they become the "everyone" scope of one vault is not decided.
