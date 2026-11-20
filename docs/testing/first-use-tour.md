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
  every message, later conversations, busy turns, double clicks, failed sends and
  unavailable interactive UI. Browser tasks are not blocked by stale or failed setup checks.
- Route tests use the real home/new-conversation routes and ChannelChat. They check the selected
  Bot and first request, a second suggestion in the same conversation, later conversations without
  the tour, retry after a failed model save, pending in-conversation model saves and a single
  transcript error on failed turns. The model responses are fixtures.
- The production app bundle was opened in Chrome on macOS at 1280x800 and 900x700 with HTTP
  fixtures. All five suggestions were visible at the time, there was no horizontal overflow or page error,
  and there is no dismiss control. This is a UI check, not a desktop workflow pass.

## Required candidate tests

No native installer was installed during these development checks. No flow below is
marked working from rendering, automated fixtures, or previous checklist results. Run the actual
candidate from a fresh installation and an upgraded account. Record the installer version, app
commit, backend release/image and OS for each result; the desktop shell can run a different backend.

| Suggestion | Result that proves useful work | Mac candidate | Windows x64 candidate |
| --- | --- | --- | --- |
| Chart Hacker News | A bar chart of the current Hacker News front page by points, then the same stories listed with points and links. Compare both with the live front page. Inspect the activity log for web search or fetch tools. | Not run | Not run |
| Browse Google Maps | Watch the Bot open Google Maps in its browser, read the British Museum's Saturday opening hours, open walking directions from King's Cross, list the route step by step, and give a leave-by time that matches the hours and walking time Maps shows. Nothing is signed in to or changed. | Not run | Not run |
| Triage my inbox | Gmail's connect card appears in the conversation before any mail is read. Connect, finish consent, return to the same thread, and check the two emails it picks against the last 24 hours of mail. An empty day must be reported accurately. Test cancellation and retry. Nothing is marked read or changed. | Not run | Not run |
| Build a trip budget | Generated controls start at $100 + $200 + $80 = $380. Change lodging to $250 and observe $430 without another model request. | Not run | Not run |

For each OS, also verify that the tour stays in its original conversation after restart; a second
conversation with either supported ID has no tour; ordinary deletion does not reset eligibility; unrelated Bots and group
conversations never show it. An unavailable capability must explain the setup gap instead of
substituting a different workflow. Neither signing in nor clicking a suggestion marks a task complete.

The active Mac installation was left intact because other work uses it. End-to-end testing needs
an isolated candidate deployment and test account. No accessible Windows x64 test target was found;
a Windows machine is required. These are remaining tests, not passing results.
