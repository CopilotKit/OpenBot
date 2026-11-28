package ai.openbot.shell

import android.content.Intent
import android.net.Uri

/** What the debug-only hooks asked for (src/debug/.../DebugHooks.kt). All off in release builds. */
class HookValues(
    val plainWebView: Boolean = false,
    val reset: Boolean = false,
    val sessionCookie: String? = null,
    val staleSession: Boolean = false,
    val handoffAuto: Boolean = false,
    val forceOffline: Boolean = false,
    val forceOfflineSeconds: Long? = null,
    val forceDark: Boolean = false,
    val customTabUrl: String? = null,
) {
    override fun toString(): String = "HookValues(redacted)"
}

/**
 * Where the app points and what the tests asked for, read once when the activity is created.
 *
 * The base URL of a release build is BuildConfig.BASE_URL (https://my.open.bot) and nothing else.
 * The debug and releaseTest builds (BuildConfig.TEST_OVERRIDES) also read three intent extras the
 * tests send: the base URL, diagnostics on, and the test's name. R8 removes that code from release.
 */
class ShellConfig(
    /** scheme://host[:port] of the OpenBot web app, no path. */
    val baseUrl: Uri,
    /** The base URL extra as given, path included: what the debug plain mode loads. */
    val startUrl: String?,
    val version: String,
    val diagnosticsEnabled: Boolean,
    val testName: String,
    val hooks: HookValues,
) {
    val baseHost: String get() = baseUrl.host?.lowercase() ?: ""
    val baseScheme: String get() = baseUrl.scheme?.lowercase() ?: "https"

    /** "scheme://host[:port]", as `location.origin` and WebView's origin rules spell it. */
    val origin: String get() = baseUrl.toString().trimEnd('/')

    /** The base URL with a path (which may carry a query) appended. */
    fun url(pathAndQuery: String): String =
        origin + if (pathAndQuery.startsWith("/")) pathAndQuery else "/$pathAndQuery"

    fun isOwnOrigin(uri: Uri?): Boolean {
        if (uri == null) return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != baseScheme) return false
        if ((uri.host?.lowercase() ?: "") != baseHost) return false
        return effectivePort(uri) == effectivePort(baseUrl)
    }

    fun isOwnOrigin(url: String?): Boolean = url != null && isOwnOrigin(Uri.parse(url))

    companion object {
        fun effectivePort(uri: Uri): Int = when {
            uri.port != -1 -> uri.port
            uri.scheme.equals("https", ignoreCase = true) -> 443
            else -> 80
        }

        fun from(intent: Intent?): ShellConfig {
            var baseOverride: String? = null
            var diagnostics = false
            var testName = ""
            if (BuildConfig.TEST_OVERRIDES) {
                val overrides = TestOverrides.read(intent)
                baseOverride = overrides.baseUrl
                diagnostics = overrides.diagnostics
                testName = overrides.testName
            }
            return ShellConfig(
                baseUrl = resolveBase(baseOverride),
                startUrl = baseOverride,
                version = BuildConfig.VERSION_NAME,
                diagnosticsEnabled = diagnostics,
                testName = testName,
                hooks = DebugHooks.read(intent),
            )
        }

        /** The override when it is an http(s) URL with a host, else BuildConfig.BASE_URL; origin only. */
        fun resolveBase(candidate: String?): Uri {
            for (value in listOfNotNull(candidate, BuildConfig.BASE_URL)) {
                val uri = Uri.parse(value)
                val scheme = uri.scheme?.lowercase()
                val host = uri.host?.lowercase()
                if ((scheme == "https" || scheme == "http") && !host.isNullOrEmpty()) {
                    val authority = if (uri.port != -1) "$host:${uri.port}" else host
                    return Uri.Builder().scheme(scheme).encodedAuthority(authority).build()
                }
            }
            return Uri.parse("https://my.open.bot")
        }
    }
}

/**
 * The extras a test may set on the debug and releaseTest builds. Only called when
 * BuildConfig.TEST_OVERRIDES is true, so R8 drops it (and its strings) from a release build; CI checks.
 */
internal object TestOverrides {
    class Values(val baseUrl: String?, val diagnostics: Boolean, val testName: String)

    fun read(intent: Intent?): Values {
        val extras = intent?.extras ?: return Values(null, false, "")
        return Values(
            baseUrl = extras.getString("openbot.base_url")?.takeIf { it.isNotBlank() },
            diagnostics = extras.getString("openbot.diagnostics") == "1",
            testName = extras.getString("openbot.test_name") ?: "",
        )
    }
}
