# Empty conversation history

## What the references show

- Grok Bot places Search and New chat in two compact controls at the top of its sidebar and puts Marketplace in the footer. Its changelog also records that sidebar rows stopped showing the last message time and that new Bots introduce themselves in the chat pane. The public documentation does not show the zero-conversation sidebar. [Grok Bot changelog](https://x.ai/changelog/bot)
- Slack’s desktop DMs view puts Search and New message alongside its conversation list. It also describes the sidebar plus as a quick way to start a DM. Its documentation illustrates the populated view, so it supports the placement of controls but does not verify its first-use empty treatment. [Slack’s DM guide](https://slack.com/help/articles/212281468-Understand-direct-messages)
- Claude keeps conversation history in Recents, with View all for browsing the full list. That documents the role of the sidebar in finding past conversations. It does not show its empty state. [Claude’s conversation history guide](https://privacy.claude.com/en/articles/11117329-how-can-i-delete-or-rename-a-conversation)
- Atlassian’s empty-state component requires only a heading. Its guidance favors short, scannable language and a concrete next step when an action is useful. [Empty-state component](https://atlassian.design/components/empty-state/) · [Empty-state writing guidance](https://atlassian.design/content/designing-messages/empty-state/)

## Application to OpenBot

The sidebar already offers New conversation beside Search. Keep that as the one compose action and place a compact “No conversations yet” status where the first conversation row will appear. A separate welcome panel would repeat the existing entry point and compete with the list. Keep search with no matches distinct from a fresh conversation list.

This is an OpenBot design recommendation based on the documented patterns. The references do not establish that Grok Bot uses the same empty-state wording or layout.
