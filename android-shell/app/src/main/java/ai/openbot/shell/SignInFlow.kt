package ai.openbot.shell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * The two native parts of signing in: asking the server whether it has the hand-off, and the
 * Custom Tab (the browser's own sign-ins, like iOS's system sheet). ShellController decides what to
 * do with the answers. Tickets and verifiers are never logged.
 */
class SignInFlow(private val diagnostics: Diagnostics) {
    private val executor = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    /**
     * GET `<base>/api/auth/shell/config?platform=android`: no cookies (HttpURLConnection has no
     * cookie handler here, and the WebView's store is separate), no redirects followed, 15 s.
     */
    fun fetchConfig(config: ShellConfig, httpsCallbackSupported: Boolean, done: (HandoffMode) -> Unit) {
        val url = config.url("/api/auth/shell/config?platform=android")
        var answered = false
        fun finish(mode: HandoffMode, status: Int, error: String?) {
            main.post {
                if (answered) return@post
                answered = true
                val entry = mutableMapOf<String, Any?>("status" to status, "mode" to HandoffConfig.describe(mode))
                if (error != null) entry["error"] = error
                diagnostics.log("handoff-config", entry)
                done(mode)
            }
        }
        main.postDelayed({ finish(HandoffMode.Unreachable("timeout"), -1, "timeout") }, TIMEOUT_MS + 2_000)
        executor.execute {
            try {
                val (status, body) = get(url, readBody = true)
                finish(HandoffConfig.decide(status, body, config.baseHost, httpsCallbackSupported), status, null)
            } catch (error: IOException) {
                finish(HandoffConfig.decide(null, null, config.baseHost, httpsCallbackSupported), -1, error.javaClass.simpleName)
            } catch (error: RuntimeException) {
                finish(HandoffConfig.decide(null, null, config.baseHost, httpsCallbackSupported), -1, error.javaClass.simpleName)
            }
        }
    }

    /** Whether the server answers at all (any HTTP status), for retrying after a failure. */
    fun ping(config: ShellConfig, done: (answered: Boolean) -> Unit) {
        executor.execute {
            val answered = try {
                get(config.origin + "/", readBody = false).first > 0
            } catch (error: IOException) {
                false
            } catch (error: RuntimeException) {
                false
            }
            main.post { done(answered) }
        }
    }

    private fun get(url: String, readBody: Boolean, timeoutMs: Long = TIMEOUT_MS): Pair<Int, String?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = timeoutMs.toInt()
            connection.readTimeout = timeoutMs.toInt()
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            var body: String? = null
            if (readBody) {
                val stream = if (status in 200..399) connection.inputStream else connection.errorStream
                body = stream?.use { String(it.readBytes(), Charsets.UTF_8).take(65_536) }
            }
            return status to body
        } finally {
            connection.disconnect()
        }
    }

    /** Checks a self-hosted address (ServerCheck): 10 s, no cookies, no redirect followed. */
    fun checkServer(origin: String, done: (ServerCheck.Outcome, String) -> Unit) {
        var answered = false
        fun finish(outcome: ServerCheck.Outcome, detail: String) {
            main.post {
                if (answered) return@post
                answered = true
                diagnostics.log("server-check", mapOf("outcome" to outcome.name, "detail" to detail))
                done(outcome, detail)
            }
        }
        main.postDelayed({ finish(ServerCheck.Outcome.NO_ANSWER, "timeout") }, CHECK_TIMEOUT_MS + 2_000)
        executor.execute {
            try {
                val (status, body) = get("$origin/api/auth/shell/config?platform=android", readBody = true, timeoutMs = CHECK_TIMEOUT_MS)
                finish(ServerCheck.fromAnswer(status, body), "status $status")
            } catch (error: Exception) {
                finish(ServerCheck.fromFailure(ServerCheck.failureOf(error)), error.javaClass.simpleName)
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
        main.removeCallbacksAndMessages(null)
    }

    companion object {
        const val TIMEOUT_MS = 15_000L
        const val CHECK_TIMEOUT_MS = 10_000L
    }
}

/** Custom Tabs: the browser's own tab over the app, sharing the browser's sign-ins. */
object CustomTabs {
    /** Opens `url` in a Custom Tab. False when no browser can show one. */
    fun open(activity: Activity, url: Uri, purpose: String, diagnostics: Diagnostics): Boolean {
        val browser = CustomTabsClient.getPackageName(activity, null)
        val tab = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(false)
            .build()
        if (browser != null) tab.intent.setPackage(browser)
        diagnostics.log("custom-tab", mapOf("result" to "opening", "purpose" to purpose, "url" to Diagnostics.redact(url.toString()), "browser" to browser))
        return try {
            tab.launchUrl(activity, url)
            true
        } catch (error: ActivityNotFoundException) {
            diagnostics.log("custom-tab", mapOf("result" to "no-browser"))
            false
        }
    }
}
