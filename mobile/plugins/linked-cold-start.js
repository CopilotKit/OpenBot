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
 *
 * Loads nothing at the top: the repository's tests read `addLinkedColdStart` where the phone's own dependencies are
 * not installed, and only `expo prebuild` runs the plugin itself, with them.
 */

/** The deep link OpenBot's linked page opens: RETURN_ADDRESS in src/link-company.ts. */
const LINKED = "openbotmobile://company-sign-in/linked";

const BEGIN = "    // @generated begin openbot-linked-cold-start";
const END = "    // @generated end openbot-linked-cold-start";

const COLD_START = [
  BEGIN,
  `    if (!isTaskRoot && intent?.data?.toString() == "${LINKED}") {`,
  "      startActivity(",
  "        android.content.Intent(intent)",
  "          .setClass(this, MainActivity::class.java)",
  "          .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)",
  "      )",
  "      finish()",
  "      return",
  "    }",
  END,
];

/** MainActivity.kt with the restart right after `super.onCreate`, once: an earlier copy is taken out first. */
function addLinkedColdStart(source) {
  const lines = source.split("\n");
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin !== -1 && end > begin) lines.splice(begin, end - begin + 1);
  const anchor = lines.findIndex((line) => line.includes("super.onCreate("));
  if (anchor === -1)
    throw new Error(
      "openbot-linked-cold-start found no super.onCreate in MainActivity.",
    );
  lines.splice(anchor + 1, 0, ...COLD_START);
  return lines.join("\n");
}

function withLinkedColdStart(config) {
  const { withMainActivity } = require("expo/config-plugins");
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
