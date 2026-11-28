package ai.openbot.shell

import java.net.URI
import java.net.URLDecoder

/**
 * The addresses of the sign-in hand-off and its renewal, built to the letter of the server's
 * contract (openbot-backend docs/shell-sign-in.md, "The enter contract" and "Renewing the hosted
 * sign-in"). Pure (java.net only), unit-tested on the JVM against the doc's worked example.
 */
object ShellUrls {
    private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"

    /** Percent-encodes every character outside A-Z a-z 0-9 - _ . ~ (UTF-8, capital hex): one query value. */
    fun encode(value: String): String {
        val out = StringBuilder()
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val c = (byte.toInt() and 0xFF).toChar()
            if (byte >= 0 && UNRESERVED.indexOf(c) >= 0) out.append(c)
            else out.append('%').append("0123456789ABCDEF"[(byte.toInt() shr 4) and 0xF]).append("0123456789ABCDEF"[byte.toInt() and 0xF])
        }
        return out.toString()
    }

    /** `/api/auth/shell/handoff?challenge=<C>&platform=android&callback=<scheme|https>`, in that order. */
    fun handoffPath(challenge: String, callback: String, platform: String = "android"): String =
        "/api/auth/shell/handoff?challenge=${encode(challenge)}&platform=${encode(platform)}&callback=${encode(callback)}"

    /** What the server's config said the callback is: "https" or "scheme". */
    fun callbackName(mode: HandoffMode?): String = if (mode is HandoffMode.Https) "https" else "scheme"

    /** The Custom Tab's address for a renewal: the hosted sign-in, returning to the hand-off. */
    fun renewalUrl(origin: String, handoffPath: String): String =
        "$origin/api/auth/hosted/sign-in?returnTo=${encode(handoffPath)}"

    /**
     * Where a renewal returns to: the intercepted address's `returnTo`, decoded once, when it is on
     * the OpenBot host (its path, query and fragment); otherwise "/".
     */
    fun renewalTo(interceptedUrl: String, origin: String): String {
        val query = try {
            URI(interceptedUrl).rawQuery
        } catch (error: Exception) {
            null
        } ?: return "/"
        val raw = query.split("&").firstOrNull { it.substringBefore("=") == "returnTo" }?.substringAfter("=", "") ?: return "/"
        val returnTo = try {
            URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8")
        } catch (error: Exception) {
            return "/"
        }
        if (returnTo.startsWith("/") && !returnTo.startsWith("//")) return returnTo
        val uri = try {
            URI(returnTo)
        } catch (error: Exception) {
            return "/"
        }
        if (!Origins.same(returnTo, origin)) return "/"
        val path = (uri.rawPath ?: "").ifEmpty { "/" }
        return path + (uri.rawQuery?.let { "?$it" } ?: "") + (uri.rawFragment?.let { "#$it" } ?: "")
    }

    /** `GET <origin>/api/auth/shell/enter?ticket=<T>&verifier=<V>&to=<to>`, each one encoded value. */
    fun enterUrl(origin: String, ticket: String, verifier: String, to: String): String =
        "$origin/api/auth/shell/enter?ticket=${encode(ticket)}&verifier=${encode(verifier)}&to=${encode(to)}"
}
