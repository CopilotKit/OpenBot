package ai.openbot.shell.test

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.junit.Test
import org.junit.runner.RunWith

/** The native screens at the largest font scale, labels for TalkBack, a tablet size and rotation, a killed renderer. */
@RunWith(AndroidJUnit4::class)
class HardeningTest : ShellTestBase() {
    @Test
    fun testLargestFontScale() {
        try {
            shell("settings put system font_scale 2.0")
            sleep(1_000)
            launch(MOCK_A, "font-2x")
            check(waitFor("sign_in_button", 15_000) != null, "no Sign in button at font scale 2.0")
            val button = bounds(find("sign_in_button"))
            check(button != null && button.bottom <= device.displayHeight, "the Sign in button is off screen at font scale 2.0 ($button)")
            sleep(800)
            screenshot("1-first-screen-font-2x")
            launch(MOCK_A, "font-2x-lock", extras = mapOf("openbot.force_offline" to "1"))
            check(waitFor("offline_lock", 10_000) != null, "no lock screen at font scale 2.0")
            // The lock screen scrolls: Try again and the support address must be reachable.
            val retry = device.findObject(By.res(pkg, "retry_button")) ?: find("offline_lock")?.let { lock ->
                lock.scroll(androidx.test.uiautomator.Direction.DOWN, 1f)
                find("retry_button")
            }
            check(retry != null, "Try again is not reachable at font scale 2.0")
            screenshot("2-lock-font-2x")
            launch(MOCK_A, "font-2x-dark", extras = mapOf("openbot.force_offline" to "1", "openbot.force_dark" to "1"))
            check(waitFor("offline_lock", 10_000) != null, "no lock screen at font scale 2.0 in dark mode")
            screenshot("3-lock-font-2x-dark")
        } finally {
            shell("settings put system font_scale 1.0")
        }
    }

    @Test
    fun testAccessibilityLabels() {
        launch(MOCK_A, "labels")
        checkEquals("Sign in", find("sign_in_button")?.text, "the Sign in button's spoken label")
        check(device.hasObject(By.text("OpenBot")), "the first screen's heading")
        if (!launchSignedIn("labels-signed-in")) return
        for (title in listOf("Conversations", "Home", "Bots")) {
            val item = find("bottom_nav")?.findObject(By.desc(title)) ?: find("bottom_nav")?.findObject(By.text(title))
            check(item != null, "the $title tab has no spoken label")
        }
        launch(MOCK_A, "labels-lock", reset = false, extras = mapOf("openbot.force_offline" to "1"))
        check(waitFor("offline_lock", 10_000) != null, "no lock screen")
        checkEquals("Try again", find("retry_button")?.text, "Try again's spoken label")
        checkEquals("support@open.bot", find("support_email")?.text, "the support address's spoken label")
        check(find("support_email")?.isClickable == true, "the support address is not a button for TalkBack")
    }

    @Test
    fun testTabletSizeAndRotation() {
        try {
            shell("wm size 1600x2560")
            shell("wm density 320")
            sleep(2_000)
            if (!launchSignedIn("tablet")) return
            check(waitPageText("Start a conversation", 30_000), "Home did not render at tablet size")
            sleep(1_500)
            screenshot("1-tablet-portrait")
            device.setOrientationLandscape()
            sleep(3_000)
            screenshot("2-tablet-landscape")
            val web = bounds(find("openbot_webview"))
            val bar = bounds(find("bottom_nav"))
            note("tablet landscape: web view $web, bottom bar $bar, display ${device.displayWidth}x${device.displayHeight}")
            check(web != null && bar != null && web.bottom <= bar.top + 3, "landscape: the web view and the bar overlap ($web, $bar)")
            check(pageText().contains("Start a conversation"), "rotation lost the page")
        } finally {
            device.setOrientationNatural()
            shell("wm size reset")
            shell("wm density reset")
        }
    }

    @Test
    fun testRendererKilledRecovers() {
        if (!launchSignedIn("renderer")) return
        check(waitPageText("Start a conversation", 30_000), "Home did not render")
        sleep(1_500)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE)) skip("this WebView cannot terminate its renderer")
        val commitsBefore = stateValue("commits")
        var terminated = false
        instrumentation.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()
            fun find(view: View): WebView? {
                if (view is WebView) return view
                if (view is ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
                return null
            }
            val web = activity?.window?.decorView?.let { find(it) }
            terminated = web?.let { WebViewCompat.getWebViewRenderProcess(it)?.terminate() } ?: false
        }
        note("renderer terminated: $terminated")
        if (!terminated) skip("the renderer could not be terminated")
        val skeleton = waitFor("loading_skeleton", 5_000) != null
        note("the skeleton showed after the renderer died: $skeleton")
        screenshot("1-after-renderer-killed")
        check(waitPageText("Start a conversation", 25_000), "the page did not come back after the renderer died")
        check(waitForTab(Tab.HOME, 5_000) != null, "no tabs after the renderer died")
        note("commits before $commitsBefore, after ${stateValue("commits")}")
        screenshot("2-recovered")
    }
}
