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
        // The first page load answers 1.5 s late (debug hook), so the loading skeleton reads on video.
        launch(MOCK_A, "tour", extras = mapOf("openbot.delay_first_load_ms" to "1500"))
        check(waitFor("sign_in_button", 20_000) != null, "demo: no Sign in button")
        pause(800)
        // Native sign-in, the Custom Tab with the mock's page followed by hand, each step held.
        if (!check(signInThroughCustomTab("tour", shots = false, paceMs = 1_500), "demo: signing in did not reach the tabs")) return
        check(waitPageText("Start a conversation", 30_000), "demo: Home did not render")
        pause(1_500)

        // The software keyboard: the bottom bar hides, the message box sits on the keyboard.
        val box = waitComposerRect(10_000) ?: run {
            check(false, "demo: no message box")
            return
        }
        tapComposer(box)
        if (!check(waitKeyboard(true, 6_000), "demo: the software keyboard did not appear")) return
        val prompt = "what changed in pricing"
        // Deliver the text through Android's input system while the software keyboard is visible.
        shell("input text " + prompt.replace(" ", "%s"))
        val typed = pageString("document.activeElement?.innerText || document.activeElement?.value || ''")
        if (!check(typed.trim().equals(prompt, ignoreCase = true), "demo: typing did not reach the message box")) return
        screenshot("home-keyboard-typed")
        pause(1_200)
        if (!check(tapWeb("Send message"), "demo: Send is not reachable")) return
        if (!check(waitPageText("All three competitors now charge per seat.", 20_000), "demo: no reply")) return
        screenshot("conversation-reply")
        pause(1_200)
        dismissKeyboardIfUp()
        pause(800)

        // Conversations: open one, system Back.
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Competitor pricing notes", 15_000), "demo: no conversations")
        pause(1_200)
        tapWeb("Competitor pricing notes")
        check(waitPageText("What do our three closest competitors charge?", 15_000) || waitPageText("per-seat", 1_000), "demo: the conversation did not open")
        pause(1_800)
        if (keyboardShown()) screenshot("conversation-keyboard-still")
        dismissKeyboardIfUp()
        pause(600)
        device.pressBack()
        check(waitPageText("Quarterly forecast", 8_000), "demo: system Back did not return to the list")
        pause(1_200)

        // Bots: open one.
        tab(Tab.BOTS)?.click()
        check(waitPageText("Research Bot", 15_000), "demo: no Bots")
        pause(800)
        sleep(1_500)
        screenshot("bots-still")
        tapWeb("Research Bot")
        pause(2_000)
        dismissKeyboardIfUp()

        // Home, the Account menu, Sign out: the native sign-in screen.
        tab(Tab.HOME)?.click()
        pause(1_200)
        check(tapWeb("Account"), "demo: no Account button")
        pause(1_200)
        check(tapWeb("Sign out"), "demo: no Sign out in the Account menu")
        check(waitFor("sign_in_button", 15_000) != null, "demo: Sign out did not return to the native sign-in")
        pause(1_500)

        // The lock screen, then the connection comes back.
        launch(MOCK_A, "tour-offline", reset = false, extras = mapOf("openbot.force_offline_seconds" to "4"))
        check(waitFor("offline_lock", 5_000) != null, "demo: no lock screen")
        check(waitGone("offline_lock", 12_000), "demo: the lock did not lift")
        pause(1_500)
    }
}
