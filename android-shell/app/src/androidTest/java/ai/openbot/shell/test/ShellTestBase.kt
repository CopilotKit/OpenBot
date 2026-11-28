package ai.openbot.shell.test

import android.app.Activity
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONTokener
import org.junit.After
import org.junit.AssumptionViolatedException
import org.junit.Before
import org.junit.Rule
import org.junit.rules.TestName
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Shared launch, wait, evidence and assertion helpers. The tests drive the app the way a person
 * does, through UiAutomator (the native views, the WebView's accessibility tree, Chrome's Custom
 * Tab, the system UI); debug tests also read the page with JavaScript through the app's own WebView
 * (they run in the app's process).
 *
 * Each test runs in its own `am instrument` call (android-shell/ci/run_tests.py), so a test named
 * `..._2_relaunch` starts in a new process: a real cold relaunch of the app that the test before it
 * left behind.
 *
 * Servers the tests expect, reached from the emulator through `adb reverse` (the workflow starts
 * them): the probe site on 8765/8766, a silent server on 8797, mock stack A (with the hand-off) on
 * 3010, mock stack B (without) on 3011, and the late stack on 3012.
 */
abstract class ShellTestBase {
    @get:Rule
    val testNameRule = TestName()

    protected val instrumentation = InstrumentationRegistry.getInstrumentation()
    protected val device: UiDevice = UiDevice.getInstance(instrumentation)
    protected val args: Bundle = InstrumentationRegistry.getArguments()
    private val softFailures = mutableListOf<String>()

    /** The app under test: the debug build this test runs in, unless a class drives another one. */
    open val pkg: String get() = instrumentation.targetContext.packageName

    /** "debug", or "releaseTest" for the classes that drive the release-like build. */
    open val variant: String get() = "debug"

    val testName: String get() = testNameRule.methodName

    @Before
    fun baseSetUp() {
        device.wakeUp()
        shell("input keyevent KEYCODE_MENU")
        note("variant: $variant ($pkg)")
    }

    @After
    fun baseTearDown() {
        if (softFailures.isNotEmpty()) {
            val message = softFailures.joinToString("\n- ", prefix = "${softFailures.size} check(s) failed:\n- ")
            softFailures.clear()
            throw AssertionError(message)
        }
    }

    // Checks that let the test go on (like XCTest's continueAfterFailure). ------------------------

    fun check(condition: Boolean, message: String): Boolean {
        if (!condition) {
            softFailures.add(message)
            note("CHECK FAILED: $message")
        }
        return condition
    }

    fun checkEquals(expected: Any?, actual: Any?, message: String) =
        check(expected == actual, "$message: expected <$expected> but was <$actual>")

    fun skip(reason: String): Nothing {
        note("skipped: $reason")
        throw AssumptionViolatedException(reason)
    }

    // Launching. --------------------------------------------------------------------------------

    /**
     * Starts the app's activity with the test's extras. `base` null: the app's own default
     * (my.open.bot). A new task each time unless `clearTask` is false (back from the background).
     */
    fun launch(
        base: String?,
        moment: String,
        reset: Boolean = true,
        plain: Boolean = false,
        auto: Boolean = false,
        extras: Map<String, String> = emptyMap(),
        clearTask: Boolean = true,
    ) {
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClassName(pkg, ACTIVITY)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (clearTask) intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
        intent.putExtra("openbot.diagnostics", "1")
        intent.putExtra("openbot.test_name", "$testName-$moment")
        if (base != null) intent.putExtra("openbot.base_url", base)
        if (reset) intent.putExtra("openbot.reset", "1")
        if (plain) intent.putExtra("openbot.plain_webview", "1")
        if (auto) intent.putExtra("openbot.handoff_auto", "1")
        for ((key, value) in extras) intent.putExtra(key, value)
        instrumentation.targetContext.startActivity(intent)
        device.wait(Until.hasObject(By.pkg(pkg).depth(0)), 15_000)
        sleep(800)
    }

    /** Back from the background: the launcher's intent, no extras, the existing task. */
    fun bringBack() {
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClassName(pkg, ACTIVITY)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        instrumentation.targetContext.startActivity(intent)
        device.wait(Until.hasObject(By.pkg(pkg).depth(0)), 15_000)
        sleep(1_000)
    }

    fun shell(command: String): String = try {
        device.executeShellCommand(command)
    } catch (error: IOException) {
        ""
    }

    fun sleep(ms: Long) = SystemClock.sleep(ms)

    // Elements. ---------------------------------------------------------------------------------

    fun res(id: String): BySelector = By.res(pkg, id)
    fun find(id: String): UiObject2? = device.findObject(res(id))
    fun exists(id: String): Boolean = device.hasObject(res(id))
    fun waitFor(id: String, timeoutMs: Long): UiObject2? = device.wait(Until.findObject(res(id)), timeoutMs)
    fun waitGone(id: String, timeoutMs: Long): Boolean = device.wait(Until.gone(res(id)), timeoutMs) ?: false

    enum class Tab(val key: String, val title: String) {
        CONVERSATIONS("conversations", "Conversations"), HOME("home", "Home"), BOTS("bots", "Bots")
    }

    /** A tab of the native bottom bar (BottomNavigationView item, resource id tab_<name>). */
    fun tab(tab: Tab): UiObject2? {
        find("tab_${tab.key}")?.let { return it }
        val bar = find("bottom_nav") ?: return null
        return bar.findObject(By.desc(tab.title)) ?: bar.findObject(By.text(tab.title))?.parent
    }

    fun waitForTab(tab: Tab, timeoutMs: Long): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            tab(tab)?.let { return it }
            sleep(300)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    fun tabGone(timeoutMs: Long): Boolean = waitGone("bottom_nav", timeoutMs)

    /** Text in the WebView (or anywhere): a node whose text or content description holds it. */
    fun webObject(text: String): UiObject2? =
        device.findObject(By.text(text)) ?: device.findObject(By.desc(text))
            ?: device.findObject(By.textContains(text)) ?: device.findObject(By.descContains(text))

    fun waitWebObject(text: String, timeoutMs: Long): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            webObject(text)?.let { return it }
            sleep(400)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    fun firstWebObject(texts: List<String>, timeoutMs: Long): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            for (text in texts) webObject(text)?.let { return it }
            sleep(400)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    fun debugState(): String =
        device.findObject(By.descStartsWith("debug-state"))?.contentDescription?.removePrefix("debug-state ") ?: "(no debug-state)"

    fun stateValue(key: String): String? =
        debugState().split(" ").firstOrNull { it.startsWith("$key=") }?.substringAfter("=")

    fun waitForState(fragment: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            if (debugState().contains(fragment)) return true
            sleep(300)
        } while (SystemClock.uptimeMillis() < deadline)
        return false
    }

    /** Whether the software keyboard is up: the app's own state (debug) or the input method service. */
    fun keyboardShown(): Boolean {
        if (variant == "debug" && stateValue("keyboard") == "1") return true
        val dump = shell("dumpsys input_method")
        return dump.contains("mInputShown=true") || dump.contains("isInputViewShown=true")
    }

    fun waitKeyboard(shown: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            if (keyboardShown() == shown) return true
            sleep(300)
        } while (SystemClock.uptimeMillis() < deadline)
        return false
    }

    /** The page's message box: a text field in the WebView. */
    fun composer(): UiObject2? = find("openbot_webview")?.findObject(By.clazz("android.widget.EditText"))

    fun dismissKeyboardIfUp() {
        if (!keyboardShown()) return
        note("the keyboard was up; putting it away with Back")
        device.pressBack()
        waitKeyboard(false, 3_000)
    }

    // The page itself (debug builds: the test runs in the app's process). ------------------------------

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findWebView(view.getChildAt(i))?.let { return it }
        return null
    }

    /** Evaluates `script` in the app's WebView and answers evaluateJavascript's raw JSON result. */
    fun pageJs(script: String, timeoutMs: Long = 5_000): String? {
        if (variant != "debug") return null
        var result: String? = null
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val registry = ActivityLifecycleMonitorRegistry.getInstance()
            val activity: Activity? = listOf(Stage.RESUMED, Stage.PAUSED, Stage.STARTED, Stage.STOPPED)
                .flatMap { registry.getActivitiesInStage(it) }
                .firstOrNull { it.javaClass.name == ACTIVITY }
            val web = activity?.window?.decorView?.let { findWebView(it) }
            if (web == null) latch.countDown() else web.evaluateJavascript(script) { value ->
                result = value
                latch.countDown()
            }
        }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return result
    }

    fun pageString(script: String): String {
        val raw = pageJs(script) ?: return ""
        return try {
            (JSONTokener(raw).nextValue() as? String) ?: raw
        } catch (error: Exception) {
            raw
        }
    }

    fun pageText(): String = pageString("document.body ? document.body.innerText : ''")

    fun waitPageText(text: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            if (pageText().contains(text)) return true
            sleep(400)
        } while (SystemClock.uptimeMillis() < deadline)
        return false
    }

    /** The normal mobile web app's own navigation: the sidebar toggle. */
    fun assertNoWebNavigation(moment: String) {
        val inPage = pageString(
            "String(!!document.querySelector('[aria-label=\"Toggle Sidebar\"],[aria-label=\"Show sidebar\"],[aria-label=\"Hide sidebar\"],[data-sidebar=\"trigger\"]'))",
        )
        check(inPage != "true", "$moment: the web app drew its own sidebar toggle")
        for (label in listOf("Show sidebar", "Hide sidebar", "Toggle Sidebar")) {
            check(!device.hasObject(By.desc(label)), "$moment: the web app drew its own '$label' button")
        }
    }

    // The lock screen. ----------------------------------------------------------------------------

    fun assertLockScreen(reason: String?) {
        check(exists("offline_lock"), "no lock screen")
        val heading = find("offline_lock_heading")?.text
        val message = find("offline_lock_message")?.text
        checkEquals(LOCK_HEADING, heading, "the lock screen's heading")
        checkEquals(LOCK_MESSAGE, message, "the lock screen's text")
        check(exists("retry_button"), "the lock screen has no Try again")
        checkEquals("Try again", find("retry_button")?.text, "the Try again button's label")
        checkEquals("support@open.bot", find("support_email")?.text, "the support address")
        check(device.hasObject(By.text("Need help?")), "no 'Need help?' before the address")
        if (reason != null && variant == "debug") check(debugState().contains("lock=$reason"), "lock reason $reason; state: ${debugState()}")
    }

    // Chrome's Custom Tab. ---------------------------------------------------------------------------

    /** Chrome's first-run and promotion screens, if any show despite the command-line flags. */
    fun dismissChromeScreens(): Boolean {
        var dismissed = false
        for (label in listOf("Accept & continue", "Accept & Continue", "Use without an account", "No thanks", "No, thanks", "Got it", "Not now", "Skip")) {
            val button = device.findObject(By.text(label)) ?: continue
            if (button.applicationPackage == pkg) continue
            note("Chrome showed '$label'; tapped it")
            button.click()
            dismissed = true
            sleep(1_500)
        }
        return dismissed
    }

    /** Waits for `text` in another app (the Custom Tab), dismissing Chrome's own screens on the way. */
    fun waitInCustomTab(text: String, timeoutMs: Long): UiObject2? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            dismissChromeScreens()
            val found = device.findObject(By.text(text)) ?: device.findObject(By.desc(text))
            if (found != null && found.applicationPackage != pkg) return found
            sleep(500)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    fun foregroundPackage(): String = device.currentPackageName ?: ""

    /** Signs in on mock stack A through the Custom Tab, tapping the mock page's link like a person. */
    fun signInThroughCustomTab(moment: String, shots: Boolean = true): Boolean {
        val button = waitFor("sign_in_button", 20_000) ?: run {
            check(false, "$moment: no native Sign in button")
            return false
        }
        button.click()
        val link = waitInCustomTab(MOCK_LINK, 40_000)
        if (link == null) {
            screenshot("$moment-no-custom-tab-link")
            note("$moment: the Custom Tab's link never showed; foreground ${foregroundPackage()}; state ${debugState()}")
            return false
        }
        note("$moment: the Custom Tab is ${link.applicationPackage}")
        if (shots) screenshot("$moment-custom-tab")
        link.click()
        sleep(1_500)
        // Chrome may ask before leaving for an app.
        for (label in listOf("Open", "Continue", "Open app")) {
            val prompt = device.findObject(By.text(label))
            if (prompt != null && prompt.applicationPackage != pkg) {
                note("$moment: Chrome asked before opening the app ('$label')")
                prompt.click()
            }
        }
        val home = waitForTab(Tab.HOME, 45_000)
        if (home == null) {
            screenshot("$moment-sign-in-did-not-finish")
            note("$moment: signing in did not reach the tabs; foreground ${foregroundPackage()}; state ${debugState()}")
            return false
        }
        return true
    }

    fun launchSignedIn(moment: String = "signed-in"): Boolean {
        launch(MOCK_A, moment)
        val ok = signInThroughCustomTab(moment, shots = false)
        check(ok, "signing in on mock stack A did not reach the tabs; state ${debugState()}")
        return ok
    }

    // The real backend. --------------------------------------------------------------------------------

    fun requireProduction() {
        val status = try {
            val connection = URL("$PRODUCTION/").openConnection() as HttpURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 15_000
            connection.instanceFollowRedirects = false
            val code = connection.responseCode
            connection.disconnect()
            code
        } catch (error: IOException) {
            -1
        }
        if (status <= 0 || status >= 500) skip("my.open.bot is not reachable from this emulator (status $status)")
    }

    fun secret(name: String): String? = args.getString(name)?.takeIf { it.isNotEmpty() }

    // Evidence. ----------------------------------------------------------------------------------------

    /** A screenshot through screencap, named <test>--<moment>.png, pulled by the runner. */
    fun screenshot(moment: String) {
        val name = "$testName--$moment".replace(Regex("[^A-Za-z0-9._-]+"), "-")
        shell("mkdir -p $SHOTS")
        shell("screencap -p $SHOTS/$name.png")
    }

    /** A line the CI summary picks up (never a secret or personal data). */
    fun note(text: String) {
        Log.i("SHELL_NOTE", "$testName: $text")
    }

    fun bounds(obj: UiObject2?): Rect? = try {
        obj?.visibleBounds
    } catch (error: Exception) {
        null
    }

    companion object {
        const val ACTIVITY = "ai.openbot.shell.ShellActivity"
        const val MOCK_A = "http://localhost:3010"
        const val MOCK_B = "http://localhost:3011"
        const val LATE = "http://localhost:3012"
        const val PROBE = "http://127.0.0.1:8765/"
        const val SILENT = "http://127.0.0.1:8797/"
        const val PRODUCTION = "https://my.open.bot"
        const val MOCK_LINK = "Sign in as test person"
        const val SHOTS = "/data/local/tmp/openbot-shots"
        const val LOCK_HEADING = "Cannot reach the OpenBot backend"
        const val LOCK_MESSAGE = "For security purposes, this application can only be used when connected to the OpenBot backend. Please check your internet connection, VPC configuration and network settings to make sure this device can reach the OpenBot backend. Contact your system administrator if you are unable to connect."
    }
}
