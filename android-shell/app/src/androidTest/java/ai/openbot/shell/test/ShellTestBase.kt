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
import org.junit.rules.TestWatcher
import org.junit.rules.Timeout
import org.junit.runner.Description
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

    /** No test runs past this; every wait inside has its own deadline (60 s at most). */
    @get:Rule
    val timeoutRule: Timeout = Timeout.seconds(280)

    /** A failing test leaves a screenshot and the page's visible text. */
    @get:Rule
    val failureEvidence = object : TestWatcher() {
        override fun failed(e: Throwable?, description: Description?) {
            try {
                screenshot("failure")
                note("at failure: foreground ${foregroundPackage()}; state ${debugState()}; page text: " +
                    pageText().take(300).replace("\n", " | "))
            } catch (error: Throwable) {
                // Evidence is best effort.
            }
        }
    }

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
        shell("wm dismiss-keyguard")
        dismissSystemDialogs()
        note("variant: $variant ($pkg)")
    }

    /** "<app> isn't responding" (a slow emulator's launcher): Wait. Never over our own app. */
    fun dismissSystemDialogs() {
        repeat(3) {
            val anr = device.findObject(By.textContains("isn't responding")) ?: device.findObject(By.textContains("isn\u2019t responding")) ?: return
            note("system dialog: ${anr.text}; tapping Wait")
            (device.findObject(By.text("Wait")) ?: device.findObject(By.text("Close app")))?.click()
            sleep(1_000)
        }
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
        dismissSystemDialogs()
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

    /**
     * A view by its resource id. The WebView is found by its class: Chromium replaces the WebView's
     * own accessibility node with its page tree and does not report the view's resource id.
     */
    fun res(id: String): BySelector =
        if (id == "openbot_webview") By.clazz("android.webkit.WebView").pkg(pkg) else By.res(pkg, id)
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

    /** The debug build's state line: read from the app's own view (the test runs in its process). */
    fun debugState(): String {
        if (variant != "debug") return "(no debug-state: $variant build)"
        var state: String? = null
        instrumentation.runOnMainSync {
            val registry = ActivityLifecycleMonitorRegistry.getInstance()
            val activity = listOf(Stage.RESUMED, Stage.PAUSED, Stage.STARTED, Stage.STOPPED)
                .flatMap { registry.getActivitiesInStage(it) }
                .firstOrNull { it.javaClass.name == ACTIVITY }
            state = activity?.window?.decorView?.findViewWithTag<View>("debug-state")?.contentDescription?.toString()
        }
        return state?.removePrefix("debug-state ") ?: "(no debug-state)"
    }

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

    /**
     * The page's message box: a text field in the WebView (an EditText node), or the rich editor,
     * which Chromium exposes as a plain node holding its placeholder ("Ask anything", "Message …").
     */
    fun composer(): UiObject2? {
        val web = find("openbot_webview") ?: return null
        return web.findObject(By.clazz("android.widget.EditText"))
            ?: web.findObject(By.desc("Message"))
            ?: web.findObject(By.text("Ask anything")) ?: web.findObject(By.desc("Ask anything"))
            ?: web.findObject(By.textStartsWith("Message ")) ?: web.findObject(By.descStartsWith("Message "))
    }

    /**
     * The message box's place on screen: from the accessibility tree, else (debug builds) from the
     * page itself (the editor's rect times devicePixelRatio, offset by the WebView's place).
     */
    fun composerRect(): Rect? {
        bounds(composer())?.let { return it }
        if (variant != "debug") return null
        val raw = pageString(
            "(function(){var e=document.querySelector('[aria-label=\"Message\"],[contenteditable]:not([contenteditable=\"false\"]),textarea');" +
                "if(!e)return 'null';var r=e.getBoundingClientRect();if(r.width<1||r.height<1)return 'null';" +
                "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio});})()",
        )
        if (raw == "null" || raw.isEmpty()) return null
        val json = try { org.json.JSONObject(raw) } catch (error: Exception) { return null }
        val web = bounds(find("openbot_webview")) ?: return null
        val d = json.optDouble("d", 1.0)
        return Rect(
            (web.left + json.optDouble("l") * d).toInt(), (web.top + json.optDouble("t") * d).toInt(),
            (web.left + json.optDouble("r") * d).toInt(), (web.top + json.optDouble("b") * d).toInt(),
        )
    }

    fun waitComposerRect(timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            composerRect()?.let { return it }
            sleep(500)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    /**
     * Taps the page element whose text starts with `text` (the smallest one, so a row's title, not
     * the whole list): its place from the page (debug builds), else the accessibility tree's node.
     */
    fun tapWeb(text: String, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            if (variant == "debug") {
                val raw = pageString(
                    "(function(t){var best=null;var all=document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],li,div,span,p,h1,h2,h3');" +
                        "for(var i=0;i<all.length;i++){var e=all[i];var s=(e.innerText||e.getAttribute('aria-label')||'').trim();" +
                        "if(s===t||s.indexOf(t)===0){var r=e.getBoundingClientRect();" +
                        "if(r.width>0&&r.height>0&&r.bottom>0&&r.top<window.innerHeight&&(!best||r.width*r.height<best.a))" +
                        "best={a:r.width*r.height,l:r.left,t:r.top,r:r.right,b:r.bottom};}}" +
                        "if(!best)return 'null';best.d=window.devicePixelRatio;return JSON.stringify(best);})(" +
                        org.json.JSONObject.quote(text) + ")",
                )
                val web = bounds(find("openbot_webview"))
                if (raw != "null" && raw.isNotEmpty() && web != null) {
                    try {
                        val json = org.json.JSONObject(raw)
                        val d = json.optDouble("d", 1.0)
                        val x = web.left + (json.optDouble("l") + json.optDouble("r")) / 2 * d
                        val y = web.top + (json.optDouble("t") + json.optDouble("b")) / 2 * d
                        device.click(x.toInt(), y.toInt())
                        return true
                    } catch (error: Exception) {
                        // fall through to the accessibility tree
                    }
                }
            }
            webObject(text)?.let {
                it.click()
                return true
            }
            sleep(400)
        } while (SystemClock.uptimeMillis() < deadline)
        note("tapWeb: no '$text' to tap")
        return false
    }

    /** Taps the message box near its top (where the text line is). */
    fun tapComposer(rect: Rect) {
        device.click(rect.centerX(), minOf(rect.top + 40, rect.centerY()))
    }

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
    fun signInThroughCustomTab(moment: String, shots: Boolean = true, paceMs: Long = 0): Boolean {
        val button = waitFor("sign_in_button", 20_000) ?: run {
            check(false, "$moment: no native Sign in button")
            return false
        }
        sleep(paceMs)
        button.click()
        val link = waitInCustomTab(MOCK_LINK, 40_000)
        if (link == null) {
            screenshot("$moment-no-custom-tab-link")
            note("$moment: the Custom Tab's link never showed; foreground ${foregroundPackage()}; state ${debugState()}")
            return false
        }
        note("$moment: the Custom Tab is ${link.applicationPackage}")
        if (shots) screenshot("$moment-custom-tab")
        sleep(paceMs)
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

    /** A video mark in plain decimal seconds (Kotlin prints big doubles in E notation). */
    fun mark(kind: String) = note("video-mark $kind " + String.format(java.util.Locale.US, "%.3f", System.currentTimeMillis() / 1000.0))

    /** True when the run is a recording (the video workflow): scenes paced and shortened for watching. */
    val forVideo: Boolean get() = args.getString("video") == "1"

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

    /**
     * Cloudflare's bot check in front of my.open.bot ("Performing security verification", "Verify
     * you are human"): the test stops there with a screenshot and never tries to get past it.
     */
    fun stopAtBotCheck(moment: String) {
        val text = if (variant == "debug") pageText() + "\n" + pageString("document.title") else ""
        val shown = text.contains("Performing security verification") || text.contains("Verify you are human") ||
            text.contains("Just a moment") || device.hasObject(By.textContains("Performing security verification")) ||
            device.hasObject(By.textContains("Verify you are human"))
        if (!shown) return
        screenshot("$moment-bot-check")
        note("$moment: Cloudflare's bot check is on screen (my.open.bot answered with its challenge page); stopping here")
        skip("stopped at Cloudflare's bot check on my.open.bot ($moment); the test never tries to get past it")
    }

    fun secret(name: String): String? = args.getString(name)?.takeIf { it.isNotEmpty() }

    /**
     * Google's email, password and 2-Step Verification pages, wherever they show (`root`: the
     * package showing them, the Custom Tab's browser or this app's WebView). One attempt. On the
     * 2-Step page it answers only with the account's own authenticator code, picked under "Try
     * another way". Stops (skipped with the reason) at any CAPTCHA, bot check or anything else Google
     * asks for. Values are set through accessibility and never logged.
     */
    fun googleSteps(root: String, email: String, password: String, totpSecret: ByteArray) {
        fun stopIfChallenged(step: String, allowSecondStep: Boolean = false) {
            val text = appText(root)
            val signs = mutableListOf("captcha", "unusual activity", "not a robot", "type the text you hear or see",
                "this browser or app may not be secure", "couldn’t sign you in", "couldn't sign you in",
                "try again later", "suspicious", "disallowed_useragent")
            if (!(allowSecondStep && text.contains("2-step verification"))) {
                signs += listOf("verify it’s you", "verify it's you", "confirm it’s you", "confirm it's you", "check your phone")
            }
            val sign = signs.firstOrNull { text.contains(it) }
            if (sign != null) {
                screenshot("challenge-at-${step.replace(' ', '-')}")
                note("challenged by Google at $step (page says '$sign')")
                skip("challenged by Google at $step")
            }
        }

        fun field(timeoutMs: Long): UiObject2? {
            val deadline = System.currentTimeMillis() + timeoutMs
            do {
                val match = device.findObjects(By.pkg(root).clazz("android.widget.EditText")).firstOrNull { it.isEnabled }
                if (match != null) return match
                sleep(500)
            } while (System.currentTimeMillis() < deadline)
            return null
        }

        /** Sets the value through accessibility (nothing is typed into a log), then checks its length. */
        fun fill(target: UiObject2, value: String, step: String, secure: Boolean = false): Boolean {
            target.click()
            sleep(800)
            target.text = value
            sleep(1_000)
            val now = target.text ?: ""
            // A password field reads back masked (or empty): only that it holds something is checked.
            val ok = if (secure) now.isNotEmpty() else now.length == value.length
            note("$step: field filled $ok")
            return ok
        }

        fun next() {
            val button = device.findObject(By.pkg(root).text("Next")) ?: device.findObject(By.pkg(root).desc("Next"))
            if (button != null) button.click() else device.pressEnter()
        }

        stopIfChallenged("email page")
        val emailField = field(15_000) ?: skip("no email field reachable on Google's page")
        if (!fill(emailField, email, "email")) skip("could not enter the email")
        next()
        sleep(8_000)
        screenshot("3-after-email")
        stopIfChallenged("after email")

        val passwordField = field(15_000) ?: run {
            screenshot("no-password-field")
            skip("no password field after the email step")
        }
        if (!fill(passwordField, password, "password", secure = true)) skip("could not enter the password")
        next()
        sleep(10_000)
        screenshot("4-after-password")
        stopIfChallenged("after password", allowSecondStep = true)

        var text = appText(root)
        val codePage = { t: String -> t.contains("google authenticator") || t.contains("authenticator app") || t.contains("enter code") }
        if (text.contains("2-step verification") && !codePage(text)) {
            val another = findInApp(root, "Try another way", 8_000) ?: run {
                screenshot("no-try-another-way")
                skip("the 2-Step page offered no 'Try another way'")
            }
            another.click()
            sleep(6_000)
            screenshot("5-other-ways")
            val options = appText(root)
            note("other ways offered: authenticator ${options.contains("authenticator")}, backup codes ${options.contains("backup code")}, text message ${options.contains("text message") || options.contains("sms")}")
            val option = findInApp(root, "Authenticator", 5_000) ?: skip("the authenticator app is not among Google's other ways")
            option.click()
            sleep(6_000)
            screenshot("6-authenticator-page")
            stopIfChallenged("authenticator page", allowSecondStep = true)
            text = appText(root)
        }
        if (codePage(text) || text.contains("2-step verification")) {
            val codeField = field(10_000) ?: skip("2-Step Verification page without a code field reachable")
            val code = Totp.freshCode(totpSecret)
            if (!fill(codeField, code, "code")) skip("could not enter the code")
            next()
            sleep(12_000)
            screenshot("7-after-code")
            stopIfChallenged("after code")
            val after = appText(root)
            note("the authenticator code was accepted: ${!after.contains("wrong code") && !after.contains("2-step verification")}")
        } else {
            note("no authenticator page after the password")
        }
    }

    /** Texts of everything `root` shows, lower-cased. */
    fun appText(root: String): String =
        device.findObjects(By.pkg(root)).flatMap { listOfNotNull(it.text, it.contentDescription) }.joinToString("\n").lowercase()

    fun findInApp(root: String, text: String, timeoutMs: Long): UiObject2? {
        val deadline = System.currentTimeMillis() + timeoutMs
        do {
            dismissChromeScreens()
            val found = device.findObject(By.pkg(root).textContains(text)) ?: device.findObject(By.pkg(root).descContains(text))
            if (found != null) return found
            sleep(500)
        } while (System.currentTimeMillis() < deadline)
        return null
    }

    /** What Google shows when it refuses an embedded browser, if it shows it in `root`. */
    fun googleRefusal(root: String): String? {
        val text = appText(root)
        return listOf("disallowed_useragent", "this browser or app may not be secure", "access blocked", "error 403", "use secure browsers")
            .firstOrNull { text.contains(it) }
    }

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
