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

    /**
     * Expires every other cookie the base origin holds (names from CookieManager), except
     * Cloudflare's clearance cookies (`cf_*`, `__cf*`), which are not the person's and whose loss
     * only brings the bot check back. Answers how many.
     */
    fun clearOrigin(config: ShellConfig): Int {
        val manager = CookieManager.getInstance()
        val url = config.origin + "/"
        val secure = config.baseScheme == "https"
        val names = namesFor(config).filter { it !in NAMES && !it.startsWith("cf_") && !it.startsWith("__cf") }.distinct()
        for (name in names) {
            val attributes = "; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT" + if (secure) "; Secure" else ""
            manager.setCookie(url, "$name=$attributes")
            if (config.baseHost.contains('.')) manager.setCookie(url, "$name=$attributes; Domain=${config.baseHost}")
        }
        manager.flush()
        return names.size
    }

    /**
     * Calls `done` once the cookie store has applied every write queued before this call: the store
     * applies writes in order, so a last, harmless write's callback comes after them.
     */
    fun afterPendingWrites(config: ShellConfig, done: () -> Unit) {
        val manager = CookieManager.getInstance()
        manager.setCookie(config.origin + "/", "openbot-shell-barrier=; Path=/; Max-Age=0") {
            manager.flush()
            done()
        }
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
