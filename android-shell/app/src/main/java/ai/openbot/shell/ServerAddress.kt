package ai.openbot.shell

/**
 * What a person types for their own OpenBot, made into an origin the app can use. Pure JVM, so the
 * unit tests cover it.
 *
 * Accepts `host`, `host:port`, `https://host[:port]`, with any path, query or fragment dropped (the
 * app always loads the origin's root) and the host lower-cased. https only; `http://` is accepted
 * only by a debug build, and only for a development host (localhost, 127.0.0.1, [::1], 10.0.2.2,
 * *.localhost, *.test), which the mock tests use. No user name or password.
 */
object ServerAddress {
    sealed class Result {
        data class Ok(val origin: String, val host: String) : Result()
        data class Refused(val reason: Reason) : Result()
    }

    enum class Reason { EMPTY, INVALID, HTTP, CREDENTIALS }

    fun parse(input: String, allowDevelopmentHttp: Boolean): Result {
        val text = input.trim()
        if (text.isEmpty()) return Result.Refused(Reason.EMPTY)
        if (text.any { it.isWhitespace() }) return Result.Refused(Reason.INVALID)
        val schemeEnd = text.indexOf("://")
        val scheme = if (schemeEnd > 0) text.substring(0, schemeEnd).lowercase() else "https"
        val rest = if (schemeEnd > 0) text.substring(schemeEnd + 3) else text
        if (scheme != "https" && scheme != "http") return Result.Refused(Reason.INVALID)
        val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
        val authority = if (end == -1) rest else rest.substring(0, end)
        if (authority.isEmpty() || authority.contains('\\')) return Result.Refused(Reason.INVALID)
        if (authority.contains('@')) return Result.Refused(Reason.CREDENTIALS)
        val origin = Origins.of("$scheme://$authority/") ?: return Result.Refused(Reason.INVALID)
        if (!origin.host.contains('.') && !origin.host.startsWith("[") && origin.host != "localhost") {
            return Result.Refused(Reason.INVALID)
        }
        if (origin.port !in 1..65535) return Result.Refused(Reason.INVALID)
        if (scheme == "http" && !(allowDevelopmentHttp && isDevelopmentHost(origin.host))) {
            return Result.Refused(Reason.HTTP)
        }
        return Result.Ok(origin.toString(), displayHost(origin))
    }

    fun isDevelopmentHost(host: String): Boolean =
        host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "10.0.2.2" ||
            host.endsWith(".localhost") || host.endsWith(".test")

    /** The host as a person reads it: with its port when it is not the default. */
    fun displayHost(origin: Origins.Origin): String =
        if (origin.port == Origins.defaultPort(origin.scheme)) origin.host else "${origin.host}:${origin.port}"

    fun displayHost(origin: String): String = Origins.of(origin)?.let { displayHost(it) } ?: origin
}
