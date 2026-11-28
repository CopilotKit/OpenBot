package ai.openbot.shell

import java.net.URI

/**
 * The one place the app decides whether two addresses share an origin: scheme, host and effective
 * port, as a browser compares them. Pure JVM (java.net.URI), so the unit tests cover it.
 *
 * - Scheme and host are compared without case; only http and https have an origin here.
 * - The port is the written one, else 443 for https and 80 for http, so `https://h` and
 *   `https://h:443` are the same origin and `https://h:8443` is another.
 * - A host written with a trailing dot (`my.open.bot.`) is a different origin, as it is to Chromium
 *   (`location.origin` keeps the dot).
 * - Anything that does not parse, has no host, or carries user info (`https://a@b/`) has no origin
 *   and so never matches: every check fails closed.
 */
object Origins {
    data class Origin(val scheme: String, val host: String, val port: Int) {
        /** "scheme://host[:port]", the default port left out, as `location.origin` spells it. */
        override fun toString(): String =
            if (port == defaultPort(scheme)) "$scheme://$host" else "$scheme://$host:$port"
    }

    fun of(url: String?): Origin? {
        if (url == null) return null
        val schemeEnd = url.indexOf("://")
        if (schemeEnd <= 0) return null
        val scheme = url.substring(0, schemeEnd).lowercase()
        if (scheme != "https" && scheme != "http") return null
        // Only the authority matters; parsing just it keeps a path or query that java.net.URI
        // would refuse (an unescaped "|" or space) from making an own page look foreign.
        val rest = url.substring(schemeEnd + 3)
        val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
        val authority = if (end == -1) rest else rest.substring(0, end)
        if (authority.isEmpty() || authority.contains('\\')) return null
        val uri = try {
            URI("$scheme://$authority/")
        } catch (error: Exception) {
            return null
        }
        if (uri.rawUserInfo != null) return null
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (uri.port != -1) uri.port else defaultPort(scheme)
        return Origin(scheme, host, port)
    }

    fun same(a: String?, b: String?): Boolean {
        val left = of(a) ?: return false
        return left == of(b)
    }

    fun defaultPort(scheme: String): Int = if (scheme == "https") 443 else 80
}
