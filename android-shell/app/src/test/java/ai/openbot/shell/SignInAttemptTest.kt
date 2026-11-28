package ai.openbot.shell

import ai.openbot.shell.SignInAttempt.AfterFailure
import ai.openbot.shell.SignInAttempt.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInAttemptTest {
    @Test
    fun signInClearsTheWebSessionBeforeEnter() {
        assertEquals(listOf(Step.CLEAR_SESSION, Step.LOAD_ENTER), SignInAttempt(renewal = false).stepsForEnter())
    }

    @Test
    fun renewalKeepsTheSession() {
        assertEquals(listOf(Step.LOAD_ENTER), SignInAttempt(renewal = true).stepsForEnter())
    }

    @Test
    fun theFailurePageMeansTheAttemptFailedWhateverFollows() {
        val attempt = SignInAttempt(renewal = false)
        assertTrue(attempt.acceptCallback())
        assertTrue(attempt.mayFinish())
        attempt.onOwnPage("/api/auth/shell/enter", "ticket=t&verifier=v&to=%2F")
        assertTrue(attempt.mayFinish())
        attempt.onOwnPage("/sign", "native-sign-in=failed")
        assertFalse(attempt.mayFinish())
        // The web app's /sign then goes to "/" on a session it found: still not a success.
        attempt.onOwnPage("/", null)
        assertFalse(attempt.mayFinish())
    }

    @Test
    fun otherSignPagesAreNotTheFailurePage() {
        assertTrue(SignInAttempt.isFailurePage("/sign", "native-sign-in=failed"))
        assertTrue(SignInAttempt.isFailurePage("/sign", "a=1&native-sign-in=failed"))
        assertFalse(SignInAttempt.isFailurePage("/sign", "native-sign-in=web"))
        assertFalse(SignInAttempt.isFailurePage("/sign", null))
        assertFalse(SignInAttempt.isFailurePage("/signal", "native-sign-in=failed"))
    }

    @Test
    fun aRefusedTicketGoesBackToWaitingAFewTimes() {
        val attempt = SignInAttempt(renewal = false)
        repeat(SignInAttempt.MAX_CALLBACKS - 1) {
            assertTrue(attempt.acceptCallback())
            assertFalse("a second callback while enter runs", attempt.acceptCallback())
            assertEquals(AfterFailure.WAIT_FOR_CALLBACK, attempt.enterFailed())
        }
        assertTrue(attempt.acceptCallback())
        assertEquals(AfterFailure.GIVE_UP, attempt.enterFailed())
        assertFalse(attempt.acceptCallback())
    }

    @Test
    fun aNewCallbackStartsWithoutTheOldFailure() {
        val attempt = SignInAttempt(renewal = false)
        attempt.acceptCallback()
        attempt.onOwnPage("/sign", "native-sign-in=failed")
        attempt.enterFailed()
        assertTrue(attempt.acceptCallback())
        assertTrue(attempt.mayFinish())
    }

    @Test
    fun aFailedRenewalGivesUp() {
        val attempt = SignInAttempt(renewal = true)
        attempt.acceptCallback()
        assertEquals(AfterFailure.GIVE_UP, attempt.enterFailed())
    }
}
