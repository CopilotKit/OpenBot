package ai.openbot.shell.test

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A paced tour of the app against mock stack A, for the screen recording CI makes of it (the runner
 * records this test alone). Not part of the main suite.
 */
@RunWith(AndroidJUnit4::class)
class DemoTourTest : ShellTestBase() {
    private fun pause(ms: Long = 1_200) = sleep(ms)

    private fun softwareLayer(on: Boolean) {
        instrumentation.runOnMainSync {
            val activity = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).firstOrNull()
            fun walk(view: android.view.View): android.webkit.WebView? {
                if (view is android.webkit.WebView) return view
                if (view is android.view.ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))?.let { return it }
                return null
            }
            activity?.window?.decorView?.let { walk(it) }
                ?.setLayerType(if (on) android.view.View.LAYER_TYPE_SOFTWARE else android.view.View.LAYER_TYPE_NONE, null)
        }
        note("recording: the WebView drawn in ${if (on) "software" else "hardware"}")
    }

    @Test
    fun testDemoTour() {
        mark("start")
        try {
            tour()
        } finally {
            mark("end")
        }
    }

    private fun tour() {
        step("launch")
        // The first page load answers 1.5 s late (debug hook), so the loading skeleton reads on video.
        launch(MOCK_A, "tour", extras = mapOf("openbot.delay_first_load_ms" to "1500"))
        check(waitFor("sign_in_button", 20_000) != null, "demo: no Sign in button")
        pause(800)
        step("sign in through the Custom Tab")
        // Native sign-in, the Custom Tab with the mock's page followed by hand, each step held.
        if (!check(signInThroughCustomTab("tour", shots = false, paceMs = 1_000), "demo: signing in did not reach the tabs")) return
        check(waitPageText("Start a conversation", 30_000), "demo: Home did not render")
        pause(1_500)

        step("type on the software keyboard")
        // The software keyboard: the bottom bar hides, the message box sits on the keyboard.
        waitComposerRect(10_000)?.let { box ->
            tapComposer(box)
            // A tap too soon after the page rendered can focus the box without raising the keyboard.
            if (!waitKeyboard(true, 3_000)) {
                tapComposer(composerRect() ?: box)
            }
            if (waitKeyboard(true, 4_000)) {
                pause(500)
                typeOnKeyboard("pricing update", deadlineMs = 25_000)
                val typed = pageString("document.activeElement ? (document.activeElement.innerText || document.activeElement.value || '') : ''")
                note("demo: the message box holds ${typed.length} characters after typing")
                pause(1_000)
                screenshot("home-keyboard-typed")
                // Send (the video workflow's mock answers with a canned reply, MOCK_REPLY=1).
                webRect("Send message")?.let { tapFast(it.centerX(), it.centerY()) }
                pause(3_500)
                device.pressBack()
                waitKeyboard(false, 4_000)
            } else {
                note("demo: the software keyboard did not show")
            }
        }
        pause(800)

        step("conversations, open one, Back")
        // Conversations: open one, system Back.
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Competitor pricing notes", 15_000), "demo: no conversations")
        pause(1_200)
        tapWeb("Competitor pricing notes")
        check(waitPageText("closest competitors", 15_000), "demo: the conversation did not open")
        pause(1_500)
        if (keyboardShown()) screenshot("conversation-keyboard-still")
        dismissKeyboardIfUp()
        pause(600)
        device.pressBack()
        check(waitPageText("Quarterly forecast", 8_000), "demo: system Back did not return to the list")
        pause(1_200)

        step("bots, open one")
        // Bots: open one.
        // The emulator's GPU compositing misdraws the Bots page (RenderingTest: the DOM is right, a
        // software layer draws it right), so for this one scene of the recording the WebView is
        // drawn in software. The app itself always draws with the GPU.
        softwareLayer(true)
        tab(Tab.BOTS)?.click()
        check(waitPageText("Research Bot", 15_000), "demo: no Bots")
        pause(800)
        sleep(1_500)
        screenshot("bots-still")
        tapWeb("Research Bot")
        pause(2_000)
        dismissKeyboardIfUp()

        step("account menu, sign out")
        softwareLayer(false)
        // Home, the Account menu, Sign out: the native sign-in screen.
        tab(Tab.HOME)?.click()
        pause(1_200)
        check(tapWeb("Account"), "demo: no Account button")
        pause(1_200)
        check(tapWeb("Sign out"), "demo: no Sign out in the Account menu")
        check(waitFor("sign_in_button", 15_000) != null, "demo: Sign out did not return to the native sign-in")
        pause(1_500)

        step("lock screen")
        // The lock screen, then the connection comes back.
        launch(MOCK_A, "tour-offline", reset = false, extras = mapOf("openbot.force_offline_seconds" to "4"))
        check(waitFor("offline_lock", 5_000) != null, "demo: no lock screen")
        check(waitGone("offline_lock", 12_000), "demo: the lock did not lift")
        pause(1_500)
        endStep()
    }
}
