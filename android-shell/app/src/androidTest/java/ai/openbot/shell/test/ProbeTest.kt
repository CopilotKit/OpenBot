package ai.openbot.shell.test

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Web view basics: the debug build's plain mode (one full-screen WebView, no native sign-in, no
 * bottom bar) against the probe site (android-shell/probe), so the probe measures the WebView alone.
 */
@RunWith(AndroidJUnit4::class)
class ProbeTest : ShellTestBase() {
    private val rowPattern = Regex("^[a-z-]+: (pass|fail|skip|info) .*")

    @Test
    fun testProbeSite() {
        launch(PROBE, "probe", plain = true)
        check(waitFor("openbot_webview", 30_000) != null, "the web view never appeared")
        val finished = waitPageText("probe done", 60_000)
        screenshot("probe-site")
        val lines = pageText().lines().map { it.trim() }.filter { it.isNotEmpty() }
        val rows = lines.filter { rowPattern.matches(it) }
        for (row in rows) Log.i("SHELL_PROBE", "PROBE_ROW $row")
        if (!check(finished, "the probe page never showed 'probe done'")) return
        val summary = lines.firstOrNull { it.startsWith("probe done") } ?: ""
        Log.i("SHELL_PROBE", "PROBE_SUMMARY $summary")
        val failed = rows.filter { it.contains(": fail ") }
        check(failed.isEmpty(), "probe rows failed: $failed")
        find("openbot_webview")?.swipe(androidx.test.uiautomator.Direction.UP, 0.9f)
        sleep(800)
        screenshot("probe-site-scrolled")

        val button = waitWebObject("Open popup", 10_000)
        if (!check(button != null, "no Open popup button")) return
        button!!.click()
        val popupShown = waitPageText("popup page loaded", 20_000)
        screenshot("probe-popup")
        check(popupShown, "window.open did not load the popup page in the same web view")
        note("after the popup: foreground ${foregroundPackage()}")
    }

    @Test
    fun testOfflineShowsRetry() {
        // Nothing listens on 8799 (adb reverse refuses it at once): the same lock screen as no network.
        launch("http://127.0.0.1:8799/", "refused", plain = true)
        val retry = waitFor("retry_button", 30_000)
        screenshot("load-failed-lock")
        check(retry != null, "the lock screen with Try again did not appear")
        assertLockScreen("load-failed")
        retry?.click()
        sleep(2_000)
        check(waitFor("retry_button", 30_000) != null, "after Try again the lock should stay, since nothing listens")
    }

    @Test
    fun testWatchdogCatchesSilentLoad() {
        // 8797 accepts the connection and never answers: only the 20 s watchdog can show the lock.
        launch(SILENT, "silent", plain = true)
        val shown = waitFor("retry_button", 40_000)
        screenshot("watchdog-lock")
        check(shown != null, "the load watchdog did not show the lock screen within 40 s")
        assertLockScreen("load-failed")
    }

    @Test
    fun testSessionSurvivesRelaunch() {
        launch(PROBE, "first", plain = true, extras = mapOf("openbot.base_url" to PROBE + "persist.html?reset=1"))
        check(waitPageText("returning visitor:", 30_000), "persist.html never answered")
        check(waitPageText("state saved", 15_000), "persist.html never saved its cookie and localStorage value")
        screenshot("persist-first-launch")
        check(pageText().contains("returning visitor: no"), "the reset visit should be a first visit: ${pageText().take(200)}")
        // The activity flushes the cookie store when it pauses; give storage time to reach the disk.
        device.pressHome()
        sleep(5_000)
    }

    /** Runs right after testSessionSurvivesRelaunch, in a new process. */
    @Test
    fun testSessionSurvivesRelaunch_2_relaunch() {
        launch(PROBE, "second", reset = false, plain = true, extras = mapOf("openbot.base_url" to PROBE + "persist.html"))
        check(waitPageText("returning visitor:", 30_000), "persist.html never answered after the relaunch")
        screenshot("persist-after-relaunch")
        val text = pageText().replace("\n", " | ")
        Log.i("SHELL_PROBE", "PERSIST_RESULT $text")
        check(text.contains("returning visitor: yes"), "cookie or localStorage did not survive a cold relaunch: $text")
    }

    /** What the WebView reports about itself, for the summary. */
    @Test
    fun testWebViewIdentity() {
        launch(PROBE, "identity", plain = true)
        check(waitPageText("probe done", 60_000), "the probe page never finished")
        val ua = pageString("navigator.userAgent")
        note("user agent: $ua")
        check(ua.contains("OpenBotShell-Android/"), "the user agent lacks the shell's mark: $ua")
        check(ua.contains("; wv)"), "the user agent lacks Android WebView's '; wv' mark (Google's sign-in looks for it): $ua")
        val injected = pageString("JSON.stringify(window.__OPENBOT_NATIVE_SHELL__ || null)")
        note("__OPENBOT_NATIVE_SHELL__ on the probe origin (the base origin of this launch): $injected")
        check(injected.contains("\"platform\":\"android\""), "the shell marker was not injected on the base origin: $injected")
        note("bridge object on the page: ${pageString("String(typeof window.OpenBotShellAndroid)")}")
        note("webview package: ${shell("dumpsys webviewupdate").lines().firstOrNull { it.contains("Current WebView package") }?.trim()}")
    }

    /** window.open with no address, from a tap: the app's WebView keeps its page (no blank page). */
    @Test
    fun testBlankWindowOpenKeepsThePage() {
        launch(PROBE, "blank-open", plain = true)
        check(waitPageText("probe done", 60_000), "the probe page never finished")
        pageJs("(function(){var b=document.createElement('button');b.textContent='Open blank window';" +
            "b.style.cssText='position:fixed;top:40%;left:10%;width:80%;height:80px;z-index:99999;font-size:20px';" +
            "b.onclick=function(){window.__blank=window.open('', '_blank');};document.body.appendChild(b);return true;})()")
        sleep(800)
        check(tapWeb("Open blank window"), "no button to tap")
        sleep(3_000)
        screenshot("after-blank-window-open")
        val text = pageText()
        check(text.contains("probe done"), "a blank window.open replaced the app's page: ${text.take(120)}")
        note("after a blank window.open: url ${pageString("location.href")}; foreground ${foregroundPackage()}")
    }
}
