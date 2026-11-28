package ai.openbot.shell

import ai.openbot.shell.BackPolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackPolicyTest {
    @Test
    fun theKeyboardClosesFirstWhateverThePageSays() {
        for (page in listOf(true, false, null)) {
            for (history in listOf(true, false)) {
                assertEquals(Action.CLOSE_KEYBOARD, BackPolicy.decide(keyboardUp = true, pageCanGoBack = page, historyCanGoBack = history))
            }
        }
    }

    @Test
    fun aPageThatCanGoBackGetsTheCommand() {
        assertEquals(Action.PAGE_BACK, BackPolicy.decide(false, true, historyCanGoBack = false))
        assertEquals(Action.PAGE_BACK, BackPolicy.decide(false, true, historyCanGoBack = true))
    }

    @Test
    fun atATabRootBackLeavesTheAppNotTheHistory() {
        assertEquals(Action.LEAVE_APP, BackPolicy.decide(false, false, historyCanGoBack = true))
        assertEquals(Action.LEAVE_APP, BackPolicy.decide(false, false, historyCanGoBack = false))
        assertFalse(BackPolicy.handles(Action.LEAVE_APP))
    }

    @Test
    fun withoutCanGoBackTheWebViewHistoryAsBefore() {
        assertEquals(Action.WEBVIEW_HISTORY, BackPolicy.decide(false, null, historyCanGoBack = true))
        assertEquals(Action.LEAVE_APP, BackPolicy.decide(false, null, historyCanGoBack = false))
    }

    @Test
    fun theCallbackIsOnForEverythingButLeaving() {
        assertTrue(BackPolicy.handles(Action.CLOSE_KEYBOARD))
        assertTrue(BackPolicy.handles(Action.PAGE_BACK))
        assertTrue(BackPolicy.handles(Action.WEBVIEW_HISTORY))
    }
}
