# Per-Bot browser profile usage

`GET /computers/profile-usage` uses the existing computer-token authentication and
`x-openbot-bot-id` identity validation. It accepts no path, query parameters, or mutation command.
It returns only `{ "profileBytes": 1234 }` or `{ "profileBytes": null }`. It does not start a
browser, create a profile/session, stop a browser, or read file contents.

The number is observed logical bytes of regular files in that Bot's profile, not disk allocation,
a quota, or a deletion grant. A missing profile under an accessible profile root returns zero.
Symbolic links (including Chromium's singleton links) are skipped without following their targets.
Hardlinks, special files, cross-device directories, inaccessible/changing directories and exceeded
bounds return null, never partial bytes or a path-bearing error. File contents can change while
Chromium is running; this is an on-demand measurement, not an atomic filesystem snapshot.

Traversal admits one measurement per process, at most 10,000 entries and 16 directory levels,
with a 2-second cooperative deadline checked around filesystem operations. Directory enumeration
is incremental with 32-entry buffers. The kernel can delay an individual filesystem call; the
deadline does not forcibly interrupt a blocked filesystem. The implementation uses Linux
`/proc/self/fd` anchors and `O_NOFOLLOW` for every directory opened. Platforms without that
descriptor-relative traversal return null. No user profile link is followed, including a directory
replaced with a link between inspection and opening.

Run the unit cases on Linux with `bun test agent-computer/tests/profile-usage.test.ts`; the
unsupported-platform case also runs on macOS. No browser, user account, or model is required.
