/**
 * Back from linking the company account on Android, after the app's process died mid-sign-in.
 *
 * The company's sign-in opens in a Custom Tab in the app's own task (src/link-company.ts, BROWSER_OPTIONS). When the
 * process dies while it is open (the system reclaimed it, or it was force-stopped), the task keeps only the browser's
 * activity. OpenBot's linked page then opens openbotmobile://company-sign-in/linked with NEW_TASK and CLEAR_TOP, and
 * CLEAR_TOP has no MainActivity to clear down to (singleTask, as Expo generates it, doesn't either), so a new
 * MainActivity lands on top of the tab, and Back from Home showed the sign-in form again.
 *
 * So MainActivity, created for that link while it is not the root of its task, starts itself again in a task of its
 * own (NEW_TASK and CLEAR_TASK, which takes the tab away) with the same link, and finishes. Nothing else changes: a
 * launch from the icon, a switch back from recents, and the link while the app is open (delivered to the MainActivity
 * already there) never reach it.
 */
const { withMainActivity } = require("expo/config-plugins");
const {
  mergeContents,
} = require("@expo/config-plugins/build/utils/generateCode");

/** The deep link OpenBot's linked page opens: RETURN_ADDRESS in src/link-company.ts. */
const LINKED = "openbotmobile://company-sign-in/linked";

const COLD_START = `    if (!isTaskRoot && intent?.data?.toString() == "${LINKED}") {
      startActivity(
        android.content.Intent(intent)
          .setClass(this, MainActivity::class.java)
          .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
      )
      finish()
      return
    }`;

/** MainActivity.kt with the restart added after `super.onCreate`, once. */
function addLinkedColdStart(source) {
  return mergeContents({
    src: source,
    newSrc: COLD_START,
    tag: "openbot-linked-cold-start",
    anchor: /super\.onCreate\(/,
    offset: 1,
    comment: "//",
  }).contents;
}

function withLinkedColdStart(config) {
  return withMainActivity(config, (activity) => {
    if (activity.modResults.language !== "kt")
      throw new Error(
        "openbot-linked-cold-start expects the Kotlin MainActivity Expo generates.",
      );
    activity.modResults.contents = addLinkedColdStart(
      activity.modResults.contents,
    );
    return activity;
  });
}

module.exports = withLinkedColdStart;
module.exports.addLinkedColdStart = addLinkedColdStart;
module.exports.LINKED = LINKED;
