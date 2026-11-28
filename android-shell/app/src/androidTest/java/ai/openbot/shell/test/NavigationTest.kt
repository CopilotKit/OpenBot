package ai.openbot.shell.test

import android.graphics.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.Direction
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The tabs as a normal app's: the web app keeps 1 stack per tab and says `canGoBack` in its
 * `route` messages; Back pops the current tab's stack (`openbot:back`), a tab comes back where it
 * was left, the current tab's tap pops it to its root, and Back at a root leaves the app.
 * Against this branch's web build over mock stack A (15 conversations, 3 Bots).
 */
@RunWith(AndroidJUnit4::class)
class NavigationTest : ShellTestBase() {
    private val listMarker = "Trip to Lisbon"

    private fun openChats(): Boolean {
        tab(Tab.CONVERSATIONS)?.click()
        val ok = waitPageText(listMarker, 20_000)
        check(ok, "the Chats list did not show; ${debugState()}")
        return ok && waitForState("tab=conversations", 5_000)
    }

    /** The page rect (CSS px) of the smallest element whose text starts with `text`; no scrolling. */
    private fun textRect(text: String): Rect? {
        val raw = pageString(
            "(function(t){var best=null;var all=document.querySelectorAll('a,button,span,p,div,h1,h2,h3');" +
                "for(var i=0;i<all.length;i++){var e=all[i];var s=(e.innerText||'').trim();" +
                "if(s===t||s.indexOf(t)===0){var r=e.getBoundingClientRect();" +
                "if(r.width>0&&r.height>0&&(!best||r.width*r.height<best.a))best={a:r.width*r.height,r:r};}}" +
                "if(!best)return 'null';var q=best.r;return JSON.stringify({l:q.left,t:q.top,r:q.right,b:q.bottom});})(" +
                org.json.JSONObject.quote(text) + ")",
        )
        if (raw == "null" || raw.isEmpty()) return null
        return try {
            val json = org.json.JSONObject(raw)
            Rect(json.getDouble("l").toInt(), json.getDouble("t").toInt(), json.getDouble("r").toInt(), json.getDouble("b").toInt())
        } catch (error: Exception) {
            null
        }
    }

    private fun conversationOpen(): Boolean = waitForState("path=/channel", 15_000) && waitForState("canGoBack=1", 5_000)

    // A conversation opened from Chats: back by the header's Back and by system Back, to the list at
    // the same scroll position, Chats selected throughout.
    @Test
    fun testChatsConversationBackKeepsTheList() {
        if (!launchSignedIn()) return
        if (!openChats()) return
        check(waitForState("canGoBack=0", 5_000), "the Chats list says it can go back: ${debugState()}")
        find("openbot_webview")?.swipe(Direction.UP, 0.35f)
        sleep(1_200)
        screenshot("1-chats-list-scrolled")
        val reference = "Launch announcement"
        val before = textRect(reference)
        note("before opening: '$reference' at $before")

        check(tapWeb("Quarterly forecast"), "no 'Quarterly forecast' row")
        if (!check(conversationOpen(), "the conversation did not open: ${debugState()}")) return
        dismissKeyboardIfUp()
        check(debugState().contains("tab=conversations"), "Chats is not selected in the conversation: ${debugState()}")
        check(webRect("Back") != null, "the conversation header has no Back")
        sleep(800)
        screenshot("2-conversation-with-back")

        check(tapWeb("Back"), "could not tap the header's Back")
        check(waitPageText(listMarker, 10_000) && waitForState("path=/conversations", 5_000), "the header's Back did not return to the list: ${debugState()}")
        check(debugState().contains("tab=conversations"), "Chats is not selected after Back: ${debugState()}")
        sleep(800)
        val afterControl = textRect(reference)
        note("after the header's Back: '$reference' at $afterControl")
        if (before != null && afterControl != null) check(kotlin.math.abs(before.top - afterControl.top) <= 4, "the list did not keep its scroll after the header's Back ($before, then $afterControl)")
        screenshot("3-back-by-control")

        check(tapWeb("Quarterly forecast"), "no 'Quarterly forecast' row the second time")
        if (!check(conversationOpen(), "the conversation did not open the second time: ${debugState()}")) return
        dismissKeyboardIfUp()
        device.pressBack()
        check(waitPageText(listMarker, 10_000) && waitForState("path=/conversations", 5_000), "system Back did not return to the list: ${debugState()}")
        check(device.currentPackageName == pkg, "system Back left the app")
        check(debugState().contains("tab=conversations"), "Chats is not selected after system Back: ${debugState()}")
        sleep(800)
        val afterSystem = textRect(reference)
        note("after system Back: '$reference' at $afterSystem")
        if (before != null && afterSystem != null) check(kotlin.math.abs(before.top - afterSystem.top) <= 4, "the list did not keep its scroll after system Back ($before, then $afterSystem)")
        screenshot("4-back-by-system")
    }

    // A conversation opened from the Bots list keeps Bots selected; Back returns to the Bots list.
    @Test
    fun testBotsConversationKeepsBots() {
        if (!launchSignedIn()) return
        tab(Tab.BOTS)?.click()
        check(waitPageText("General Assistant", 20_000) && waitForState("tab=bots", 5_000), "the Bots list did not show: ${debugState()}")
        sleep(1_000)
        screenshot("1-bots-list")
        check(tapWeb("Hiring plan"), "no 'Hiring plan' under General Assistant")
        if (!check(conversationOpen(), "the Bot's conversation did not open: ${debugState()}")) return
        dismissKeyboardIfUp()
        check(debugState().contains("tab=bots"), "a conversation opened from Bots moved the tab: ${debugState()}")
        sleep(800)
        screenshot("2-bot-conversation")
        device.pressBack()
        check(waitForState("path=/bots", 10_000) && waitPageText("General Assistant", 5_000), "Back did not return to the Bots list: ${debugState()}")
        check(debugState().contains("tab=bots"), "Bots is not selected after Back: ${debugState()}")
        screenshot("3-back-to-bots")
    }

    // Each tab comes back where it was left; the current tab's tap pops it to its root.
    @Test
    fun testTabsRememberWhereTheyWereLeft() {
        if (!launchSignedIn()) return
        if (!openChats()) return
        check(tapWeb("Quarterly forecast"), "no 'Quarterly forecast' row")
        if (!check(conversationOpen(), "the conversation did not open: ${debugState()}")) return
        dismissKeyboardIfUp()
        tab(Tab.BOTS)?.click()
        check(waitForState("tab=bots", 10_000) && waitForState("path=/bots", 10_000), "Bots did not show: ${debugState()}")
        sleep(800)
        screenshot("1-switched-to-bots")
        tab(Tab.CONVERSATIONS)?.click()
        check(waitForState("tab=conversations", 10_000) && waitForState("path=/channel", 10_000), "Chats did not come back to the open conversation: ${debugState()}")
        check(waitPageText("Here is the first draft.", 10_000) || waitPageText("Can you draft", 2_000), "the conversation is not the one left open")
        dismissKeyboardIfUp()
        sleep(800)
        screenshot("2-chats-where-it-was-left")
        // Chats again, while in Chats: its root.
        tab(Tab.CONVERSATIONS)?.click()
        check(waitForState("path=/conversations", 10_000) && waitPageText(listMarker, 5_000), "reselecting Chats did not show the list: ${debugState()}")
        check(waitForState("canGoBack=0", 5_000), "the list after reselecting can still go back: ${debugState()}")
        screenshot("3-reselected-chats-list")
    }

    // Back at a tab's root leaves the app, as Android expects; not to another tab.
    @Test
    fun testBackAtARootLeavesTheApp() {
        if (!launchSignedIn()) return
        if (!openChats()) return
        check(waitForState("canGoBack=0", 5_000), "the Chats root says it can go back: ${debugState()}")
        sleep(800)
        device.pressBack()
        sleep(2_000)
        note("after Back at the Chats root: foreground ${foregroundPackage()}")
        check(device.currentPackageName != pkg, "Back at the Chats root stayed in the app: ${debugState()}")
        screenshot("1-left-the-app")
    }

    // Settings from the Account menu has Back, which returns to where it was opened.
    @Test
    fun testSettingsHasBack() {
        if (!launchSignedIn()) return
        if (!openChats()) return
        check(tapWeb("Account"), "no Account button on Chats")
        sleep(800)
        screenshot("1-account-menu")
        check(tapWeb("Settings"), "no Settings in the Account menu")
        check(waitForState("path=/settings", 10_000) && waitForState("canGoBack=1", 5_000), "Settings did not open on the Chats stack: ${debugState()}")
        check(webRect("Back") != null, "Settings has no Back")
        sleep(800)
        screenshot("2-settings-with-back")
        check(tapWeb("Back"), "could not tap Settings' Back")
        check(waitForState("path=/conversations", 10_000) && waitPageText(listMarker, 5_000), "Settings' Back did not return to Chats: ${debugState()}")
        check(debugState().contains("tab=conversations"), "Chats is not selected after Settings: ${debugState()}")
        screenshot("3-back-from-settings")
    }
}
