package ai.openbot.shell

import org.json.JSONException
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/** What the server's `GET /api/auth/shell/config?platform=android` answer means for signing in. */
sealed class HandoffMode {
    /** No answer at all (network error, timeout): the lock screen. */
    data class Unreachable(val reason: String) : HandoffMode()

    /** No hand-off, or an answer this app does not understand: the web app's own sign-in. */
    data class WebSignIn(val reason: String) : HandoffMode()

    /** The Custom Tab finishes on `openbotshell://signed-in?ticket=`. */
    data object Scheme : HandoffMode()

    /** The Custom Tab finishes on `https://<host><path>?ticket=`, a verified App Link of this app. */
    data class Https(val host: String, val path: String) : HandoffMode()
}

/** Pure logic (java.net and org.json only), unit-tested on the JVM (src/test). */
object HandoffConfig {
    const val SCHEME_CALLBACK = "openbotshell://signed-in"

    /**
     * Decides from the HTTP status (null: no answer) and body. Strict: `handoff` must be a boolean;
     * when true, `callback` must be "scheme" with `callbackUrl` exactly openbotshell://signed-in, or
     * "https" with an https `callbackUrl` on the base URL's own host and a path. Anything else is the
     * web sign-in. Other keys are ignored, so the server can add some.
     */
    fun decide(status: Int?, body: String?, baseHost: String, httpsCallbackSupported: Boolean): HandoffMode {
        if (status == null) return HandoffMode.Unreachable("no-answer")
        if (status != 200) return HandoffMode.WebSignIn("status-$status")
        val json = try {
            JSONObject(body ?: return HandoffMode.WebSignIn("not-json-object"))
        } catch (error: JSONException) {
            return HandoffMode.WebSignIn("not-json-object")
        }
        val flag = json.opt("handoff") as? Boolean ?: return HandoffMode.WebSignIn("handoff-not-boolean")
        if (!flag) return HandoffMode.WebSignIn("handoff-off")
        val callback = json.opt("callback") as? String
        val callbackUrl = json.opt("callbackUrl") as? String
        if (callback == null || callbackUrl == null) return HandoffMode.WebSignIn("callback-missing")
        return when (callback) {
            "scheme" ->
                if (callbackUrl == SCHEME_CALLBACK) HandoffMode.Scheme else HandoffMode.WebSignIn("scheme-url-unexpected")
            "https" -> {
                val uri = try {
                    URI(callbackUrl)
                } catch (error: URISyntaxException) {
                    return HandoffMode.WebSignIn("https-url-unexpected")
                }
                val host = uri.host?.lowercase()
                val path = uri.rawPath ?: ""
                val ok = uri.scheme.equals("https", ignoreCase = true) && host != null &&
                    host == baseHost.lowercase() && uri.port == -1 && uri.rawQuery == null &&
                    uri.rawFragment == null && path.isNotEmpty() && path != "/"
                when {
                    !ok -> HandoffMode.WebSignIn("https-url-unexpected")
                    !httpsCallbackSupported -> HandoffMode.WebSignIn("https-callback-not-verified")
                    else -> HandoffMode.Https(host!!, path)
                }
            }
            else -> HandoffMode.WebSignIn("callback-unknown")
        }
    }

    /** Whether a callback URL is the one `mode` expects, and its ticket. */
    fun ticket(callbackUrl: String?, mode: HandoffMode?): String? {
        if (callbackUrl == null || mode == null) return null
        val uri = try {
            URI(callbackUrl)
        } catch (error: URISyntaxException) {
            return null
        }
        when (mode) {
            is HandoffMode.Scheme ->
                if (!uri.scheme.equals("openbotshell", ignoreCase = true) || uri.host != "signed-in") return null
            is HandoffMode.Https ->
                if (!uri.scheme.equals("https", ignoreCase = true) || uri.host?.lowercase() != mode.host ||
                    uri.rawPath != mode.path || uri.port != -1
                ) return null
            else -> return null
        }
        val query = uri.rawQuery ?: return null
        for (part in query.split("&")) {
            val name = part.substringBefore("=")
            if (name == "ticket" && part.contains("=")) {
                val value = URLDecoder.decode(part.substringAfter("="), "UTF-8")
                return value.ifEmpty { null }
            }
        }
        return null
    }

    fun describe(mode: HandoffMode?): String = when (mode) {
        null -> "unknown"
        is HandoffMode.Unreachable -> "unreachable ${mode.reason}"
        is HandoffMode.WebSignIn -> "web ${mode.reason}"
        is HandoffMode.Scheme -> "scheme"
        is HandoffMode.Https -> "https"
    }
}
