package ai.openbot.shell

import android.webkit.CookieManager

/**
 * The web app's session cookie in the WebView's cookie store: whether it is there, removing it,
 * and (debug hooks) planting one. CookieManager only ever gives "name=value" pairs: this file reads
 * the names and drops the values at once, and never logs one.
 */
object SessionCookies {
    const val PLAIN_NAME = "better-auth.session_token"
    const val SECURE_NAME = "__Secure-better-auth.session_token"
    val NAMES = setOf(PLAIN_NAME, SECURE_NAME)

    /** The cookie names in a Cookie header ("a=1; b=2" -> [a, b]). */
    fun names(cookieHeader: String?): List<String> =
        cookieHeader?.split(";")?.map { it.substringBefore("=").trim() }?.filter { it.isNotEmpty() } ?: emptyList()

    fun namesFor(config: ShellConfig): List<String> = names(CookieManager.getInstance().getCookie(config.origin + "/"))

    fun present(config: ShellConfig): Boolean = namesFor(config).any { it in NAMES }

    /** Expires both session cookies for the base host and leaves every other cookie alone. */
    fun delete(config: ShellConfig): Int {
        val manager = CookieManager.getInstance()
        val url = config.origin + "/"
        val count = namesFor(config).count { it in NAMES }
        val secure = config.baseScheme == "https"
        val expired = "; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        for (name in NAMES) {
            if (name == SECURE_NAME && !secure) continue
            val attributes = expired + if (secure) "; Secure" else ""
            manager.setCookie(url, "$name=$attributes")
            if (config.baseHost.contains('.')) manager.setCookie(url, "$name=$attributes; Domain=${config.baseHost}")
        }
        manager.flush()
        return count
    }

    /** Plants a session cookie (the debug hooks only). */
    fun set(config: ShellConfig, name: String, value: String, secure: Boolean, done: (Boolean) -> Unit) {
        val attributes = "; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax" + if (secure) "; Secure" else ""
        CookieManager.getInstance().setCookie(config.origin + "/", "$name=$value$attributes") { ok ->
            CookieManager.getInstance().flush()
            done(ok)
        }
    }
}
