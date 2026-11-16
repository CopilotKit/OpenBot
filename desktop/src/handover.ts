/**
 * The window becoming OpenBot after a Start.
 *
 * `show_openbot` sends the window to OpenBot's own page, and the setup page stays on screen until
 * that page replaces it: a second or two, more after an update, when OpenBot's page loads for the
 * first time on its new release. Starting stays on screen meanwhile, as it was. On Windows I the
 * window said "OpenBot is running", with Show OpenBot and Stop OpenBot, for about five seconds
 * between Starting and OpenBot's home.
 *
 * `holdMs`: how long Starting stays once the window was sent to OpenBot. A page that is still here
 * after that was never replaced, and the running screen says so, with Show OpenBot to try again.
 * Tests that are about the running screen itself shorten it.
 */
export const handover = { holdMs: 20_000 };
