package ai.openbot.shell.test

import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebView
import ai.openbot.shell.R
import ai.openbot.shell.SessionCookies
import androidx.test.filters.SdkSuppress
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Suite 2, "not deployed yet": the shell's own screens and flows on the debug build, against this
 * branch's web build over the mock (stack A with the hand-off, stack B without). Tests ending in
 * `_2_relaunch` run right after the test they continue, in a new process.
 */
@RunWith(AndroidJUnit4::class)
class ShellFlowTest : ShellTestBase() {
    private val homeText = "Start a conversation"

    private fun homeRendered(timeoutMs: Long = 30_000): Boolean = waitPageText(homeText, timeoutMs)

    private fun accountIsVisible(): Boolean {
        val button = webRect("Account") ?: bounds(waitWebObject("Account", 5_000)) ?: return false
        return layoutBounds(R.id.openbot_webview)?.contains(button) == true
    }

    private fun checkTabBar(moment: String) {
        val conversations = tab(Tab.CONVERSATIONS)
        val home = tab(Tab.HOME)
        val bots = tab(Tab.BOTS)
        if (!check(conversations != null && home != null && bots != null, "$moment: the bottom bar does not have its three tabs")) return
        val c = bounds(conversations)!!
        val h = bounds(home)!!
        val b = bounds(bots)!!
        check(c.left < h.left && h.left < b.left, "$moment: tabs are not Conversations, Home, Bots from left to right")
        val web = layoutBounds(R.id.openbot_webview)
        val bar = layoutBounds(R.id.bottom_nav)
        check(web != null && bar != null, "$moment: cannot measure the native web view and tab bar")
        if (web != null && bar != null) {
            check(web.bottom <= bar.top + 1, "$moment: the web view runs under the bottom bar (web ${web.bottom}, bar ${bar.top})")
            check(web.top > 0, "$moment: the web view starts at the top edge, under the status bar (web top ${web.top})")
            note("$moment: web view $web, bottom bar $bar, display ${device.displayWidth}x${device.displayHeight}")
        }
    }

    // a.
    @Test
    fun testFirstScreenIsNative() {
        launch(MOCK_A, "mock")
        check(waitFor("sign_in_button", 15_000) != null, "no native Sign in button")
        check(device.hasObject(By.text("OpenBot")), "the first screen does not say OpenBot")
        check(!exists("openbot_webview"), "a web view is visible on the first screen")
        check(tab(Tab.HOME) == null, "the bottom bar shows before signing in")
        screenshot("first-screen")

        launch(MOCK_A, "dark", extras = mapOf("openbot.force_dark" to "1"))
        check(waitFor("sign_in_button", 15_000) != null, "no Sign in button in dark mode")
        sleep(1_000)
        screenshot("first-screen-dark")

        // Nothing listens on 8799: the first screen does not need the server.
        launch("http://localhost:8799", "unreachable")
        val button = waitFor("sign_in_button", 15_000)
        check(button != null, "no native Sign in button with an unreachable server")
        check(!exists("openbot_webview"), "a web view is visible with an unreachable server")
        screenshot("first-screen-unreachable-server")

        // Sign in there: the hand-off config gets no answer, so the lock screen shows (load-failed).
        button?.click()
        check(waitFor("offline_lock", 30_000) != null, "no lock screen after a sign-in with no server")
        sleep(1_000)
        screenshot("unreachable-server-after-sign-in")
        assertLockScreen("load-failed")
        note("unreachable server after Sign in: ${debugState()}")
    }

    // The lock lifts by itself when OpenBot comes back: the workflow starts a stack on 3012 about 8 s
    // after this test touches the trigger file.
    @Test
    fun testLockLiftsWhenServerComesBack() {
        if (args.getString("late_stack") != "1") skip("the late stack is not armed (the workflow arms it)")
        shell("touch /data/local/tmp/openbot-late-stack")
        launch(LATE, "late", extras = mapOf("openbot.stale_session" to "1"))
        check(waitFor("offline_lock", 20_000) != null, "no lock screen while the server is down")
        sleep(1_000)
        screenshot("1-lock-while-server-down")
        assertLockScreen("load-failed")
        check(waitGone("offline_lock", 60_000), "the lock did not lift when the server came up; ${debugState()}")
        // The page loads, says nobody is signed in, and the native sign-in comes back.
        check(waitFor("sign_in_button", 30_000) != null, "no sign-in screen after recovery; ${debugState()}")
        sleep(1_000)
        screenshot("2-after-server-came-back")
        note("after recovery: ${debugState()}")
    }

    // b.
    @Test
    fun testNativeSignInThroughCustomTab() {
        launch(MOCK_A, "manual")
        val ok = signInThroughCustomTab("manual")
        check(ok, "the Custom Tab sign-in did not reach the tabs")
        if (!ok) return
        check(homeRendered(), "the signed-in Home did not render")
        sleep(2_000)
        screenshot("signed-in-home")
        checkTabBar("home")
        check(waitForState("tab=home", 3_000), "Home is not the selected tab: ${debugState()}")
        check(tab(Tab.HOME)?.isSelected == true, "the Home tab is not marked selected for accessibility")
        check(!exists("sign_in_button"), "the sign-in screen is still there")
        assertNoWebNavigation("home")
        note("after sign-in: ${debugState()}; foreground ${foregroundPackage()}")
        // Let the cookie store reach the disk before the next test kills the process.
        sleep(4_000)
    }

    /** Runs right after testNativeSignInThroughCustomTab, in a new process: straight to the tabs. */
    @Test
    fun testNativeSignInThroughCustomTab_2_relaunch() {
        launch(MOCK_A, "relaunch", reset = false)
        check(waitForTab(Tab.HOME, 20_000) != null, "a cold relaunch did not go straight to the tabs; ${debugState()}")
        check(!exists("sign_in_button"), "a cold relaunch showed the sign-in screen")
        check(homeRendered(), "Home did not render after the relaunch")
        sleep(1_000)
        screenshot("relaunch-signed-in")
    }

    // c.
    @Test
    fun testHandoffToAPageWithoutTheBridge() {
        launch("http://localhost:3013", "without-bridge")
        if (!check(signInThroughCustomTab("without-bridge"), "the ticket did not return to the tabs")) return
        check(homeRendered(), "the authenticated landing page did not render")
        check(waitForState("signIn=idle", 30_000), "the native handoff did not finish")
        check(tab(Tab.HOME) != null, "the shell returned to Sign in after the server accepted the ticket")
    }

    @Test
    fun testTabsRouteTheWebView() {
        if (!launchSignedIn()) return
        check(homeRendered(), "Home did not render")
        sleep(2_000)
        val commitsAtStart = stateValue("commits")
        screenshot("1-home")
        assertNoWebNavigation("home")
        check(accountIsVisible(), "no Account button on Home")

        tab(Tab.CONVERSATIONS)?.click()
        for (title in listOf("Competitor pricing notes", "Quarterly forecast", "Trip to Lisbon")) {
            check(waitPageText(title, 20_000), "Conversations does not list '$title'")
        }
        check(waitForState("tab=conversations", 5_000), "Conversations is not selected: ${debugState()}")
        check(waitForState("nav=event", 5_000), "the Conversations tap was not handled by openbot:open: ${debugState()}")
        sleep(1_000)
        screenshot("2-conversations")
        find("openbot_webview")?.let { web ->
            web.swipe(androidx.test.uiautomator.Direction.UP, 0.8f)
            sleep(600)
            web.swipe(androidx.test.uiautomator.Direction.UP, 0.8f)
            sleep(1_000)
            screenshot("2b-conversations-scrolled-to-end")
            web.swipe(androidx.test.uiautomator.Direction.DOWN, 0.8f)
            web.swipe(androidx.test.uiautomator.Direction.DOWN, 0.8f)
        }
        assertNoWebNavigation("conversations")
        check(accountIsVisible(), "no Account button on Conversations")

        check(tapWeb("Quarterly forecast"), "no 'Quarterly forecast' row to tap")
        val opened = waitPageText("Here is the first draft.", 25_000) || waitPageText("Can you draft the quarterly forecast?", 2_000)
        check(opened, "the conversation did not open")
        sleep(1_000)
        if (keyboardShown()) {
            // Finding for the web app: a conversation focuses its message box when it opens.
            screenshot("3a-conversation-opened-with-keyboard")
            note("opening a conversation raised the keyboard (the message box took focus)")
            dismissKeyboardIfUp()
        }
        check(waitForTab(Tab.CONVERSATIONS, 5_000) != null, "no bottom bar in the conversation")
        check(debugState().contains("tab=conversations"), "opening a conversation moved the tab selection: ${debugState()}")
        sleep(1_000)
        screenshot("3-conversation")
        val boxBounds = waitComposerRect(10_000)
        val bar = layoutBounds(R.id.bottom_nav)
        check(boxBounds != null, "no message box in the conversation")
        if (boxBounds != null && bar != null) {
            check(boxBounds.bottom <= bar.top + 1, "the message box is under the bottom bar (box $boxBounds, bar $bar)")
            check(boxBounds.height() > 20, "the message box is clipped (box $boxBounds)")
            note("conversation: message box $boxBounds, bottom bar $bar")
        }
        assertNoWebNavigation("conversation")

        // System Back goes back in the WebView's history: the list again.
        device.pressBack()
        check(waitPageText("Trip to Lisbon", 10_000), "system Back did not return to the conversations list")
        check(waitForState("path=/conversations", 5_000), "system Back did not return to /conversations: ${debugState()}")
        check(device.currentPackageName == pkg, "system Back left the app")
        sleep(800)
        screenshot("3b-back-to-list")

        tab(Tab.BOTS)?.click()
        for (name in listOf("General Assistant", "Research Bot")) {
            check(waitPageText(name, 20_000), "Bots does not list '$name'")
        }
        check(waitForState("tab=bots", 5_000), "Bots is not selected: ${debugState()}")
        sleep(1_000)
        screenshot("4-bots")
        assertNoWebNavigation("bots")
        check(accountIsVisible(), "no Account button on Bots")

        tab(Tab.HOME)?.click()
        check(homeRendered(20_000), "Home did not come back")
        check(waitForState("tab=home", 5_000), "Home is not selected: ${debugState()}")
        sleep(1_000)
        screenshot("5-home-again")
        val commitsAtEnd = stateValue("commits")
        checkEquals(commitsAtStart, commitsAtEnd, "a tab tap reloaded the page (main-frame commits changed)")
        note("commits start $commitsAtStart end $commitsAtEnd; ${debugState()}")

        // Dark mode: the page follows the app's theme, and the bars follow the page.
        sleep(2_000)
        launch(MOCK_A, "dark", reset = false, extras = mapOf("openbot.force_dark" to "1"))
        check(waitForTab(Tab.HOME, 20_000) != null, "no tabs in dark mode")
        check(homeRendered(20_000), "Home did not render in dark mode")
        sleep(2_000)
        screenshot("6-home-dark")
        check(waitForState("dark=1", 5_000), "the page did not report dark mode: ${debugState()}")
        note("dark: ${debugState()}")
        tab(Tab.CONVERSATIONS)?.click()
        sleep(2_500)
        screenshot("7-conversations-dark")
    }

    // d.
    @Test
    fun testSignedOutByServerReturnsToNativeSignIn() {
        if (!launchSignedIn("sign-in")) return
        check(homeRendered(), "Home did not render")
        sleep(2_000)
        // The session ran out on the server: the cookie is still there, the server no longer knows it.
        launch(MOCK_A, "stale", reset = false, extras = mapOf("openbot.stale_session" to "1"))
        check(waitFor("sign_in_button", 30_000) != null, "the native sign-in did not come back; ${debugState()}")
        check(tabGone(5_000), "the bottom bar stayed")
        sleep(1_000)
        screenshot("native-sign-in-after-session-ended")
        note("after the server ended the session: ${debugState()}")

        // The shell deleted the dead cookie: the next launch starts signed out at once.
        launch(MOCK_A, "after", reset = false)
        check(waitFor("sign_in_button", 10_000) != null, "no Sign in button on the next launch")
        sleep(3_000)
        check(tab(Tab.HOME) == null, "the next launch still thought it was signed in")
        screenshot("next-launch")
    }

    // d, from the page: Account, then Sign out.
    @Test
    fun testSignOutFromAccountMenu() {
        if (!launchSignedIn("sign-in")) return
        check(homeRendered(), "Home did not render")
        if (!check(tapWeb("Account"), "no Account button on Home")) return
        if (!check(waitPageText("Sign out", 10_000), "the Account menu did not open")) return
        screenshot("1-account-menu")
        if (!check(tapWeb("Sign out"), "the Account menu has no Sign out")) return
        check(waitFor("sign_in_button", 20_000) != null, "Sign out did not bring back the native sign-in; ${debugState()}")
        check(tabGone(5_000), "the bottom bar stayed after Sign out")
        sleep(1_000)
        screenshot("2-after-sign-out")
        sleep(2_000)

        // The cookie is gone: a relaunch starts on the sign-in screen and stays there.
        launch(MOCK_A, "relaunch", reset = false)
        check(waitFor("sign_in_button", 10_000) != null, "no Sign in button after the relaunch")
        sleep(3_000)
        check(tab(Tab.HOME) == null, "the relaunch after Sign out went to the tabs")

        // And back in through the Custom Tab.
        check(signInThroughCustomTab("again", shots = false), "signing in again did not reach the tabs")
        check(homeRendered(), "Home did not render after signing in again")
        sleep(1_000)
        screenshot("3-signed-in-again")
    }

    // e.
    @Test
    fun testFallbackToWebSignIn() {
        launch(MOCK_B, "no-handoff")
        val button = waitFor("sign_in_button", 15_000)
        if (!check(button != null, "no Sign in button")) return
        button!!.click()
        val cancel = waitFor("web_sign_in_cancel", 20_000)
        check(cancel != null, "no web sign-in fallback")
        check(foregroundPackage() == pkg, "a Custom Tab opened on a server without the hand-off (foreground ${foregroundPackage()})")
        check(waitFor("openbot_webview", 10_000) != null, "no web view in the fallback")
        val hasContent = waitPageText("Sign", 25_000)
        sleep(2_000)
        screenshot("web-sign-in")
        note("web sign-in page text: ${pageText().take(200).replace("\n", " | ")}")
        check(hasContent, "the web sign-in page showed nothing to use")
        check(tab(Tab.HOME) == null, "the bottom bar shows during the web sign-in")
        cancel?.click()
        check(waitFor("sign_in_button", 10_000) != null, "Cancel did not return to the native sign-in")
        check(!exists("openbot_webview"), "the web view is still visible after Cancel")
        screenshot("after-cancel")
    }

    // f.
    @Test
    fun testOfflineLock() {
        launch(MOCK_A, "forced", extras = mapOf("openbot.force_offline" to "1"))
        check(waitFor("offline_lock", 15_000) != null, "no offline lock")
        assertLockScreen("no-network")
        // Tap where the Sign in button sits: nothing may start.
        device.click(device.displayWidth / 2, device.displayHeight * 9 / 10)
        sleep(2_000)
        check(debugState().contains("signIn=idle"), "a tap under the lock started something: ${debugState()}")
        check(exists("offline_lock"), "the lock went away")
        screenshot("offline-lock")
        launch(MOCK_A, "forced-dark", extras = mapOf("openbot.force_offline" to "1", "openbot.force_dark" to "1"))
        check(waitFor("offline_lock", 15_000) != null, "no lock in dark mode")
        sleep(1_000)
        screenshot("offline-lock-dark")

        // Offline for 6 s, then the real network: the lock lifts and the sign-in screen is back.
        launch(MOCK_A, "timed", extras = mapOf("openbot.force_offline_seconds" to "6"))
        check(waitFor("offline_lock", 5_000) != null, "no lock in the first seconds")
        screenshot("offline-lock-timed")
        check(waitGone("offline_lock", 20_000), "the lock did not lift")
        check(waitFor("sign_in_button", 5_000)?.isEnabled == true, "the Sign in button is not usable after the lock lifted")
        screenshot("after-offline-lifted")

        // Exercise the lock with the workbench's signed-in fixture. The separate Custom Tab
        // tests cover acquiring and persisting this cookie through the real ticket exchange.
        CookieManager.getInstance().apply {
            setCookie(MOCK_A, "${SessionCookies.PLAIN_NAME}=mock; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600")
            flush()
        }
        launch(MOCK_A, "signed-in-timed", reset = false, extras = mapOf("openbot.force_offline_seconds" to "15"))
        check(waitFor("offline_lock", 5_000) != null, "no lock while signed in and offline")
        screenshot("signed-in-offline-lock")
        check(waitGone("offline_lock", 20_000), "the lock did not lift while signed in")
        check(waitForTab(Tab.HOME, 10_000) != null, "no tabs after the lock lifted")
        check(homeRendered(20_000), "Home did not render after the lock lifted")
        screenshot("signed-in-after-offline-lifted")
    }

    @Test
    @SdkSuppress(minSdkVersion = 29)
    fun testOpenConversationSurvivesRendererTermination() {
        if (!launchSignedIn("renderer-restart")) return
        tab(Tab.CONVERSATIONS)?.click()
        if (!check(waitPageText("Quarterly forecast", 20_000) && tapWeb("Quarterly forecast"),
                "the conversation could not be opened")) return
        val message = "Here is the first draft."
        if (!check(waitPageText(message, 20_000), "the conversation did not render")) return
        dismissKeyboardIfUp()
        var original: WebView? = null
        var terminated = false
        instrumentation.runOnMainSync {
            original = shellActivity()?.findViewById(R.id.openbot_webview)
            terminated = original?.webViewRenderProcess?.terminate() == true
        }
        if (!check(terminated, "the WebView renderer could not be terminated")) return
        val deadline = SystemClock.uptimeMillis() + 20_000
        var replaced = false
        do {
            instrumentation.runOnMainSync {
                val current = shellActivity()?.findViewById<WebView>(R.id.openbot_webview)
                replaced = current != null && current !== original
            }
            if (replaced) break
            sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        if (!check(replaced, "the shell did not recreate its WebView")) return
        check(waitPageText(message, 20_000), "the recreated WebView lost the open conversation")
        screenshot("after-renderer-restart")
        dismissKeyboardIfUp()
        tab(Tab.BOTS)?.click()
        check(waitPageText("Research Bot", 15_000), "the replacement WebView could not open Bots")
    }

    // g.
    @Test
    fun testSettingsNameStaysAboveKeyboard() {
        if (!launchSignedIn("settings-keyboard")) return
        if (!check(homeRendered(), "Home did not render")) return
        // Open the profile via its normal first-party URL. Account menu gestures have their own
        // sign-out test. This case exercises the real profile field and its keyboard layout.
        pageJs("location.assign('/settings')")
        if (!check(waitPageText("About you", 25_000), "Settings did not open the profile")) return
        if (!check(tapWeb("Name"), "the profile had no Name row")) return
        if (!check(waitPageText("Choose the name OpenBot shows for you.", 10_000), "the Name dialog did not open")) return
        val selector = "input[autocomplete=name]"
        if (pageString("document.activeElement.matches('$selector')") != "true") {
            if (!check(tapWeb("Name field", cssSelector = selector), "the name field was unavailable")) return
        }
        if (!check(waitKeyboard(true, 8_000), "the software keyboard did not open on the name field")) return
        instrumentation.sendStringSync("Sample")
        // Android dispatches key events before Chromium publishes the new field value.
        val typedName = By.clazz("android.widget.EditText").textContains("Sample")
        if (!check(device.wait(Until.hasObject(typedName), 5_000), "the name field did not receive the text")) return
        check(pageString("""
            (() => {
              const r = document.activeElement.getBoundingClientRect();
              return r.top >= visualViewport.offsetTop && r.bottom <= visualViewport.offsetTop + visualViewport.height + 1;
            })()
        """.trimIndent()) == "true", "the name field was outside the resized viewport")
        check(tabGone(5_000), "the tab bar stayed up while typing the name")
        screenshot("settings-name-keyboard")
        device.pressBack()
        check(waitKeyboard(false, 5_000), "Back did not put away the keyboard")
        check(waitPageText("Choose the name OpenBot shows for you.", 5_000), "Back left the Name dialog")
    }

    @Test
    fun testKeyboardHidesTabBar() {
        if (!launchSignedIn()) return
        check(homeRendered(), "Home did not render")
        val box = waitComposerRect(15_000)
        if (box == null) {
            screenshot("no-composer")
            check(false, "no composer on Home")
            return
        }
        tapComposer(box)
        if (!waitKeyboard(true, 8_000)) {
            screenshot("no-software-keyboard")
            skip("the software keyboard did not show on this emulator; state ${debugState()}")
        }
        check(tabGone(5_000), "the bottom bar stayed up with the keyboard")
        sleep(1_000)
        screenshot("keyboard-up")
        val boxNow = composerRect()
        val webNow = layoutBounds(R.id.openbot_webview)
        note("keyboard up: ${debugState()}; message box $boxNow; web view $webNow; display height ${device.displayHeight}")
        if (boxNow != null && webNow != null) {
            // The web view ends at the keyboard's top edge: the box must be inside it, whole.
            check(boxNow.bottom <= webNow.bottom + 1 && boxNow.height() > 20, "the message box is not fully above the keyboard (box $boxNow, web view $webNow)")
            check(webNow.bottom < device.displayHeight * 0.8, "the web view did not shrink for the keyboard (web view $webNow)")
        }
        // Back closes the keyboard first, as on any Android screen.
        device.pressBack()
        check(waitKeyboard(false, 5_000), "Back did not close the keyboard")
        check(waitForTab(Tab.HOME, 5_000) != null, "the bottom bar did not come back")
        check(device.currentPackageName == pkg, "Back with the keyboard up left the app")
        sleep(1_000)
        screenshot("keyboard-dismissed")

        // In a conversation: the message box and its send button above the keyboard; Back closes
        // the keyboard first, then navigates; the web view then ends at the bar's top, no gap.
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Quarterly forecast", 15_000), "no conversations list")
        check(tapWeb("Quarterly forecast"), "no 'Quarterly forecast' row")
        check(waitPageText("Here is the first draft.", 20_000) || waitPageText("Can you draft", 2_000), "the conversation did not open")
        if (!keyboardShown()) waitComposerRect(10_000)?.let { tapComposer(it) }
        check(waitKeyboard(true, 8_000), "the keyboard did not show in the conversation")
        sleep(1_200)
        val web = layoutBounds(R.id.openbot_webview)
        val send = webRect("Send message")
        val boxRect = composerRect()
        val plus = webRect("Attach a file")
        note("conversation with the keyboard: web view $web, message box $boxRect, send $send, attach $plus; ${debugState()}")
        screenshot("conversation-keyboard-up")
        if (web != null) {
            check(send != null && send.bottom <= web.bottom + 1 && send.top >= web.top, "the send button is not above the keyboard (send $send, web view $web)")
            check(plus == null || plus.bottom <= web.bottom + 1, "the attach button is behind the keyboard (attach $plus, web view $web)")
            check(boxRect != null && boxRect.bottom <= web.bottom + 1, "the message box is behind the keyboard (box $boxRect, web view $web)")
        }
        check(!exists("bottom_nav"), "the bottom bar is up with the keyboard")
        device.pressBack()
        check(waitKeyboard(false, 5_000), "Back did not close the keyboard first")
        check(waitForTab(Tab.CONVERSATIONS, 5_000) != null, "the bottom bar did not come back")
        check(waitForState("path=/channel", 2_000) || pageText().contains("Here is the first draft."), "the first Back navigated instead of only closing the keyboard: ${debugState()}")
        sleep(800)
        val webAfter = layoutBounds(R.id.openbot_webview)
        val bar = layoutBounds(R.id.bottom_nav)
        if (webAfter != null && bar != null) check(kotlin.math.abs(webAfter.bottom - bar.top) <= 2, "a gap or overlap between the web view and the bar after the keyboard (web ${webAfter.bottom}, bar ${bar.top})")
        screenshot("conversation-keyboard-dismissed")
        device.pressBack()
        check(waitPageText("Trip to Lisbon", 8_000), "the second Back did not go back to the list")
        screenshot("conversation-back-to-list")
    }

    // The native loading skeleton: seen for real by delaying the first page load (debug hook).
    @Test
    fun testSkeletonCoversAMountedRouterWithNoVisibleRoute() {
        // Use the independent, always-available probe origin so the sign-in provider cannot
        // affect this rendering test. The shell still receives the normal WebView bridge message.
        CookieManager.getInstance().apply {
            setCookie(PROBE, "${SessionCookies.PLAIN_NAME}=probe; Path=/; HttpOnly")
            flush()
        }
        launch(PROBE, "delayed-route", reset = false)
        if (!check(waitForState("skeleton=0", 15_000), "the initial probe stayed covered")) return
        val page = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <div style="opacity:0"><span>Hidden</span><span>route</span><span>contents</span></div>
            <main hidden><h1>Conversations</h1><p>Quarterly forecast</p><p>Trip to Lisbon</p></main>
            <script>
              OpenBotShellAndroid.postMessage(JSON.stringify({type: 'ready'}));
              document.title = 'Router mounted';
            </script>
        """.trimIndent()
        instrumentation.runOnMainSync {
            shellActivity()?.findViewById<WebView>(R.id.openbot_webview)
                ?.loadDataWithBaseURL(PROBE, page, "text/html", "UTF-8", null)
        }
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (pageString("document.title") != "Router mounted" && SystemClock.uptimeMillis() < deadline) sleep(100)
        if (!check(pageString("document.title") == "Router mounted", "the route fixture did not mount")) return
        // The previous shell dismissed the skeleton 200 ms after the bridge's ready message.
        sleep(800)
        check(debugState().contains("skeleton=1"), "the mounted router exposed a blank page")
        screenshot("before-first-visible-route")
        pageJs("document.querySelector('main').hidden = false")
        check(waitForState("skeleton=0", 5_000), "the first visible route stayed covered")
        check(waitPageText("Trip to Lisbon", 5_000), "the route did not render")
        screenshot("first-visible-route")
    }

    @Test
    fun testLoadingSkeleton() {
        if (!launchSignedIn()) return
        check(homeRendered(), "Home did not render")
        sleep(2_000)
        for ((moment, dark) in listOf("light" to false, "dark" to true)) {
            // Keep the artificial slow load visible through activity recreation and UIAutomator's idle wait.
            val extras = mutableMapOf("openbot.delay_first_load_ms" to "6000")
            if (dark) extras["openbot.force_dark"] = "1"
            launch(MOCK_A, "skeleton-$moment", reset = false, extras = extras)
            val skeleton = waitFor("loading_skeleton", 3_000)
            check(skeleton != null, "$moment: no loading skeleton while the first page loads; ${debugState()}")
            checkEquals("Loading", skeleton?.contentDescription, "$moment: the skeleton's content description")
            check(waitForTab(Tab.HOME, 2_000) != null, "$moment: the bottom bar is not usable while the skeleton shows")
            val web = bounds(find("web_container"))
            val shown = bounds(skeleton)
            val bar = layoutBounds(R.id.bottom_nav)
            if (shown != null && bar != null) check(shown.bottom <= bar.top + 1, "$moment: the skeleton runs under the bottom bar ($shown, bar $bar)")
            note("$moment skeleton: $shown, web area $web, bottom bar $bar; ${debugState()}")
            sleep(600)
            screenshot("skeleton-$moment")
            check(waitGone("loading_skeleton", 15_000), "$moment: the skeleton did not go away after the page rendered")
            check(homeRendered(5_000), "$moment: Home is not there after the skeleton")
            sleep(800)
            screenshot("after-skeleton-$moment")
        }
    }

    // Back from the background: the page is alive and the tabs still route.
    @Test
    fun testResumeFromBackground() {
        if (!launchSignedIn()) return
        check(homeRendered(), "Home did not render")
        device.pressHome()
        sleep(40_000)
        bringBack()
        check(waitForTab(Tab.HOME, 10_000) != null, "no tabs after coming back")
        sleep(2_000)
        screenshot("1-back-from-background")
        check(pageText().contains(homeText), "Home is not on screen after coming back")
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Competitor pricing notes", 15_000), "the tabs stopped routing after coming back")
        sleep(1_000)
        screenshot("2-conversations-after-background")
        note("after background: ${debugState()}")
    }
}
