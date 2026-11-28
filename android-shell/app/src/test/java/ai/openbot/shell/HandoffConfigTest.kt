package ai.openbot.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The hand-off config decision and the callback check (the same cases as iOS's HandoffConfigTests). */
class HandoffConfigTest {
    private val host = "my.open.bot"

    private fun decide(status: Int?, body: String?, https: Boolean = true) =
        HandoffConfig.decide(status, body, host, https)

    @Test
    fun noAnswerIsUnreachable() {
        assertTrue(decide(null, null) is HandoffMode.Unreachable)
    }

    @Test
    fun notFoundAndOtherStatusesAreTheWebSignIn() {
        assertEquals(HandoffMode.WebSignIn("status-404"), decide(404, "Not found"))
        assertEquals(HandoffMode.WebSignIn("status-500"), decide(500, "{}"))
        assertEquals(HandoffMode.WebSignIn("status-302"), decide(302, null))
    }

    @Test
    fun handoffOffOrMalformedIsTheWebSignIn() {
        assertEquals(HandoffMode.WebSignIn("handoff-off"), decide(200, """{"handoff":false}"""))
        assertEquals(HandoffMode.WebSignIn("handoff-not-boolean"), decide(200, """{"handoff":"true"}"""))
        assertEquals(HandoffMode.WebSignIn("handoff-not-boolean"), decide(200, """{"handoff":1}"""))
        assertEquals(HandoffMode.WebSignIn("not-json-object"), decide(200, "not json"))
        assertEquals(HandoffMode.WebSignIn("not-json-object"), decide(200, "[1]"))
        assertEquals(HandoffMode.WebSignIn("callback-missing"), decide(200, """{"handoff":true}"""))
        assertEquals(HandoffMode.WebSignIn("callback-unknown"), decide(200, """{"handoff":true,"callback":"carrier-pigeon","callbackUrl":"x"}"""))
    }

    @Test
    fun schemeCallback() {
        assertEquals(HandoffMode.Scheme, decide(200, """{"handoff":true,"callback":"scheme","callbackUrl":"openbotshell://signed-in","extra":1}"""))
        assertEquals(HandoffMode.WebSignIn("scheme-url-unexpected"), decide(200, """{"handoff":true,"callback":"scheme","callbackUrl":"otherapp://signed-in"}"""))
    }

    @Test
    fun httpsCallback() {
        val ok = """{"handoff":true,"callback":"https","callbackUrl":"https://my.open.bot/api/auth/shell/callback"}"""
        assertEquals(HandoffMode.Https("my.open.bot", "/api/auth/shell/callback"), decide(200, ok))
        assertEquals(HandoffMode.WebSignIn("https-callback-not-verified"), decide(200, ok, https = false))
        for (bad in listOf(
            "http://my.open.bot/api/auth/shell/callback",
            "https://evil.example/api/auth/shell/callback",
            "https://my.open.bot:8443/api/auth/shell/callback",
            "https://my.open.bot/api/auth/shell/callback?x=1",
            "https://my.open.bot/",
            "https://my.open.bot",
        )) {
            assertEquals(bad, HandoffMode.WebSignIn("https-url-unexpected"),
                decide(200, """{"handoff":true,"callback":"https","callbackUrl":"$bad"}"""))
        }
    }

    @Test
    fun ticketFromTheExpectedCallbackOnly() {
        assertEquals("T1", HandoffConfig.ticket("openbotshell://signed-in?ticket=T1", HandoffMode.Scheme))
        assertNull(HandoffConfig.ticket("openbotshell://other?ticket=T1", HandoffMode.Scheme))
        assertNull(HandoffConfig.ticket("openbotshell://signed-in?ticket=", HandoffMode.Scheme))
        assertNull(HandoffConfig.ticket("openbotshell://signed-in", HandoffMode.Scheme))
        assertNull(HandoffConfig.ticket("https://my.open.bot/api/auth/shell/callback?ticket=T1", HandoffMode.Scheme))
        val https = HandoffMode.Https("my.open.bot", "/api/auth/shell/callback")
        assertEquals("T2", HandoffConfig.ticket("https://my.open.bot/api/auth/shell/callback?a=b&ticket=T2", https))
        assertNull(HandoffConfig.ticket("https://evil.example/api/auth/shell/callback?ticket=T2", https))
        assertNull(HandoffConfig.ticket("openbotshell://signed-in?ticket=T2", https))
        assertNull(HandoffConfig.ticket("openbotshell://signed-in?ticket=T2", HandoffMode.WebSignIn("x")))
    }

    @Test
    fun ticketIgnoresTheCallbacksOtherParameters() {
        val https = HandoffMode.Https("my.open.bot", "/api/auth/shell/callback")
        assertEquals("T3", HandoffConfig.ticket("https://my.open.bot/api/auth/shell/callback?ticket=T3&platform=android", https))
        assertEquals("T3", HandoffConfig.ticket("https://my.open.bot/api/auth/shell/callback?platform=android&ticket=T3", https))
        assertEquals("T4", HandoffConfig.ticket("openbotshell://signed-in?ticket=T4&platform=android", HandoffMode.Scheme))
        assertNull(HandoffConfig.ticket("https://my.open.bot/api/auth/shell/callback?platform=android", https))
    }

    @Test
    fun pkceChallengeIsS256OfTheVerifier() {
        // RFC 7636 appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            PkcePair.challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val pair = PkcePair.make()
        assertEquals(43, pair.verifier.length)
        assertEquals(43, pair.challenge.length)
        assertEquals(PkcePair.challengeFor(pair.verifier), pair.challenge)
        assertEquals("PkcePair(redacted)", pair.toString())
    }
}
