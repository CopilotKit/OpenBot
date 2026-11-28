package ai.openbot.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Origins.same: scheme, host and effective port, failing closed on anything odd. */
class OriginsTest {
    private val base = "https://my.open.bot"

    @Test
    fun sameOriginWithPathQueryAndFragment() {
        assertTrue(Origins.same("https://my.open.bot/bots/b1?tab=chat#x", base))
        assertTrue(Origins.same("https://my.open.bot", base))
        assertTrue(Origins.same("https://my.open.bot/a b|c", base))
    }

    @Test
    fun sameHostDifferentPortIsAnotherOrigin() {
        assertFalse(Origins.same("https://my.open.bot:8443/", base))
        assertFalse(Origins.same("http://localhost:3011/", "http://localhost:3010"))
        assertTrue(Origins.same("http://localhost:3010/x", "http://localhost:3010"))
    }

    @Test
    fun differentSchemeIsAnotherOrigin() {
        assertFalse(Origins.same("http://my.open.bot/", base))
        assertFalse(Origins.same("ws://my.open.bot/", base))
        assertFalse(Origins.same("intent://my.open.bot/#Intent;end", base))
    }

    @Test
    fun defaultPortWrittenOrNotIsTheSame() {
        assertTrue(Origins.same("https://my.open.bot:443/x", base))
        assertTrue(Origins.same("http://10.0.2.2:80/", "http://10.0.2.2"))
        assertFalse(Origins.same("https://my.open.bot:80/", base))
        assertEquals("https://my.open.bot", Origins.of("HTTPS://My.Open.Bot:443/path").toString())
        assertEquals("http://localhost:3010", Origins.of("http://localhost:3010").toString())
    }

    @Test
    fun hostCaseIsIgnoredAndATrailingDotIsAnotherOrigin() {
        assertTrue(Origins.same("https://MY.Open.BOT/", base))
        assertTrue(Origins.same("HTTPS://my.open.bot/", base))
        assertFalse(Origins.same("https://my.open.bot./", base))
    }

    @Test
    fun lookalikesAndOddInputFailClosed() {
        assertFalse(Origins.same("https://my.open.bot.evil.com/", base))
        assertFalse(Origins.same("https://evil.com/my.open.bot", base))
        assertFalse(Origins.same("https://my.open.bot@evil.com/", base))
        assertFalse(Origins.same("https://evil.com@my.open.bot/", base))
        assertFalse(Origins.same("https://evil.com\\@my.open.bot/", base))
        assertFalse(Origins.same("about:blank", base))
        assertFalse(Origins.same("null", base))
        assertFalse(Origins.same("", base))
        assertFalse(Origins.same(null, base))
        assertFalse(Origins.same(base, null))
        assertNull(Origins.of("https:///path"))
    }

    @Test
    fun renewalReturnToUsesTheSameRule() {
        val intercepted = "$base/api/auth/hosted/sign-in?returnTo="
        assertEquals("/bots", ShellUrls.renewalTo(intercepted + ShellUrls.encode("https://my.open.bot:443/bots"), base))
        assertEquals("/", ShellUrls.renewalTo(intercepted + ShellUrls.encode("https://my.open.bot:8443/bots"), base))
        assertEquals("/", ShellUrls.renewalTo(intercepted + ShellUrls.encode("http://my.open.bot/bots"), base))
    }
}
