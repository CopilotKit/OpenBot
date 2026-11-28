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
        note("video-mark start ${System.currentTimeMillis() / 1000.0}")
        try {
            tour()
        } finally {
            note("video-mark end ${System.currentTimeMillis() / 1000.0}")
        }
    }

    private fun tour() {
        launch(MOCK_A, "tour")
        check(waitFor("sign_in_button", 20_000) != null, "demo: no Sign in button")
        pause(2_000)
        // Native sign-in, then the Custom Tab with the mock's page, followed by hand.
        if (!check(signInThroughCustomTab("tour", shots = false), "demo: signing in did not reach the tabs")) return
        check(waitPageText("Start a conversation", 30_000), "demo: Home did not render")
        pause(2_000)

        // The software keyboard: the bottom bar hides, the message box sits on the keyboard.
        val box = device.findObject(By.clazz("android.widget.EditText").pkg(pkg))
        if (box != null) {
            box.click()
            if (waitKeyboard(true, 8_000)) {
                pause(800)
                shell("input text What%schanged%sin%scompetitor%spricing?")
                pause(2_000)
                device.pressBack()
                waitKeyboard(false, 4_000)
            } else {
                note("demo: the software keyboard did not show")
            }
        }
        pause(1_500)

        // Conversations: scroll, open one, system Back.
        tab(Tab.CONVERSATIONS)?.click()
        check(waitPageText("Competitor pricing notes", 20_000), "demo: no conversations")
        pause(1_200)
        find("openbot_webview")?.swipe(Direction.UP, 0.6f)
        pause(800)
        find("openbot_webview")?.swipe(Direction.DOWN, 0.6f)
        pause(1_000)
        waitWebObject("Competitor pricing notes", 10_000)?.click()
        check(waitPageText("What do our three closest competitors charge?", 20_000) || waitPageText("per-seat", 2_000), "demo: the conversation did not open")
        pause(2_000)
        dismissKeyboardIfUp()
        pause(1_200)
        device.pressBack()
        check(waitPageText("Quarterly forecast", 8_000), "demo: system Back did not return to the list")
        pause(1_500)

        // Bots: open one.
        tab(Tab.BOTS)?.click()
        waitWebObject("Research Bot", 20_000)?.click()
        pause(2_500)
        dismissKeyboardIfUp()

        // Home, the Account menu, Sign out: the native sign-in screen.
        tab(Tab.HOME)?.click()
        pause(1_500)
        (device.findObject(By.desc("Account")) ?: waitWebObject("Account", 10_000))?.click()
        pause(1_500)
        waitWebObject("Sign out", 10_000)?.click()
        check(waitFor("sign_in_button", 20_000) != null, "demo: Sign out did not return to the native sign-in")
        pause(2_000)

        // The lock screen, then the connection comes back.
        launch(MOCK_A, "tour-offline", reset = false, extras = mapOf("openbot.force_offline_seconds" to "5"))
        check(waitFor("offline_lock", 5_000) != null, "demo: no lock screen")
        check(waitGone("offline_lock", 15_000), "demo: the lock did not lift")
        pause(2_000)
    }
}
