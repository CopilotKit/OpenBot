# First-use starter tasks

The tour uses CopilotKit's suggestion component. It is offered before the first new conversation
with `picked-harness` or `personal-assistant`, including for existing users after updating.
Both IDs share one account-level record. The suggestions stay in that conversation;
other conversations do not show them. There is no dismiss control. The saved conversation ID does
not describe task completion.

Bot naming, harness selection, package initialization, routing, skills and system prompts are
unchanged. The conversation introduction is unchanged. The tour is a separate component under
`app/src/components/starter-tour/`.

## Automated and browser checks

Development base: `a1dfffcd227bfa4450f06e09395200d8a1f9b912`, with the starter-tour change.
Host: macOS Apple silicon. Bun 1.4.2. App build uses CopilotKit React Core 1.85.0.

- PostgreSQL integration tests exercise simultaneous claims from separate connections, preservation
  of other preferences, account isolation and explicit cleanup of an empty failed conversation.
  Ordinary deletion keeps the claim even when the activity timestamp is missing.
- Component tests use the real CopilotKit suggestion view with HTTP fixtures. They cover both IDs,
  all five messages, later conversations, busy turns, double clicks, failed sends and
  unavailable interactive UI. Browser tasks are not blocked by stale or failed setup checks.
- Route tests use the real home/new-conversation routes and ChannelChat. They check the selected
  Bot and first request, a second suggestion in the same conversation, later conversations without
  the tour, retry after a failed model save, pending in-conversation model saves and a single
  transcript error on failed turns. The model responses are fixtures.
- The production app bundle was opened in Chrome on macOS at 1280x800 and 900x700 with HTTP
  fixtures. All five suggestions were visible, there was no horizontal overflow or page error,
  and there is no dismiss control. This is a UI check, not a desktop workflow pass.

## Required candidate tests

No native installer was installed during these development checks. No flow below is
marked working from rendering, automated fixtures, or previous checklist results. Run the actual
candidate from a fresh installation and an upgraded account. Record the installer version, app
commit, backend release/image and OS for each result; the desktop shell can run a different backend.

| Suggestion | Result that proves useful work | Mac candidate | Windows x64 candidate |
| --- | --- | --- | --- |
| Summarize email | Connect Gmail from the conversation, finish consent, return to the same thread, and compare the summary and links with up to five actual unread messages. An empty inbox must be reported accurately. Test blocked sign-in recovery, cancellation and retry. No email is sent or marked read. | Not run | Not run |
| Build a trip budget | Generated controls start at $100 + $200 + $80 = $380. Change lodging to $250 and observe $430 without another model request. | Not run | Not run |
| Find weekend plans | Supply a city, verify three dated activities and their sources. Inspect the activity log to confirm search/fetch tools and no browser navigation. | Not run | Not run |
| Read a webpage | Supply a known URL. Watch the Bot open it and compare three returned facts against the page. No write. | Not run | Not run |
| Try a browser task | The Bot adds Try OpenBot to the Playwright TodoMVC demo, follows applicable approvals, reloads and confirms the saved task. Independently reload/inspect it. Existing tasks remain untouched. | Not run | Not run |

For each OS, also verify that the tour stays in its original conversation after restart; a second
conversation with either supported ID has no tour; ordinary deletion does not reset eligibility; unrelated Bots and group
conversations never show it. An unavailable capability must explain the setup gap instead of
substituting a different workflow. Neither signing in nor clicking a suggestion marks a task complete.

The active Mac installation was left intact because other work uses it. End-to-end testing needs
an isolated candidate deployment and test account. No accessible Windows x64 test target was found;
a Windows machine is required. These are remaining tests, not passing results.
