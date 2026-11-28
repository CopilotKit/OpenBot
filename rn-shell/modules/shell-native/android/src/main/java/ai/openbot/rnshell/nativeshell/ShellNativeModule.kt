package ai.openbot.rnshell.nativeshell

import android.content.Context
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.WebStorage
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What the shell needs from Android that React Native and react-native-webview do not give:
 * the WebView's cookie store (CookieManager; names only, a value never leaves this file), clearing a
 * site's cookies and storage on sign-out, flushing cookies when the app pauses, hiding the keyboard,
 * the launch intent's extras (read by the JavaScript of a test build only), and whether the App Link
 * for the https callback is verified (API 31+).
 */
class ShellNativeModule : Module() {
  private val sessionCookieNames = setOf("better-auth.session_token", "__Secure-better-auth.session_token")
  private val main = Handler(Looper.getMainLooper())

  private fun cookieNames(url: String): List<String> {
    val header = CookieManager.getInstance().getCookie(url) ?: return emptyList()
    return header.split(";").mapNotNull { pair ->
      val name = pair.substringBefore("=").trim()
      val value = pair.substringAfter("=", "").trim()
      if (name.isEmpty() || value.isEmpty()) null else name
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ShellNative")

    Function("launchArguments") {
      val result = mutableMapOf<String, String>()
      val extras = appContext.currentActivity?.intent?.extras ?: return@Function result
      for (key in extras.keySet()) {
        @Suppress("DEPRECATION")
        val value = extras.get(key) ?: continue
        if (value is String || value is Boolean || value is Number) result[key] = value.toString()
      }
      result
    }

    Function("httpsCallbackSupported") { host: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
      try {
        val context = appContext.reactContext ?: return@Function false
        val manager = context.getSystemService(DomainVerificationManager::class.java) ?: return@Function false
        val state = manager.getDomainVerificationUserState(context.packageName) ?: return@Function false
        state.hostToStateMap[host] == DomainVerificationUserState.DOMAIN_STATE_VERIFIED
      } catch (error: Exception) {
        false
      }
    }

    AsyncFunction("hasSessionCookie") { url: String, promise: Promise ->
      main.post { promise.resolve(cookieNames(url).any { it in sessionCookieNames }) }
    }

    AsyncFunction("setCookie") { url: String, name: String, value: String, secure: Boolean, promise: Promise ->
      main.post {
        val attributes = StringBuilder("$name=$value; Path=/; Max-Age=604800; HttpOnly")
        if (secure) attributes.append("; Secure")
        CookieManager.getInstance().setCookie(url, attributes.toString()) { ok ->
          CookieManager.getInstance().flush()
          promise.resolve(ok)
        }
      }
    }

    /** Sign-out: the origin's cookies (each expired by name) and its storage go. */
    AsyncFunction("clearSiteData") { url: String, promise: Promise ->
      main.post {
        val manager = CookieManager.getInstance()
        val names = cookieNames(url)
        val uri = Uri.parse(url)
        val secure = uri.scheme == "https"
        for (name in names) {
          // Host-only and domain cookies alike: expire on the host, then on its parent domain.
          manager.setCookie(url, "$name=; Path=/; Max-Age=0" + if (secure) "; Secure" else "")
          uri.host?.let { host ->
            val dot = host.indexOf('.')
            if (dot > 0 && host.indexOf('.', dot + 1) > 0) {
              manager.setCookie(url, "$name=; Path=/; Domain=${host.substring(dot + 1)}; Max-Age=0" + if (secure) "; Secure" else "")
            }
          }
        }
        manager.flush()
        val origin = "${uri.scheme}://${uri.authority}"
        WebStorage.getInstance().deleteOrigin(origin)
        // The HTTP cache is the app's, not one web view's: a throwaway WebView clears it.
        appContext.reactContext?.let { context ->
          try {
            android.webkit.WebView(context).apply {
              clearCache(true)
              destroy()
            }
          } catch (error: Exception) {
            // No WebView to make (being updated): the cache stays until the next sign-out.
          }
        }
        promise.resolve(names.size)
      }
    }

    AsyncFunction("clearAllData") { promise: Promise ->
      main.post {
        CookieManager.getInstance().removeAllCookies {
          WebStorage.getInstance().deleteAllData()
          CookieManager.getInstance().flush()
          promise.resolve(null)
        }
      }
    }

    Function("setSignInPending") { pending: Boolean ->
      SignInCallbackActivity.pending = pending
      true
    }

    Function("flushCookies") {
      main.post { CookieManager.getInstance().flush() }
      true
    }

    Function("dismissKeyboard") {
      main.post {
        val activity = appContext.currentActivity ?: return@post
        val view = activity.currentFocus ?: activity.window?.decorView ?: return@post
        val manager = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        manager?.hideSoftInputFromWindow(view.windowToken, 0)
      }
    }
  }
}
