package ai.openbot.shell

import ai.openbot.shell.ServerCheck.Failure
import ai.openbot.shell.ServerCheck.Outcome
import org.junit.Assert.assertEquals
import org.junit.Test

class ServerCheckTest {
    @Test
    fun theConfigAnswerIsAccepted() {
        assertEquals(Outcome.OK, ServerCheck.fromAnswer(200, """{"handoff":true,"callback":"scheme","callbackUrl":"openbotshell://signed-in"}"""))
        assertEquals(Outcome.OK, ServerCheck.fromAnswer(200, """{"handoff":false}"""))
    }

    @Test
    fun anythingElseIsTooOld() {
        assertEquals(Outcome.TOO_OLD, ServerCheck.fromAnswer(404, """{"error":"not found"}"""))
        assertEquals(Outcome.TOO_OLD, ServerCheck.fromAnswer(200, "<!doctype html><title>Some site</title>"))
        assertEquals(Outcome.TOO_OLD, ServerCheck.fromAnswer(200, """{"ok":true}"""))
        assertEquals(Outcome.TOO_OLD, ServerCheck.fromAnswer(302, null))
    }

    @Test
    fun failuresSayWhatToCheck() {
        assertEquals(Failure.DNS, ServerCheck.failureOf(java.net.UnknownHostException("x")))
        assertEquals(Failure.TLS, ServerCheck.failureOf(javax.net.ssl.SSLHandshakeException("x")))
        assertEquals(Failure.TIMEOUT, ServerCheck.failureOf(java.net.SocketTimeoutException("x")))
        assertEquals(Failure.REFUSED, ServerCheck.failureOf(java.net.ConnectException("x")))
        assertEquals(Failure.TLS, ServerCheck.failureOf(java.io.IOException("wrapped", java.security.cert.CertificateException("x"))))
        assertEquals(Outcome.NOT_FOUND, ServerCheck.fromFailure(Failure.DNS))
        assertEquals(Outcome.CERTIFICATE, ServerCheck.fromFailure(Failure.TLS))
        assertEquals(Outcome.NO_ANSWER, ServerCheck.fromFailure(Failure.TIMEOUT))
    }
}
