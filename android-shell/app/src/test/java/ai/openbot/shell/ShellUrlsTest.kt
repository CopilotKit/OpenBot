package ai.openbot.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/** The hand-off and renewal addresses against the server's contract and its worked example. */
class ShellUrlsTest {
    private val origin = "https://my.open.bot"

    @Test
    fun encodesOneQueryValue() {
        assertEquals("%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1", ShellUrls.encode("/bots/b1?tab=chat&openbot-renewed=1"))
        assertEquals("a-b_c.d~e%20f%21%2A%27%28%29%2B%C3%A9", ShellUrls.encode("a-b_c.d~e f!*'()+é"))
    }

    @Test
    fun renewalToFromReturnTo() {
        val intercepted = "$origin/api/auth/hosted/sign-in?returnTo=" + ShellUrls.encode("https://my.open.bot/bots/b1?tab=chat&openbot-renewed=1")
        val to = ShellUrls.renewalTo(intercepted, origin)
        assertEquals("/bots/b1?tab=chat&openbot-renewed=1", to)
        assertEquals("to=%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1", "to=" + ShellUrls.encode(to))
        assertEquals("/", ShellUrls.renewalTo("$origin/api/auth/hosted/sign-in", origin))
        assertEquals("/", ShellUrls.renewalTo("$origin/api/auth/hosted/sign-in?returnTo=" + ShellUrls.encode("https://evil.example/x"), origin))
        assertEquals("/", ShellUrls.renewalTo("$origin/api/auth/hosted/sign-in?returnTo=" + ShellUrls.encode("//evil.example/x"), origin))
        assertEquals("/bots", ShellUrls.renewalTo("$origin/api/auth/hosted/sign-in?returnTo=%2Fbots", origin))
    }

    @Test
    fun renewalUrlMatchesTheDoc() {
        val handoff = ShellUrls.handoffPath("C".repeat(43), "https")
        assertEquals("/api/auth/shell/handoff?challenge=${"C".repeat(43)}&platform=android&callback=https", handoff)
        assertEquals(
            "$origin/api/auth/hosted/sign-in?returnTo=%2Fapi%2Fauth%2Fshell%2Fhandoff%3Fchallenge%3D${"C".repeat(43)}%26platform%3Dandroid%26callback%3Dhttps",
            ShellUrls.renewalUrl(origin, handoff),
        )
    }

    @Test
    fun enterUrlEncodesEachValue() {
        assertEquals(
            "$origin/api/auth/shell/enter?ticket=T-1&verifier=V_2.x~&to=%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1",
            ShellUrls.enterUrl(origin, "T-1", "V_2.x~", "/bots/b1?tab=chat&openbot-renewed=1"),
        )
    }
}
