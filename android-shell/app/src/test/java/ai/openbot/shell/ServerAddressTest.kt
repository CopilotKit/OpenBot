package ai.openbot.shell

import ai.openbot.shell.ServerAddress.Reason
import ai.openbot.shell.ServerAddress.Result
import org.junit.Assert.assertEquals
import org.junit.Test

class ServerAddressTest {
    private fun ok(input: String, dev: Boolean = false) = ServerAddress.parse(input, dev) as Result.Ok
    private fun refused(input: String, dev: Boolean = false) = (ServerAddress.parse(input, dev) as Result.Refused).reason

    @Test
    fun hostAloneIsHttps() {
        assertEquals("https://openbot.example.com", ok("openbot.example.com").origin)
        assertEquals("https://openbot.example.com", ok("  OpenBot.Example.COM  ").origin)
        assertEquals("openbot.example.com", ok("openbot.example.com").host)
    }

    @Test
    fun portKeptAndShown() {
        assertEquals("https://openbot.example.com:8443", ok("openbot.example.com:8443").origin)
        assertEquals("openbot.example.com:8443", ok("openbot.example.com:8443").host)
        assertEquals("https://openbot.example.com", ok("https://openbot.example.com:443").origin)
    }

    @Test
    fun pathQueryAndSlashDropped() {
        assertEquals("https://openbot.example.com", ok("https://openbot.example.com/").origin)
        assertEquals("https://openbot.example.com", ok("https://openbot.example.com/bots?x=1#y").origin)
        assertEquals("https://openbot.example.com", ok("openbot.example.com/sign").origin)
    }

    @Test
    fun httpRefusedOutsideDevelopment() {
        assertEquals(Reason.HTTP, refused("http://openbot.example.com"))
        assertEquals(Reason.HTTP, refused("http://openbot.example.com", dev = true))
        assertEquals(Reason.HTTP, refused("http://127.0.0.1:3013"))
        assertEquals("http://127.0.0.1:3013", ok("http://127.0.0.1:3013", dev = true).origin)
        assertEquals("http://localhost:3010", ok("http://localhost:3010/", dev = true).origin)
        assertEquals("http://openbot.test", ok("http://openbot.test", dev = true).origin)
    }

    @Test
    fun credentialsRefused() {
        assertEquals(Reason.CREDENTIALS, refused("https://me:secret@openbot.example.com"))
        assertEquals(Reason.CREDENTIALS, refused("me@openbot.example.com"))
    }

    @Test
    fun nonsenseRefused() {
        assertEquals(Reason.EMPTY, refused("   "))
        assertEquals(Reason.INVALID, refused("openbot"))
        assertEquals(Reason.INVALID, refused("open bot.example.com"))
        assertEquals(Reason.INVALID, refused("ftp://openbot.example.com"))
        assertEquals(Reason.INVALID, refused("https://"))
        assertEquals(Reason.INVALID, refused("https://evil.com\\@openbot.example.com"))
        assertEquals(Reason.INVALID, refused("openbot.example.com:99999"))
    }
}
