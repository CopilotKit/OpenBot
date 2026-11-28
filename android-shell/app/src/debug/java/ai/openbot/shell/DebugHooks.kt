package ai.openbot.shell

import android.content.Intent
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate

/**
 * DEBUG BUILDS ONLY (src/debug). The test hooks, read from intent extras the instrumented tests
 * send. The release and releaseTest builds compile src/release and src/releaseTest instead, where
 * every hook is off; CI fails if one of these extra names is in the release APK's dex.
 *
 * | Extra (all strings)              | Effect                                                         |
 * | openbot.plain_webview=1          | the bare full-screen WebView at the base URL (path kept)        |
 * | openbot.reset=1                  | clears cookies, storage and cache before anything loads         |
 * | openbot.test_session_cookie=V    | sets __Secure-better-auth.session_token=V for the https base    |
 * | openbot.stale_session=1          | sets better-auth.session_token=stale (a session the server lost)|
 * | openbot.handoff_auto=1           | adds &auto=1 to the hand-off URL                                |
 * | openbot.force_offline=1          | the offline lock, for good                                      |
 * | openbot.force_offline_seconds=N  | the offline lock for N seconds, then the real network           |
 * | openbot.force_dark=1             | the whole app, WebView included, in dark mode                   |
 * | openbot.debug_tab_url=URL        | Sign in opens URL in a Custom Tab instead                       |
 * | openbot.delay_first_load_ms=N    | the first page load starts N ms late (to see the skeleton)      |
 *
 * Also draws an invisible "debug-state" label with the shell's state for the tests.
 */
object DebugHooks {
    fun read(intent: Intent?): HookValues {
        val extras = intent?.extras ?: return HookValues()
        fun flag(key: String) = extras.getString(key) == "1"
        return HookValues(
            plainWebView = flag("openbot.plain_webview"),
            reset = flag("openbot.reset"),
            sessionCookie = extras.getString("openbot.test_session_cookie")?.takeIf { it.isNotEmpty() },
            staleSession = flag("openbot.stale_session"),
            handoffAuto = flag("openbot.handoff_auto"),
            forceOffline = flag("openbot.force_offline"),
            forceOfflineSeconds = extras.getString("openbot.force_offline_seconds")?.toLongOrNull()?.takeIf { it > 0 },
            forceDark = flag("openbot.force_dark"),
            customTabUrl = extras.getString("openbot.debug_tab_url")
                ?.takeIf { it.startsWith("https://") || it.startsWith("http://") },
            delayFirstLoadMs = extras.getString("openbot.delay_first_load_ms")?.toLongOrNull()?.coerceIn(0, 10_000) ?: 0L,
        )
    }

    fun beforeCreate(activity: AppCompatActivity, hooks: HookValues) {
        if (hooks.forceDark) activity.delegate.localNightMode = AppCompatDelegate.MODE_NIGHT_YES
    }

    fun stateLabel(root: FrameLayout): ((String) -> Unit)? {
        val label = TextView(root.context).apply {
            textSize = 1f
            setTextColor(Color.TRANSPARENT)
            isClickable = false
            isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        root.addView(label, FrameLayout.LayoutParams(4, 4, Gravity.TOP or Gravity.START))
        return { state ->
            label.contentDescription = "debug-state $state"
            label.bringToFront()
        }
    }
}
