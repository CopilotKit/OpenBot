import { expect, test } from "bun:test";
import config from "../mobile/app.config";
import { RETURN_ADDRESS } from "../mobile/src/link-company";

/**
 * The phone's release APK, back from linking the company account after its process died mid-sign-in: the deep link
 * started it cold on top of the Custom Tab left in its task, and Back from Home showed the company's sign-in form.
 * mobile/plugins/linked-cold-start.js has MainActivity start again in a task of its own for that link.
 */

const plugin = require("../mobile/plugins/linked-cold-start") as {
  addLinkedColdStart: (source: string) => string;
  LINKED: string;
};

/** MainActivity.kt as Expo 55's prebuild writes it (`expo prebuild --platform android`), up to its onCreate. */
const GENERATED = `package ai.openbot.mobile

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

test("the app's config adds the cold-start restart to MainActivity", () => {
  expect(config.plugins).toContain("./plugins/linked-cold-start");
});

test("created for the linked deep link while the Custom Tab is its task's root, MainActivity starts again in a task of its own, which takes the tab away", () => {
  const activity = plugin.addLinkedColdStart(GENERATED);
  const onCreate = activity.slice(
    activity.indexOf("override fun onCreate"),
    activity.indexOf("override fun getMainComponentName"),
  );
  // After super.onCreate, as an activity must call it before it finishes.
  expect(onCreate.indexOf("super.onCreate(null)")).toBeLessThan(
    onCreate.indexOf("isTaskRoot"),
  );
  // Only for that link, and only when something else is the root of the task: the icon, recents, and the link while
  // the app is open never reach it.
  expect(onCreate).toContain(
    `if (!isTaskRoot && intent?.data?.toString() == "openbotmobile://company-sign-in/linked") {`,
  );
  expect(onCreate).toContain(
    "android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK",
  );
  expect(onCreate).toContain(".setClass(this, MainActivity::class.java)");
  expect(onCreate).toMatch(/finish\(\)\s+return\s+\}/);
  // Prebuild run again changes nothing.
  expect(plugin.addLinkedColdStart(activity)).toBe(activity);
});

test("the link it restarts for is the one OpenBot's linked page opens", () => {
  expect(plugin.LINKED).toBe(RETURN_ADDRESS);
});
