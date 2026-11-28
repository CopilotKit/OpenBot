package ai.openbot.shell.test

import androidx.test.ext.junit.runners.AndroidJUnit4
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
        launch(MOCK_A, "tour")
        check(waitFor("sign_in_button", 20_000) != null, "demo: no Sign in button")
        pause(800)
        step("sign in through the Custom Tab")
        // Native sign-in, the Custom Tab with the mock's page followed by hand, each step held.
        if (!check(signInThroughCustomTab("tour", shots = false, paceMs = 700), "demo: signing in did not reach the tabs")) return
        check(waitPageText("Start a conversation", 30_000), "demo: Home did not render")
        pause(800)

        step("send from Home")
        // The software keyboard: the bottom bar hides, the message box sits on the keyboard. Sending
        // lands in the new conversation with Home still selected; Back returns to Home.
        waitComposerRect(10_000)?.let { box ->
            tapComposer(box)
            // A tap too soon after the page rendered can focus the box without raising the keyboard.
            if (!waitKeyboard(true, 3_000)) {
                tapComposer(composerRect() ?: box)
            }
            if (waitKeyboard(true, 4_000)) {
                pause(400)
                typeOnKeyboard("pricing update", deadlineMs = 25_000)
                val typed = pageString("document.activeElement ? (document.activeElement.innerText || document.activeElement.value || '') : ''")
                note("demo: the message box holds ${typed.length} characters after typing")
                pause(600)
                // Send (the video workflow's mock answers with a canned reply, MOCK_REPLY=1).
                webRect("Send message")?.let { tapFast(it.centerX(), it.centerY()) }
                waitForState("path=/channel", 10_000)
                pause(1_500)
                dismissKeyboardIfUp()
                note("demo: after sending: ${debugState()}")
                screenshot("sent-from-home")
                pause(800)
                device.pressBack()
                check(waitPageText("Start a conversation", 10_000), "demo: Back did not return to Home")
            } else {
                note("demo: the software keyboard did not show")
            }
        }
        pause(700)

        step("chats: open one, Back")
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Trip to Lisbon", 15_000), "demo: no Chats list")
        pause(1_400)
        screenshot("chats-list")
        tapWeb("Quarterly forecast")
        check(waitForState("path=/channel", 15_000), "demo: the conversation did not open")
        pause(400)
        dismissKeyboardIfUp()
        pause(1_400)
        screenshot("conversation-back-control")
        device.pressBack()
        check(waitPageText("Trip to Lisbon", 8_000), "demo: system Back did not return to the list")
        pause(800)

        step("bots: open a Bot's conversation, Back")
        // The emulator's GPU compositing misdrew the old Bots page (RenderingTest), so this scene
        // is drawn in software for the recording only. The app itself always draws with the GPU.
        softwareLayer(true)
        tab(Tab.BOTS)?.click()
        check(waitPageText("General Assistant", 15_000), "demo: no Bots list")
        pause(1_400)
        screenshot("bots-list")
        tapWeb("Hiring plan")
        check(waitForState("path=/channel", 15_000), "demo: the Bot's conversation did not open")
        pause(400)
        dismissKeyboardIfUp()
        pause(1_400)
        device.pressBack()
        check(waitForState("path=/bots", 8_000), "demo: Back did not return to the Bots list")
        pause(700)
        softwareLayer(false)

        step("tabs kept where they were left, reselect to the root")
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Competitor pricing notes", 10_000), "demo: no Chats list")
        pause(500)
        tapWeb("Competitor pricing notes")
        check(waitForState("path=/channel", 15_000), "demo: the conversation did not open")
        pause(400)
        dismissKeyboardIfUp()
        pause(800)
        tab(Tab.BOTS)?.click()
        waitForState("path=/bots", 8_000)
        pause(1_000)
        tab(Tab.CONVERSATIONS)?.click()
        check(waitForState("path=/channel", 8_000), "demo: Chats did not come back to the open conversation")
        pause(400)
        dismissKeyboardIfUp()
        pause(1_000)
        tab(Tab.CONVERSATIONS)?.click()
        check(waitForState("path=/conversations", 8_000), "demo: reselecting Chats did not pop to the list")
        pause(1_000)

        step("account menu, sign out")
        tab(Tab.HOME)?.click()
        pause(700)
        check(tapWeb("Account"), "demo: no Account button")
        pause(1_000)
        check(tapWeb("Sign out"), "demo: no Sign out in the Account menu")
        check(waitFor("sign_in_button", 15_000) != null, "demo: Sign out did not return to the native sign-in")
        pause(1_500)
        endStep()
    }
}
