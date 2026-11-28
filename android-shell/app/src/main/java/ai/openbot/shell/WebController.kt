package ai.openbot.shell

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Owns the one WebView: its settings, the page bridge, navigation policy, the load watchdog, and
 * recreating it when its renderer dies.
 */
class WebController(
    private val activity: ShellActivity,
    private val config: ShellConfig,
    private val diagnostics: Diagnostics,
    private val container: FrameLayout,
) {
    /** What the WebView tells the rest of the shell. */
    interface Delegate {
        /** A message the page posted to `OpenBotShellAndroid`, from the main frame on the base origin. */
        fun onBridgeMessage(message: JSONObject)

        /** A main-frame navigation to `<base>/api/auth/hosted/sign-in`. True cancels it. */
        fun shouldInterceptHostedSignIn(url: Uri): Boolean

        /** Whether a tapped link may take the WebView to another site (the web sign-in fallback). */
        fun allowsLeavingOrigin(): Boolean

        /** A main-frame load failed, answered 5xx, or never answered. */
        fun onLoadFailed(detail: String)

        /** A main-frame load committed and painted (onPageCommitVisible). */
        fun onCommit()

        /** A main-frame load finished. */
        fun onFinished()

        /** The WebView's URL changed, by a load or by the page's own router (pushState). */
        fun onUrlChanged(url: String?)

        /** A full page load (or reload) starts: the page has not rendered yet. */
        fun onFullLoad()
    }

    var delegate: Delegate? = null
    lateinit var webView: WebView
        private set

    private val main = Handler(Looper.getMainLooper())

    /** The page said `ready` since the last main-frame navigation started. */
    var pageReady = false
        private set

    /** The last main-frame load failed (so the shell reloads when the connection comes back). */
    var lastLoadFailed = false
        private set
    private var lastRequestedUrl: String? = null
    private var allowHostedOnce: String? = null
    private var currentNavigationFailed = false
    private var currentNavigationCommitted = false
    private var watchdogArmed = false
    private val watchdog = Runnable {
        watchdogArmed = false
        diagnostics.log("load-watchdog", mapOf("url" to Diagnostics.redact(lastRequestedUrl), "seconds" to WATCHDOG_MS / 1000))
        webView.stopLoading()
        lastLoadFailed = true
        currentNavigationFailed = true
        delegate?.onLoadFailed("watchdog")
    }

    val userAgent: String get() = webView.settings.userAgentString

    fun create() {
        val view = WebView(activity)
        view.id = R.id.openbot_webview
        configure(view)
        webView = view
        container.addView(view, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {
        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // window.open loads in this one WebView, where the navigation policy decides.
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.safeBrowsingEnabled = true
        settings.userAgentString = WebSettings.getDefaultUserAgent(activity) + " OpenBotShell-Android/" + config.version
        CookieManager.getInstance().setAcceptCookie(true)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // No white flash before the first paint in dark mode.
        view.setBackgroundColor(Color.TRANSPARENT)
        view.isVerticalScrollBarEnabled = false

        val ownOrigin = setOf(config.origin)
        // The page learns it is in the shell before its first script runs, on the base origin only.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, markerScript(), ownOrigin)
        } else {
            diagnostics.log("feature-missing", mapOf("feature" to "DOCUMENT_START_SCRIPT"))
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, BRIDGE_NAME, ownOrigin) { _, message, sourceOrigin, isMainFrame, _ ->
                onBridge(message.data, sourceOrigin, isMainFrame)
            }
            if (diagnostics.enabled) {
                WebViewCompat.addWebMessageListener(view, DIAGNOSTICS_NAME, setOf("*")) { _, message, _, isMainFrame, _ ->
                    diagnostics.logPage(message.data, isMainFrame)
                }
            }
        } else {
            diagnostics.log("feature-missing", mapOf("feature" to "WEB_MESSAGE_LISTENER"))
        }
        if (diagnostics.enabled && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, Diagnostics.pageScript, setOf("*"))
        }
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
    }

    private fun markerScript(): String = """
        (function () {
          if (location.origin !== ${jsString(config.origin)}) return;
          window.__OPENBOT_NATIVE_SHELL__ = Object.freeze({ platform: "android", version: ${jsString(config.version)}, bridge: 1 });
        })();
    """.trimIndent()

    // Loading ---------------------------------------------------------------------------------

    private var firstLoad = true

    /** Loads a page of the web app (or any URL) as a full page load. */
    fun load(url: String) {
        lastRequestedUrl = url
        lastLoadFailed = false
        diagnostics.log("load", mapOf("url" to Diagnostics.redact(url)))
        delegate?.onFullLoad()
        val delay = if (firstLoad) config.hooks.delayFirstLoadMs else 0L
        firstLoad = false
        if (delay > 0) {
            // Debug hook: a slow first answer, so the tests can see the loading skeleton.
            diagnostics.log("test-hook", mapOf("hook" to "delay-first-load", "ms" to delay))
            main.postDelayed({
                armWatchdog()
                webView.loadUrl(url)
            }, delay)
            return
        }
        armWatchdog()
        webView.loadUrl(url)
    }

    fun retry() {
        diagnostics.log("retry", mapOf("url" to Diagnostics.redact(lastRequestedUrl)))
        val current = webView.url
        if (current == null || lastLoadFailed || current == "about:blank") {
            load(lastRequestedUrl ?: config.origin + "/")
        } else {
            delegate?.onFullLoad()
            lastLoadFailed = false
            armWatchdog()
            webView.reload()
        }
    }

    fun stop() {
        disarmWatchdog()
        webView.stopLoading()
    }

    /** The pathname the page is on, for coming back to it after a sign-in renewal. */
    val currentPath: String
        get() {
            val url = webView.url
            if (!config.isOwnOrigin(url)) return "/"
            val path = Uri.parse(url).path?.ifEmpty { "/" } ?: "/"
            return if (path.startsWith("/api/")) "/" else path
        }

    /** Lets one hosted sign-in navigation through (the server has no hand-off) and loads it. */
    fun loadHostedSignInAfterAll(url: Uri) {
        allowHostedOnce = url.toString()
        load(url.toString())
    }

    /** Clears the WebView's whole data store (the debug reset hook). */
    fun clearAllData(done: () -> Unit) {
        CookieManager.getInstance().removeAllCookies {
            WebStorage.getInstance().deleteAllData()
            webView.clearCache(true)
            webView.clearHistory()
            CookieManager.getInstance().flush()
            done()
        }
    }

    /** Reads the page's background colour and whether it is dark. */
    fun readChrome(done: (color: Int?, dark: Boolean?, css: String) -> Unit) {
        val script = """
            (function () {
              var b = document.body, h = document.documentElement;
              if (!b || !h) return null;
              var css = getComputedStyle(b).backgroundColor;
              if (!css || css === "transparent" || css === "rgba(0, 0, 0, 0)") css = getComputedStyle(h).backgroundColor;
              var canvas = document.createElement("canvas");
              canvas.width = 1; canvas.height = 1;
              var x = canvas.getContext("2d");
              x.fillStyle = "rgba(0,0,0,0)";
              x.fillStyle = css;
              x.fillRect(0, 0, 1, 1);
              var d = x.getImageData(0, 0, 1, 1).data;
              return JSON.stringify({ css: String(css), r: d[0], g: d[1], b: d[2], a: d[3], dark: h.classList.contains("dark") });
            })()
        """.trimIndent()
        webView.evaluateJavascript(script) { result ->
            val json = decodeJsString(result)
            if (json == null) {
                done(null, null, "")
                return@evaluateJavascript
            }
            val dark = if (json.has("dark")) json.optBoolean("dark") else null
            val css = json.optString("css")
            val alpha = json.optInt("a", 0)
            if (alpha <= 0) {
                done(null, dark, css)
                return@evaluateJavascript
            }
            // Opaque: the strip behind the status bar must not let anything show through.
            done(Color.rgb(json.optInt("r"), json.optInt("g"), json.optInt("b")), dark, css)
        }
    }

    /** Evaluates `script` (which returns a JSON string) and parses the answer. */
    fun evaluateJson(script: String, done: (JSONObject?) -> Unit) {
        webView.evaluateJavascript(script) { result -> done(decodeJsString(result)) }
    }

    // Renderer -------------------------------------------------------------------------------------

    private fun recreate() {
        val old = webView
        container.removeView(old)
        old.destroy()
        pageReady = false
        create()
        activity.onWebViewRecreated()
        load(lastRequestedUrl ?: config.origin + "/")
    }

    fun destroy() {
        disarmWatchdog()
        main.removeCallbacksAndMessages(null)
        container.removeView(webView)
        webView.destroy()
    }

    // Watchdog ---------------------------------------------------------------------------------

    private fun armWatchdog() {
        main.removeCallbacks(watchdog)
        watchdogArmed = true
        main.postDelayed(watchdog, WATCHDOG_MS)
    }

    private fun disarmWatchdog() {
        watchdogArmed = false
        main.removeCallbacks(watchdog)
    }

    // The page bridge --------------------------------------------------------------------------------

    private fun onBridge(data: String?, sourceOrigin: Uri, isMainFrame: Boolean) {
        if (!isMainFrame || !config.isOwnOrigin(sourceOrigin)) {
            diagnostics.log("bridge-rejected", mapOf("mainFrame" to isMainFrame, "origin" to sourceOrigin.toString()))
            return
        }
        val message = try {
            JSONObject(data ?: "")
        } catch (error: JSONException) {
            diagnostics.log("bridge-rejected", mapOf("reason" to "not-json"))
            return
        }
        val type = message.optString("type")
        val entry = mutableMapOf<String, Any?>("type" to type)
        if (message.has("path")) entry["path"] = message.optString("path")
        if (message.has("tab")) entry["tab"] = if (message.isNull("tab")) null else message.optString("tab")
        if (message.has("signedIn")) entry["signedIn"] = message.optBoolean("signedIn")
        diagnostics.log("bridge", entry)
        if (type == "ready") pageReady = true
        delegate?.onBridgeMessage(message)
    }

    // Navigation policy -----------------------------------------------------------------------------

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: ""
        val intent: Intent
        if (scheme == "intent") {
            val parsed = try {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
            } catch (error: java.net.URISyntaxException) {
                diagnostics.log("open-external", mapOf("scheme" to scheme, "result" to "unparseable"))
                return
            }
            // Only what a browser would do: no explicit component, no selector, browsable only.
            parsed.component = null
            parsed.selector = null
            parsed.flags = 0
            parsed.addCategory(Intent.CATEGORY_BROWSABLE)
            intent = parsed
        } else {
            intent = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            activity.startActivity(intent)
            diagnostics.log("open-external", mapOf("scheme" to scheme, "result" to "opened"))
        } catch (error: ActivityNotFoundException) {
            val fallback = intent.getStringExtra("browser_fallback_url")
            val fallbackUri = fallback?.let { Uri.parse(it) }
            if (fallbackUri != null && (fallbackUri.scheme == "https" || fallbackUri.scheme == "http")) {
                activity.openInCustomTab(fallbackUri, "intent-fallback")
            }
            diagnostics.log("open-external", mapOf("scheme" to scheme, "result" to "no-app", "fallback" to (fallbackUri != null)))
        } catch (error: SecurityException) {
            diagnostics.log("open-external", mapOf("scheme" to scheme, "result" to "refused"))
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val scheme = uri.scheme?.lowercase() ?: ""
            val mainFrame = request.isForMainFrame
            diagnostics.log("navigation-action", mapOf(
                "url" to Diagnostics.redact(uri.toString()),
                "mainFrame" to mainFrame,
                "gesture" to request.hasGesture(),
                "redirect" to request.isRedirect,
            ))
            // The sign-in callback is only ever taken from the Custom Tab the app started.
            if (scheme == "openbotshell") {
                diagnostics.log("callback-scheme-refused")
                return true
            }
            if (scheme == "http" || scheme == "https") {
                if (mainFrame && config.isOwnOrigin(uri) && uri.path == "/api/auth/hosted/sign-in") {
                    if (allowHostedOnce == uri.toString()) {
                        allowHostedOnce = null
                    } else if (delegate?.shouldInterceptHostedSignIn(uri) == true) {
                        diagnostics.log("hosted-sign-in-intercepted")
                        return true
                    }
                }
                if (mainFrame && !config.isOwnOrigin(uri) && request.hasGesture() && delegate?.allowsLeavingOrigin() != true) {
                    diagnostics.log("open-in-custom-tab", mapOf("url" to Diagnostics.redact(uri.toString())))
                    activity.openInCustomTab(uri, "link")
                    return true
                }
                return false
            }
            if (scheme in setOf("about", "data", "blob", "javascript")) return false
            // mailto:, tel:, intent: and app links go to the system, and only from a tap.
            if (request.hasGesture()) openExternal(uri) else diagnostics.log("open-external", mapOf("scheme" to scheme, "result" to "no-gesture"))
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            pageReady = false
            currentNavigationFailed = false
            currentNavigationCommitted = false
            if (url != null && url != "about:blank") lastRequestedUrl = url
            diagnostics.log("main-frame-start", mapOf("url" to Diagnostics.redact(url)))
            armWatchdog()
            delegate?.onUrlChanged(url)
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            disarmWatchdog()
            // Chromium commits its own error page after a failed load: that is not a page of ours.
            if (currentNavigationFailed) {
                diagnostics.log("error-page-commit", mapOf("url" to Diagnostics.redact(url)))
                return
            }
            committed(url, "commit-visible")
        }

        override fun onPageFinished(view: WebView, url: String?) {
            disarmWatchdog()
            diagnostics.log("did-finish", mapOf("url" to Diagnostics.redact(url)))
            if (currentNavigationFailed) return
            // onPageCommitVisible may not come for a WebView that is not drawn: finishing counts.
            if (!currentNavigationCommitted) committed(url, "finished")
            delegate?.onFinished()
            if (diagnostics.enabled) {
                takeSnapshot("didFinish")
                main.postDelayed({ takeSnapshot("didFinish+5s") }, 5_000)
            }
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            delegate?.onUrlChanged(url)
            activity.onBackStateChanged()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            diagnostics.log("navigation-error", mapOf(
                "mainFrame" to request.isForMainFrame,
                "code" to error.errorCode,
                "description" to error.description?.toString(),
                "url" to Diagnostics.redact(request.url.toString()),
            ))
            if (!request.isForMainFrame) return
            failMainFrame("error ${error.errorCode}")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            val status = errorResponse.statusCode
            if (request.isForMainFrame) {
                // Header names a bot check sets (Cloudflare), and the challenge marker's value only.
                val headers = errorResponse.responseHeaders?.mapKeys { it.key.lowercase() } ?: emptyMap()
                diagnostics.log("navigation-response", mapOf(
                    "url" to Diagnostics.redact(request.url.toString()),
                    "mainFrame" to true,
                    "status" to status,
                    "server" to headers["server"],
                    "cfMitigated" to headers["cf-mitigated"],
                    "cfRay" to headers.containsKey("cf-ray"),
                    "setCookieNames" to (headers["set-cookie"]?.split(",")?.map { it.substringBefore("=").trim() } ?: emptyList<String>()),
                ))
            }
            if (request.isForMainFrame && status >= 500) failMainFrame("http $status")
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // Never proceed past a certificate error.
            handler.cancel()
            diagnostics.log("ssl-error", mapOf("primaryError" to error.primaryError, "url" to Diagnostics.redact(error.url)))
            val loading = lastRequestedUrl
            if (loading != null && Uri.parse(loading).host == Uri.parse(error.url).host) failMainFrame("ssl ${error.primaryError}")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            diagnostics.log("render-process-gone", mapOf("didCrash" to detail.didCrash()))
            main.post { recreate() }
            return true
        }
    }

    private fun committed(url: String?, how: String) {
        if (currentNavigationCommitted || url == null || url == "about:blank") return
        currentNavigationCommitted = true
        lastLoadFailed = false
        diagnostics.log("main-frame-commit", mapOf("url" to Diagnostics.redact(url), "how" to how))
        delegate?.onCommit()
    }

    private fun failMainFrame(detail: String) {
        disarmWatchdog()
        currentNavigationFailed = true
        lastLoadFailed = true
        delegate?.onLoadFailed(detail)
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean {
            diagnostics.log("file-chooser", mapOf("acceptTypes" to fileChooserParams.acceptTypes.toList(), "multiple" to (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE)))
            return activity.showFileChooser(filePathCallback, fileChooserParams)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            val origin = request.origin
            val allowed = setOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE)
            val asked = request.resources.toList()
            val ok = config.isOwnOrigin(origin) && asked.isNotEmpty() && asked.all { it in allowed }
            diagnostics.log("media-permission", mapOf("origin" to origin.toString(), "resources" to asked, "ownOrigin" to ok))
            if (!ok) {
                request.deny()
                return
            }
            activity.requestMediaPermissions(asked) { granted ->
                if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
                diagnostics.log("media-permission-result", mapOf("granted" to granted))
            }
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean = false

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            diagnostics.log("js-alert")
            MaterialAlertDialogBuilder(activity)
                .setMessage(message)
                .setPositiveButton(R.string.dialog_ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            diagnostics.log("js-confirm")
            MaterialAlertDialogBuilder(activity)
                .setMessage(message)
                .setNegativeButton(R.string.dialog_cancel) { _, _ -> result.cancel() }
                .setPositiveButton(R.string.dialog_ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            diagnostics.log("js-prompt")
            val field = EditText(activity).apply { setText(defaultValue ?: "") }
            MaterialAlertDialogBuilder(activity)
                .setMessage(message)
                .setView(field)
                .setNegativeButton(R.string.dialog_cancel) { _, _ -> result.cancel() }
                .setPositiveButton(R.string.dialog_ok) { _, _ -> result.confirm(field.text.toString()) }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }
    }

    // Diagnostics ------------------------------------------------------------------------------------

    private fun takeSnapshot(reason: String) {
        val location = IntArray(2)
        webView.getLocationOnScreen(location)
        val native = mapOf("webViewTop" to location[1], "webViewHeight" to webView.height, "webViewWidth" to webView.width)
        evaluateJson(Diagnostics.snapshotScript) { page ->
            diagnostics.log("snapshot", mapOf("reason" to reason, "native" to native, "page" to page))
        }
        // Names only: CookieManager gives no attributes, and the values are dropped here.
        val names = SessionCookies.names(CookieManager.getInstance().getCookie(config.origin + "/"))
        diagnostics.log("cookie-store", mapOf("reason" to reason, "url" to config.origin, "names" to names))
    }

    companion object {
        const val BRIDGE_NAME = "OpenBotShellAndroid"
        const val DIAGNOSTICS_NAME = "OpenBotShellDiagnostics"

        /** WebView reports some blocked loads without a word: 20 s without a commit locks the app. */
        const val WATCHDOG_MS = 20_000L

        /** A Kotlin string as a JavaScript string literal. */
        fun jsString(value: String): String = JSONObject.quote(value)

        /** evaluateJavascript's answer for a script that returned a JSON string. */
        fun decodeJsString(result: String?): JSONObject? {
            if (result == null || result == "null" || result.isEmpty()) return null
            return try {
                val text = JSONTokener(result).nextValue() as? String ?: return null
                JSONObject(text)
            } catch (error: JSONException) {
                null
            }
        }
    }
}
