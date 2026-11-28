package ai.openbot.shell.test

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiObject2
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Suite 1, the parts that need a DEBUG hook: the session-cookie journey on the real backend, the
 * hosted sign-in opened in a Custom Tab, and the bare WebView on my.open.bot. A real account's
 * screenshots go only to the private artifact (android-shell/ci/collect.py).
 */
@RunWith(AndroidJUnit4::class)
class RealBackendDebugTest : ShellTestBase() {
    private val hostedSignIn = "$PRODUCTION/api/auth/hosted/sign-in?returnTo=%2F"

    /** The bare WebView (plain mode) on my.open.bot: does the hosted web app load at all. */
    @Test
    fun testLoadsHostedWebApp() {
        requireProduction()
        launch(null, "hosted", plain = true)
        check(waitFor("openbot_webview", 30_000) != null, "the web view never appeared")
        var content = false
        for (i in 0 until 30) {
            if (exists("offline_lock")) break
            if (pageText().trim().isNotEmpty()) {
                content = true
                break
            }
            sleep(2_000)
        }
        if (exists("offline_lock")) {
            screenshot("hosted-lock")
            skip("my.open.bot did not load on this runner; the shell showed its lock screen")
        }
        sleep(8_000)
        screenshot("hosted")
        note("hosted web app: title '${pageString("document.title")}', path ${pageString("location.pathname")}")
        check(content, "the web view showed no web content within 60 s")
    }

    // Cloudflare's bot check on my.open.bot (seen in the WebView after a cold relaunch). ----------------

    private fun cookieNames(): List<String> =
        (android.webkit.CookieManager.getInstance().getCookie(PRODUCTION) ?: "").split(";")
            .map { it.substringBefore("=").trim() }.filter { it.isNotEmpty() }

    private fun challengeShown(): Boolean {
        val title = pageString("document.title")
        return title.startsWith("Just a moment") || pageText().contains("Performing security verification")
    }

    /** One load of my.open.bot in the WebView: was it the bot check, and did it clear by itself. */
    private fun observeLoad(label: String) {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            if (pageString("document.readyState") == "complete" && pageString("document.title").isNotEmpty()) break
            sleep(1_000)
        }
        sleep(2_000)
        val challenged = challengeShown()
        var clearedAfter = -1
        if (challenged) {
            screenshot("$label-challenge")
            val started = System.currentTimeMillis()
            while (System.currentTimeMillis() - started < 45_000) {
                sleep(3_000)
                if (!challengeShown()) {
                    clearedAfter = ((System.currentTimeMillis() - started) / 1000).toInt()
                    break
                }
            }
        }
        screenshot(label)
        note("challenge probe, $label: bot check shown $challenged; " +
            (if (challenged) (if (clearedAfter >= 0) "cleared by itself after ${clearedAfter} s" else "still there after 45 s") else "page '${pageString("document.title")}'") +
            "; path ${pageString("location.pathname")}; cookie names ${cookieNames()}")
    }

    /**
     * Where the bot check shows: a first load, a reload, an in-process relaunch, and my.open.bot in
     * a Custom Tab (Chrome) on the same emulator. The next test is a cold relaunch. No account.
     */
    @Test
    fun testRealChallengeProbe() {
        requireProduction()
        launch(null, "load-1", plain = true)
        check(waitFor("openbot_webview", 20_000) != null, "no web view")
        note("challenge probe: user agent ${pageString("navigator.userAgent")}")
        observeLoad("1-first-load")
        pageJs("location.reload()")
        sleep(2_000)
        observeLoad("2-reload")
        launch(null, "load-3", reset = false, plain = true)
        observeLoad("3-in-process-relaunch")
        // The same address in a Custom Tab: Chrome's own user agent and cookie jar.
        launch(null, "tab", reset = false, extras = mapOf("openbot.debug_tab_url" to "$PRODUCTION/"))
        waitFor("sign_in_button", 15_000)?.click()
        var browser = ""
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            dismissChromeScreens()
            browser = foregroundPackage()
            if (browser.isNotEmpty() && browser != pkg) break
            sleep(500)
        }
        sleep(8_000)
        val text = appText(browser)
        val challenged = text.contains("performing security verification") || text.contains("just a moment")
        screenshot("4-custom-tab")
        note("challenge probe, 4-custom-tab ($browser): bot check shown $challenged; OpenBot sign-in shown ${text.contains("sign in to openbot")}")
        device.pressBack()
        // Let the cookie store reach the disk before the next test kills the process.
        device.pressHome()
        sleep(4_000)
    }

    /** Runs right after testRealChallengeProbe, in a new process. */
    @Test
    fun testRealChallengeProbe_2_relaunch() {
        requireProduction()
        note("challenge probe, before the cold relaunch: cookie names ${cookieNames()}")
        launch(null, "load-5", reset = false, plain = true)
        check(waitFor("openbot_webview", 20_000) != null, "no web view")
        observeLoad("5-cold-relaunch")
    }

    /** Texts of everything another app (the Custom Tab) shows, lower-cased. */
    private fun tabText(browser: String): String =
        device.findObjects(By.pkg(browser)).flatMap { listOfNotNull(it.text, it.contentDescription) }.joinToString("\n").lowercase()

    private fun tabUrlHost(browser: String): String {
        val bar = device.findObject(By.res(browser, "url_bar")) ?: device.findObject(By.res(browser, "title_url_container"))
        val text = bar?.text ?: return "(no url bar)"
        val host = Uri.parse(if (text.contains("://")) text else "https://$text").host
        return host ?: "(unparsed)"
    }

    private fun findInTab(browser: String, text: String, timeoutMs: Long): UiObject2? {
        val deadline = System.currentTimeMillis() + timeoutMs
        do {
            dismissChromeScreens()
            val found = device.findObject(By.pkg(browser).textContains(text)) ?: device.findObject(By.pkg(browser).descContains(text))
            if (found != null) return found
            sleep(500)
        } while (System.currentTimeMillis() < deadline)
        return null
    }

    /** Sign in with the debug hook that opens the hosted sign-in in a Custom Tab. Returns the browser package. */
    private fun openHostedSignInInTab(moment: String): String? {
        launch(null, moment, extras = mapOf("openbot.debug_tab_url" to hostedSignIn))
        val button = waitFor("sign_in_button", 15_000) ?: return null
        button.click()
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            dismissChromeScreens()
            val other = foregroundPackage()
            if (other.isNotEmpty() && other != pkg) return other
            sleep(500)
        }
        return null
    }

    /** The hosted sign-in in a Custom Tab, without credentials: what is reachable there. */
    @Test
    fun testRealSignInPathInCustomTab() {
        requireProduction()
        val browser = openHostedSignInInTab("tab") ?: run {
            screenshot("no-custom-tab")
            check(false, "no Custom Tab opened")
            return
        }
        note("Custom Tab browser: $browser")
        val google = findInTab(browser, "Google", 30_000)
        sleep(3_000)
        screenshot("1-custom-tab-identity-provider")
        val text = tabText(browser)
        for (name in listOf("github", "google", "microsoft", "email")) note("identity provider in the Custom Tab offers $name: ${text.contains(name)}")
        note("the Custom Tab is on ${tabUrlHost(browser)}")
        if (google == null) {
            note("no Google button reachable in the Custom Tab")
            return
        }
        google.click()
        sleep(10_000)
        screenshot("2-google-in-custom-tab")
        val page = tabText(browser)
        note("Google in the Custom Tab: email page ${page.contains("email or phone")}, refusal ${page.contains("disallowed_useragent") || page.contains("may not be secure")}; on ${tabUrlHost(browser)}")
        device.pressBack()
        sleep(1_500)
        device.pressBack()
        check(waitFor("sign_in_button", 15_000) != null, "closing the Custom Tab did not return to the native sign-in")
        check(waitForState("signIn=idle", 5_000), "closing the Custom Tab did not end the sign-in: ${debugState()}")
    }

    /**
     * The real sign-in with Google in a Custom Tab, with the throwaway account. Runs only when the
     * workflow is started by hand with google_sign_in on: each attempt sends a prompt to the
     * account's phone. One attempt; stops at any CAPTCHA or other challenge; never changes the user
     * agent. Passes only when the tab ends on OpenBot signed in; otherwise skipped with the reason.
     */
    @Test
    fun testRealGoogleSignInInCustomTab() {
        if (args.getString("google_sign_in") != "true") {
            skip("runs only when the workflow is started by hand with google_sign_in on: each attempt sends a sign-in prompt to the account's phone")
        }
        val names = listOf("openbot_google_email", "openbot_google_password", "openbot_google_totp_secret")
        note("secret-inputs: ${if (names.all { secret(it) != null }) "present" else "absent"}")
        val email = secret(names[0]) ?: skip("the Google email secret is not set")
        val password = secret(names[1]) ?: skip("the Google password secret is not set")
        val totpSecret = secret(names[2])?.let { Totp.base32Decode(it) } ?: skip("the TOTP secret is not set or not base32")
        requireProduction()
        mark("start")
        try {
            googleSignIn(email, password, totpSecret)
        } finally {
            mark("end")
        }
    }

    private fun googleSignIn(email: String, password: String, totpSecret: ByteArray) {
        val browser = openHostedSignInInTab("google-tab") ?: skip("no Custom Tab opened")
        val google = findInTab(browser, "Google", 30_000) ?: skip("no Google button in the Custom Tab")
        screenshot("1-identity-provider")
        google.click()
        sleep(8_000)
        screenshot("2-google")

        googleSteps(browser, email, password, totpSecret)
        sleep(8_000)
        screenshot("8-where-the-tab-ended")
        val ended = tabText(browser)
        val host = tabUrlHost(browser)
        val landed = host == "my.open.bot" && (ended.contains("start a conversation") || ended.contains("ask anything") || ended.contains("message"))
        note("the Custom Tab ended on $host; OpenBot signed in there: $landed; OpenBot sign-in page ${ended.contains("sign in to openbot")}")
        if (!landed) skip("Google's sign-in in the Custom Tab did not end on OpenBot signed in (ended on $host)")
    }

    // The signed-in journey on the real backend. --------------------------------------------------------

    /**
     * The signed-in journey with the session cookie the secret holds (debug hook). Notes hold counts
     * and yes/no only: the account's data stays in the private screenshots. Does not sign out.
     */
    @Test
    fun testRealSignedInJourneyWithSessionCookie() {
        val session = secret("openbot_test_session")
        note("secret-inputs: ${if (session == null) "absent" else "present"}")
        if (session == null) skip("OPENBOT_SHELL_TEST_SESSION is not set")
        requireProduction()
        mark("start")
        launch(null, "session", extras = mapOf("openbot.test_session_cookie" to session))
        if (forVideo) {
            val seen = waitFor("loading_skeleton", 3_000) != null
            note("the loading skeleton showed at launch: $seen")
        }
        if (waitForTab(Tab.HOME, 30_000) == null) {
            screenshot("no-tabs")
            check(false, "the session cookie did not reach the tabs; state ${debugState()}")
            return
        }
        sleep(6_000)
        if (challengeShown()) {
            // Cloudflare's bot check in front of my.open.bot (see testRealChallengeProbe).
            screenshot("j0-bot-check")
            val started = System.currentTimeMillis()
            while (challengeShown() && System.currentTimeMillis() - started < 60_000) sleep(2_000)
            note("journey: the bot check showed at the first load; cleared by itself ${!challengeShown()} after ${(System.currentTimeMillis() - started) / 1000} s")
            sleep(4_000)
        }
        if (exists("sign_in_button") || pageText().contains("Sign in to OpenBot Cloud")) {
            screenshot("session-rejected")
            check(false, "production rejected the session cookie (it may be stale or copied wrong)")
            return
        }
        val box = waitComposerRect(30_000)
        check(box != null, "no message box on Home")
        sleep(2_000)
        screenshot("j1-home")
        assertWebNavigationNote("home")

        // One real message, typed with the software keyboard, and the reply streaming in.
        box?.let { tapComposer(it) }
        val keyboard = waitKeyboard(true, 8_000)
        note("software keyboard shown for the message: $keyboard")
        shell("input text Say%shello%sin%sthree%swords.")
        sleep(1_000)
        screenshot("j2-message-typed")
        val before = pageText().lines().map { it.trim() }.toSet()
        val send = device.findObject(By.desc("Send message")) ?: device.findObject(By.text("Send message"))
        if (send != null) send.click() else device.pressEnter()
        val lengths = mutableListOf<Int>()
        val started = System.currentTimeMillis()
        while (System.currentTimeMillis() - started < 60_000) {
            sleep(3_000)
            val fresh = pageText().lines().map { it.trim() }.filter { it.isNotEmpty() && it !in before && !it.contains("Say hello in three words") }
            lengths.add(fresh.maxOfOrNull { it.length } ?: 0)
            if (lengths.size == 2) screenshot("j3-reply-streaming")
            if (lengths.size >= 4 && lengths.takeLast(3).toSet().size == 1 && lengths.last() > 0) break
        }
        val grew = lengths.zipWithNext().any { (a, b) -> a in 1 until b }
        note("reply: longest new line by 3 s step $lengths; grew while shown (streaming) $grew; after ${(System.currentTimeMillis() - started) / 1000} s")
        check(lengths.any { it > 0 }, "no reply appeared within 60 s")
        sleep(3_000)
        screenshot("j4-reply")
        dismissKeyboardIfUp()
        note("after sending: ${debugState()}")

        // Bots, a Bot.
        tab(Tab.BOTS)?.click()
        sleep(5_000)
        screenshot("j5-bots")
        note("bots: ${debugState()}")
        val bot = waitWebObject("General Assistant", 8_000)
        if (bot != null) {
            bot.click()
            sleep(5_000)
            dismissKeyboardIfUp()
            screenshot("j6-a-bot")
        } else {
            note("no 'General Assistant' Bot on this account's Bots page")
        }

        // Conversations: production has no /conversations yet.
        tab(Tab.CONVERSATIONS)?.click()
        sleep(6_000)
        screenshot("j7-conversations-tab")
        note("conversations tab: ${debugState()}; page says not found ${pageText().contains("Not found") || pageText().contains("404")}")
        assertWebNavigationNote("conversations")

        tab(Tab.HOME)?.click()
        sleep(3_000)
        // Background (40 s; about 6 s in the recording), then back.
        device.pressHome()
        sleep(if (forVideo) 6_000 else 40_000)
        bringBack()
        sleep(3_000)
        screenshot("j8-back-from-background")
        tab(Tab.HOME)?.click()
        check(waitComposerRect(20_000) != null, "Home did not come back after the background")
        note("after background: ${debugState()}")
        // Let the cookie store reach the disk before the next test kills the process.
        device.pressHome()
        sleep(4_000)
    }

    /** Runs right after the journey, in a new process: killed and opened again, straight to the tabs. */
    @Test
    fun testRealSignedInJourneyWithSessionCookie_2_relaunch() {
        if (secret("openbot_test_session") == null) skip("OPENBOT_SHELL_TEST_SESSION is not set")
        try {
            launch(null, "relaunch", reset = false)
            check(waitForTab(Tab.HOME, 20_000) != null, "a cold relaunch did not go straight to the tabs; ${debugState()}")
            check(!exists("sign_in_button"), "a cold relaunch showed the sign-in screen")
            sleep(6_000)
            screenshot("j9-relaunched")
            note("cold relaunch: bot check shown ${challengeShown()}; cookie names ${cookieNames()}")
            note("relaunched: ${debugState()}")
        } finally {
            mark("end")
        }
    }

    private fun assertWebNavigationNote(moment: String) {
        val toggle = pageString("String(!!document.querySelector('[data-sidebar=\"trigger\"],[aria-label=\"Toggle Sidebar\"]'))")
        note("$moment: the web app's own sidebar toggle is drawn (production has no shell mode yet): $toggle")
    }
}
