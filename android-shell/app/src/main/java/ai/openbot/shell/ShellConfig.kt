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
    val delayFirstLoadMs: Long = 0L,
    val softwareLayer: Boolean = false,
    val startSignedOut: Boolean = false,
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

    /** Same scheme, host and effective port as the base URL (Origins.same). */
    fun isOwnOrigin(uri: Uri?): Boolean = uri != null && isOwnOrigin(uri.toString())

    fun isOwnOrigin(url: String?): Boolean = Origins.same(url, origin)

    companion object {
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

        /**
         * The override when it is an http(s) URL with a host, else BuildConfig.BASE_URL; origin only,
         * spelled as `location.origin` spells it (lower case, default port left out), because the
         * marker script and the bridge's origin rule compare against that spelling.
         */
        fun resolveBase(candidate: String?): Uri {
            for (value in listOfNotNull(candidate, BuildConfig.BASE_URL)) {
                val origin = Origins.of(value) ?: continue
                return Uri.parse(origin.toString())
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
