package ai.openbot.shell

import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.annotation.IdRes
import org.json.JSONObject

/** Where the app is. `PLAIN` is the debug probe mode: a bare full-screen WebView. */
enum class Phase(val label: String) {
    LAUNCHING("launching"), SIGNED_OUT("signedOut"), SIGNED_IN("signedIn"), PLAIN("plain")
}

/** The sign-in in progress while signed out. */
enum class SignInStep(val label: String) {
    IDLE("idle"),

    /** Asking the server whether it has the sign-in hand-off. */
    PROBING("probing"),

    /** The Custom Tab is up. */
    CUSTOM_TAB("customTab"),

    /** The WebView is loading the hand-off's enter URL; waiting for the page to say signed in. */
    ENTERING("entering"),

    /** No hand-off on this server: the web app's own sign-in, full screen in the WebView. */
    WEB_FALLBACK("webFallback"),
}

/** The bottom bar's tabs, left to right. */
enum class ShellTab(val key: String, val path: String, @param:IdRes val itemId: Int) {
    CONVERSATIONS("conversations", "/conversations", R.id.tab_conversations),
    HOME("home", "/", R.id.tab_home),
    BOTS("bots", "/bots", R.id.tab_bots);

    companion object {
        fun fromKey(key: String?): ShellTab? = entries.firstOrNull { it.key == key }
        fun fromItem(itemId: Int): ShellTab? = entries.firstOrNull { it.itemId == itemId }
    }
}

/**
 * Runs the app: decides signed in or not at launch, drives sign-in, routes tab taps to the page,
 * listens to the page, watches the network and the keyboard. ShellActivity draws the state.
 */
class ShellController(
    private val activity: ShellActivity,
    val config: ShellConfig,
    val diagnostics: Diagnostics,
    val web: WebController,
) : WebController.Delegate {
    private val main = Handler(Looper.getMainLooper())
    private val signInFlow = SignInFlow(diagnostics)
    private val network = NetworkMonitor(activity.applicationContext, diagnostics)
    private val hooks get() = config.hooks

    // The state ShellActivity draws. ------------------------------------------------------------

    var phase = Phase.LAUNCHING
        private set(value) {
            if (field == value) return
            diagnostics.log("state", mapOf("phase" to value.label, "from" to field.label))
            field = value
            changed()
        }
    var signIn = SignInStep.IDLE
        private set(value) {
            if (field == value) return
            diagnostics.log("sign-in-phase", mapOf("step" to value.label, "from" to field.label))
            field = value
            changed()
        }

    /** The short line above the Sign in button after a sign-in that did not finish. */
    var signInMessage: String? = null
        private set(value) {
            field = value
            changed()
        }
    var offline = false
        private set(value) {
            if (field == value) return
            diagnostics.log("offline", mapOf("offline" to value))
            field = value
            changed()
        }
    var selectedTab = ShellTab.HOME
        private set(value) {
            if (field == value) return
            diagnostics.log("tab-selected", mapOf("tab" to value.key))
            field = value
            changed()
        }

    /** The page's body background, painted behind the status bar and the bottom bar. */
    var pageBackground: Int? = null
        private set
    var pageIsDark: Boolean? = null
        private set
    var keyboardVisible = false
        private set
    var loadFailed = false
        private set(value) {
            if (field == value) return
            diagnostics.log("load-failed", mapOf("shown" to value))
            field = value
            changed()
        }

    /** How the last tab tap reached the page: "event" (openbot:open) or "load". */
    var lastNavigation = "none"
        private set
    var mainFrameCommits = 0
        private set

    /** The first segment of the page's path ("/", "/channel", "/sign"), for tests. */
    var webPathRoot = "-"
        private set

    /**
     * The web area has no rendered page yet: the loading skeleton covers it. This is the web area's
     * DEFAULT state: true from the start, true again whenever the web area comes into view and when a
     * full load starts, false only once the page has rendered. So no white WebView ever shows.
     */
    var pageLoading = true
        private set
    private var lastWebVisible = false
    private var loadingSince = 0L

    /** The sign-in screen; while entering, the web area (and its skeleton) shows instead. */
    val showsSignInScreen: Boolean
        get() = phase == Phase.LAUNCHING ||
            (phase == Phase.SIGNED_OUT && signIn != SignInStep.WEB_FALLBACK && signIn != SignInStep.ENTERING)

    val showsSkeleton: Boolean get() = pageLoading && webVisible && !showsLock && !showsSignInScreen

    val webVisible: Boolean
        get() = when (phase) {
            Phase.SIGNED_IN, Phase.PLAIN -> true
            Phase.SIGNED_OUT -> signIn == SignInStep.WEB_FALLBACK || signIn == SignInStep.ENTERING
            Phase.LAUNCHING -> false
        }

    val showsTabBar: Boolean get() = phase == Phase.SIGNED_IN && !keyboardVisible
    val showsWebSignInBar: Boolean get() = phase == Phase.SIGNED_OUT && signIn == SignInStep.WEB_FALLBACK

    /** The lock screen covers everything: no network, or the web app did not load. */
    val showsLock: Boolean get() = offline || loadFailed
    val lockReason: String get() = if (offline) "no-network" else if (loadFailed) "load-failed" else "none"

    /** Whether the system bars and the bottom bar are drawn for a dark page; null: follow the system. */
    val chromeIsDark: Boolean? get() = if (showsLock || showsSignInScreen) null else pageIsDark
    val chromeBackground: Int? get() = if (showsLock || showsSignInScreen) null else pageBackground

    val debugState: String
        get() = "phase=${phase.label} signIn=${signIn.label} tab=${selectedTab.key} nav=$lastNavigation " +
            "commits=$mainFrameCommits lock=$lockReason keyboard=${if (keyboardVisible) 1 else 0} " +
            "path=$webPathRoot dark=${pageIsDark?.let { if (it) "1" else "0" } ?: "-"} " +
            "skeleton=${if (showsSkeleton) 1 else 0}"

    private fun changed() {
        val visible = webVisible
        if (visible && !lastWebVisible && !pageLoading) {
            // The web area comes into view: covered until a page renders in it.
            pageLoading = true
            loadingSince = System.currentTimeMillis()
            main.removeCallbacks(hideSkeleton)
            diagnostics.log("skeleton", mapOf("shown" to true, "reason" to "web-area-shown"))
            // A page already up (no load coming) ends it at once; a load in flight ends it itself.
            if (web.pageReady) {
                main.postDelayed({ pageShown("already-ready", 200) }, 50)
            } else if (web.webView.progress >= 100) {
                // Nothing loading and no bridge: as after a finish without ready (a load starting
                // right after this cancels it in onFullLoad).
                main.removeCallbacks(checkContent)
                main.postDelayed(checkContent, NO_READY_MS)
            }
        }
        lastWebVisible = visible
        activity.render()
    }

    // Sign-in bookkeeping. ------------------------------------------------------------------------

    /** What the server's hand-off config last said, or null (not asked yet). */
    private var handoffMode: HandoffMode? = null
    private val handoffSupported: Boolean?
        get() = when (handoffMode) {
            null -> null
            is HandoffMode.Scheme, is HandoffMode.Https -> true
            else -> false
        }

    /** A renewal (hosted sign-in intercepted while signed in) is running. */
    private var renewing = false

    /** A Custom Tab this app opened has not come back yet. */
    private var tabOpen = false
    private var callbackArrived = false
    private var debugTab = false
    private val enterTimeout = Runnable {
        diagnostics.log("enter-timeout", mapOf("seconds" to SignInFlow.TIMEOUT_MS / 1000))
        failSignIn(activity.getString(R.string.sign_in_too_long))
    }

    private enum class FailureSource { WEB, SIGN_IN }

    private var failureSource: FailureSource? = null
    private val autoRetry = Runnable { retryNow(automatic = true) }
    private var retryCount = 0

    // Launch. --------------------------------------------------------------------------------------

    fun start(restorePath: String?) {
        diagnostics.log("launch", mapOf(
            "baseURL" to Diagnostics.redact(config.origin),
            "version" to config.version,
            "sdk" to Build.VERSION.SDK_INT,
            "release" to Build.VERSION.RELEASE,
            "device" to Build.MODEL,
            "plain" to hooks.plainWebView,
            "userAgent" to web.userAgent,
            "webViewPackage" to activity.webViewPackageDescription(),
        ))
        network.onChange = { networkChanged(it) }
        network.start(hooks.forceOffline, hooks.forceOfflineSeconds)
        if (hooks.plainWebView) {
            phase = Phase.PLAIN
            web.load(config.startUrl ?: (config.origin + "/"))
            return
        }
        prepareDataStore { decideLaunchState(restorePath) }
    }

    fun stop() {
        network.stop()
        signInFlow.shutdown()
        main.removeCallbacksAndMessages(null)
    }

    /** Debug hooks that change the cookie store before anything looks at it. */
    private fun prepareDataStore(done: () -> Unit) {
        val steps = mutableListOf<(() -> Unit) -> Unit>()
        if (hooks.reset) {
            steps.add { next ->
                web.clearAllData {
                    diagnostics.log("test-hook", mapOf("hook" to "reset"))
                    next()
                }
            }
        }
        hooks.sessionCookie?.let { value ->
            steps.add { next ->
                SessionCookies.set(config, SessionCookies.SECURE_NAME, value, secure = true) { ok ->
                    diagnostics.log("test-hook", mapOf("hook" to "session-cookie", "ok" to ok))
                    next()
                }
            }
        }
        if (hooks.staleSession) {
            steps.add { next ->
                SessionCookies.set(config, SessionCookies.PLAIN_NAME, "stale", secure = false) { ok ->
                    diagnostics.log("test-hook", mapOf("hook" to "stale-session", "ok" to ok))
                    next()
                }
            }
        }
        fun run(index: Int) {
            if (index >= steps.size) {
                // At once when there is nothing to prepare: the first frame is already the tabs.
                if (index == 0) done() else main.post { done() }
                return
            }
            steps[index] { main.post { run(index + 1) } }
        }
        run(0)
    }

    /** Signed in when the session cookie is in the WebView's store (CookieManager answers at once). */
    private fun decideLaunchState(restorePath: String?) {
        val present = SessionCookies.present(config)
        diagnostics.log("session-cookie", mapOf("present" to present))
        if (present) launchSignedIn(restorePath ?: "/") else phase = Phase.SIGNED_OUT
    }

    private fun launchSignedIn(path: String) {
        phase = Phase.SIGNED_IN
        web.loadPath(path)
    }

    // Sign in. -------------------------------------------------------------------------------------

    /** Android hands the https callback to this app only when the App Link is verified (API 31+ can tell). */
    private fun httpsCallbackSupported(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        return try {
            val manager = activity.getSystemService(DomainVerificationManager::class.java) ?: return false
            val state = manager.getDomainVerificationUserState(activity.packageName) ?: return false
            state.hostToStateMap[config.baseHost] == DomainVerificationUserState.DOMAIN_STATE_VERIFIED
        } catch (error: Exception) {
            false
        }
    }

    /** The native Sign in button. */
    fun signIn() {
        if (phase != Phase.SIGNED_OUT || signIn != SignInStep.IDLE || showsLock) return
        signInMessage = null
        val debugUrl = hooks.customTabUrl
        if (debugUrl != null) {
            // A test opens an arbitrary page in the Custom Tab to see what happens there.
            debugTab = true
            tabOpen = true
            callbackArrived = false
            signIn = SignInStep.CUSTOM_TAB
            if (!activity.openInCustomTab(Uri.parse(debugUrl), "debug")) {
                tabOpen = false
                signIn = SignInStep.IDLE
            }
            return
        }
        val pair = PkcePair.make()
        signIn = SignInStep.PROBING
        signInFlow.fetchConfig(config, httpsCallbackSupported()) { mode ->
            if (signIn != SignInStep.PROBING) return@fetchConfig
            when (mode) {
                is HandoffMode.Unreachable -> {
                    // No answer at all: the lock screen, not the web sign-in.
                    signIn = SignInStep.IDLE
                    showLoadFailure(FailureSource.SIGN_IN, "handoff-config-no-answer")
                }
                is HandoffMode.WebSignIn -> {
                    handoffMode = mode
                    startWebSignIn()
                }
                else -> {
                    handoffMode = mode
                    presentTab(pair, mode, "/")
                }
            }
        }
    }

    /** The web sign-in fallback's Cancel. */
    fun cancelWebSignIn() {
        if (signIn != SignInStep.WEB_FALLBACK) return
        web.stop()
        clearLoadFailure()
        signIn = SignInStep.IDLE
    }

    private fun handoffUrl(challenge: String): String {
        var query = "challenge=$challenge&platform=android"
        if (hooks.handoffAuto) query += "&auto=1"
        return config.url("/api/auth/shell/handoff?$query")
    }

    private fun enterUrl(ticket: String, verifier: String, to: String): String =
        Uri.parse(config.url("/api/auth/shell/enter")).buildUpon()
            .appendQueryParameter("ticket", ticket)
            .appendQueryParameter("verifier", verifier)
            .appendQueryParameter("to", to)
            .build().toString()

    private fun presentTab(pair: PkcePair, mode: HandoffMode, returnTo: String) {
        if (!renewing) signIn = SignInStep.CUSTOM_TAB
        PendingSignIn.begin(pair, mode, returnTo)
        tabOpen = true
        callbackArrived = false
        debugTab = false
        if (!activity.openInCustomTab(Uri.parse(handoffUrl(pair.challenge)), if (renewing) "renewal" else "sign-in")) {
            // No browser can show a Custom Tab: the web sign-in.
            tabOpen = false
            PendingSignIn.clear()
            if (renewing) {
                renewing = false
            } else {
                signIn = SignInStep.IDLE
                startWebSignIn()
            }
        }
    }

    /** ShellActivity is in front again. Back from the Custom Tab with no callback: cancelled. */
    fun onResume() {
        if (!tabOpen || callbackArrived) return
        main.postDelayed({
            if (!tabOpen || callbackArrived) return@postDelayed
            tabOpen = false
            PendingSignIn.clear()
            diagnostics.log("custom-tab", mapOf("result" to "closed-without-callback", "debug" to debugTab))
            if (renewing) {
                renewing = false
            } else if (signIn == SignInStep.CUSTOM_TAB) {
                signIn = SignInStep.IDLE
            }
        }, 600)
    }

    /** The trampoline passed on a callback URL (only while a sign-in was pending). */
    fun handleCallback(uri: Uri?) {
        val pair = PendingSignIn.pair
        val mode = PendingSignIn.mode
        diagnostics.log("callback", mapOf("scheme" to uri?.scheme, "host" to uri?.host, "pending" to PendingSignIn.isWaiting(), "tabOpen" to tabOpen))
        if (pair == null || mode == null || !PendingSignIn.isWaiting()) {
            diagnostics.log("callback-ignored", mapOf("reason" to "no-pending-sign-in"))
            return
        }
        val ticket = HandoffConfig.ticket(uri?.toString(), mode)
        val returnTo = PendingSignIn.returnTo
        callbackArrived = true
        tabOpen = false
        PendingSignIn.clear()
        if (ticket == null) {
            diagnostics.log("callback-ignored", mapOf("reason" to "no-ticket-or-wrong-callback"))
            if (renewing) {
                renewing = false
            } else {
                signIn = SignInStep.IDLE
                signInMessage = activity.getString(R.string.sign_in_not_finished)
            }
            return
        }
        enter(ticket, pair.verifier, returnTo)
    }

    private fun enter(ticket: String, verifier: String, to: String) {
        if (!renewing) signIn = SignInStep.ENTERING
        diagnostics.log("enter", mapOf("to" to to, "renewal" to renewing))
        main.removeCallbacks(enterTimeout)
        main.postDelayed(enterTimeout, SignInFlow.TIMEOUT_MS)
        web.load(enterUrl(ticket, verifier, to))
    }

    private fun startWebSignIn() {
        signIn = SignInStep.WEB_FALLBACK
        web.loadPath("/sign?native-sign-in=web")
    }

    private fun finishSignIn() {
        main.removeCallbacks(enterTimeout)
        renewing = false
        // Signed in first: the web area never leaves the screen between ENTERING and the tabs.
        phase = Phase.SIGNED_IN
        signIn = SignInStep.IDLE
        signInMessage = null
        clearLoadFailure()
        CookieManager.getInstance().flush()
    }

    private fun failSignIn(message: String) {
        main.removeCallbacks(enterTimeout)
        if (renewing) {
            renewing = false
            return
        }
        if (phase != Phase.SIGNED_OUT || signIn != SignInStep.ENTERING) return
        web.stop()
        signIn = SignInStep.IDLE
        signInMessage = message
    }

    /** The page says nobody is signed in any more. */
    private fun sessionEnded(reason: String) {
        diagnostics.log("session-ended", mapOf("reason" to reason))
        main.removeCallbacks(enterTimeout)
        stopSkeleton()
        renewing = false
        phase = Phase.SIGNED_OUT
        signIn = SignInStep.IDLE
        clearLoadFailure()
        selectedTab = ShellTab.HOME
        val deleted = SessionCookies.delete(config)
        diagnostics.log("session-cookies-deleted", mapOf("count" to deleted))
    }

    // The loading skeleton. ----------------------------------------------------------------------------

    private val hideSkeleton = Runnable {
        if (pageLoading) {
            pageLoading = false
            diagnostics.log("skeleton", mapOf("shown" to false, "ms" to System.currentTimeMillis() - loadingSince))
            changed()
        }
    }
    private val checkContent = Runnable { checkPageContent() }

    override fun onFullLoad() {
        main.removeCallbacks(hideSkeleton)
        main.removeCallbacks(checkContent)
        if (!pageLoading) {
            pageLoading = true
            loadingSince = System.currentTimeMillis()
            diagnostics.log("skeleton", mapOf("shown" to true))
            changed()
        }
    }

    /** The page has rendered: the skeleton fades out after `after` ms, never before 300 ms on screen. */
    private fun pageShown(reason: String, after: Long) {
        if (!pageLoading) return
        main.removeCallbacks(checkContent)
        val elapsed = System.currentTimeMillis() - loadingSince
        val delay = maxOf(after, MIN_SKELETON_MS - elapsed, 0L)
        diagnostics.log("skeleton-ending", mapOf("reason" to reason, "afterMs" to delay))
        main.removeCallbacks(hideSkeleton)
        main.postDelayed(hideSkeleton, delay)
    }

    /** Finished and no `ready` came: the skeleton goes, whatever the page shows. */
    private fun checkPageContent() {
        if (!pageLoading || web.pageReady) return
        web.evaluateJson("JSON.stringify({n: (document.body && document.body.innerText.trim().length) || 0, t: document.title})") { answer ->
            pageShown("finished-no-ready", 0)
            diagnostics.log("page-after-finish", mapOf("textLength" to (answer?.optInt("n", 0) ?: 0), "title" to (answer?.optString("t") ?: "")))
        }
    }

    private fun stopSkeleton() {
        main.removeCallbacks(hideSkeleton)
        main.removeCallbacks(checkContent)
        if (pageLoading) {
            pageLoading = false
            changed()
        }
    }

    // Tabs, back, chrome. ---------------------------------------------------------------------------

    fun selectTab(tab: ShellTab) {
        selectedTab = tab
        web.open(tab.path) { mode ->
            lastNavigation = mode
            changed()
        }
    }

    /** Whether system Back goes back in the WebView (or cancels the web sign-in) instead of leaving. */
    val handlesBack: Boolean
        get() = !showsLock && when {
            phase == Phase.SIGNED_OUT && signIn == SignInStep.WEB_FALLBACK -> true
            phase == Phase.SIGNED_IN || phase == Phase.PLAIN -> web.webView.canGoBack()
            else -> false
        }

    fun onBack() {
        if (phase == Phase.SIGNED_OUT && signIn == SignInStep.WEB_FALLBACK && !web.webView.canGoBack()) {
            cancelWebSignIn()
            return
        }
        diagnostics.log("back", mapOf("canGoBack" to web.webView.canGoBack()))
        if (web.webView.canGoBack()) web.webView.goBack()
    }

    fun refreshChrome() {
        if (!webVisible) return
        web.readChrome { color, dark, css ->
            if (color != null) pageBackground = color
            if (dark != null) pageIsDark = dark
            diagnostics.log("chrome", mapOf("css" to css, "dark" to (dark?.let { if (it) 1 else 0 } ?: -1)))
            changed()
        }
    }

    fun setKeyboardVisible(visible: Boolean) {
        if (keyboardVisible == visible) return
        keyboardVisible = visible
        diagnostics.log("keyboard", mapOf("visible" to visible))
        changed()
    }

    // Network and load failures. ------------------------------------------------------------------------

    private fun networkChanged(offline: Boolean) {
        diagnostics.log("network", mapOf("offline" to offline, "reason" to network.lastReason))
        this.offline = offline
        if (offline) return
        if (loadFailed) {
            retryNow()
        } else if (webVisible && web.lastLoadFailed) {
            web.retry()
        }
    }

    /**
     * Any failure to load the web app shows the lock screen and retries by itself: every 5 s, then
     * every 15 s after 6 tries, and when the network comes back. It lifts when a page commits.
     */
    private fun showLoadFailure(source: FailureSource, detail: String) {
        diagnostics.log("load-failure-lock", mapOf("source" to if (source == FailureSource.WEB) "web" else "sign-in", "detail" to detail))
        failureSource = source
        loadFailed = true
        scheduleAutoRetry()
    }

    private fun clearLoadFailure() {
        main.removeCallbacks(autoRetry)
        retryCount = 0
        failureSource = null
        loadFailed = false
    }

    private fun scheduleAutoRetry() {
        main.removeCallbacks(autoRetry)
        main.postDelayed(autoRetry, if (retryCount < 6) 5_000L else 15_000L)
    }

    /** The lock screen's Try again, and the automatic retries. */
    fun retryNow(automatic: Boolean = false) {
        if (!loadFailed) return
        retryCount += 1
        diagnostics.log("retry", mapOf("automatic" to automatic, "count" to retryCount, "offline" to offline))
        if (!offline) {
            if (failureSource == FailureSource.SIGN_IN) {
                // Nothing to reload: once OpenBot answers, back to the sign-in screen.
                signInFlow.ping(config) { answered ->
                    diagnostics.log("retry-ping", mapOf("answered" to answered))
                    if (answered && failureSource == FailureSource.SIGN_IN) clearLoadFailure()
                }
            } else {
                web.retry()
            }
        }
        if (loadFailed) scheduleAutoRetry()
    }

    // WebController.Delegate. --------------------------------------------------------------------------

    override fun onBridgeMessage(message: JSONObject) {
        when (message.optString("type")) {
            "ready" -> {
                pageShown("ready", 200)
                refreshChrome()
            }
            "route" -> {
                val path = message.optString("path")
                val signedIn = message.optBoolean("signedIn", false)
                if (!message.isNull("tab")) ShellTab.fromKey(message.optString("tab"))?.let { selectedTab = it }
                if (signedIn) {
                    if (phase != Phase.SIGNED_IN || renewing) finishSignIn()
                } else if (path == "/sign" || path.startsWith("/sign/")) {
                    if (phase == Phase.SIGNED_IN) {
                        sessionEnded("route-sign")
                    } else if (signIn == SignInStep.ENTERING) {
                        failSignIn(activity.getString(R.string.sign_in_not_finished))
                    }
                }
                refreshChrome()
            }
            "signed-out" -> {
                if (phase == Phase.SIGNED_IN) {
                    sessionEnded("signed-out")
                } else if (signIn == SignInStep.ENTERING) {
                    failSignIn(activity.getString(R.string.sign_in_not_finished))
                }
            }
        }
    }

    override fun shouldInterceptHostedSignIn(url: Uri): Boolean {
        if (phase != Phase.SIGNED_IN || renewing) return false
        if (handoffSupported == false) return false
        // The hosted sign-in's renewal: do it in the Custom Tab, then come back here.
        renewing = true
        val returnTo = web.currentPath
        val pair = PkcePair.make()
        diagnostics.log("renewal", mapOf("returnTo" to returnTo, "handoffKnown" to (handoffSupported != null)))
        val known = handoffMode
        if (known != null && handoffSupported == true) {
            presentTab(pair, known, returnTo)
            return true
        }
        signInFlow.fetchConfig(config, httpsCallbackSupported()) { mode ->
            when (mode) {
                is HandoffMode.Scheme, is HandoffMode.Https -> {
                    handoffMode = mode
                    presentTab(pair, mode, returnTo)
                }
                else -> {
                    if (mode is HandoffMode.WebSignIn) handoffMode = mode
                    renewing = false
                    web.loadHostedSignInAfterAll(url)
                }
            }
        }
        return true
    }

    override fun allowsLeavingOrigin(): Boolean = signIn == SignInStep.WEB_FALLBACK

    override fun onLoadFailed(detail: String) {
        stopSkeleton()
        if (phase == Phase.SIGNED_OUT && signIn == SignInStep.ENTERING) {
            failSignIn(activity.getString(R.string.sign_in_not_finished))
            showLoadFailure(FailureSource.SIGN_IN, "enter-failed")
            return
        }
        if (!webVisible) return
        if (loadFailed && failureSource == FailureSource.WEB) return
        showLoadFailure(FailureSource.WEB, "web-load-failed $detail")
    }

    override fun onUrlChanged(url: String?) {
        if (url == null || !config.isOwnOrigin(url)) return
        val path = Uri.parse(url).path?.ifEmpty { "/" } ?: "/"
        val first = path.split("/").firstOrNull { it.isNotEmpty() }?.let { "/$it" } ?: "/"
        if (webPathRoot != first) {
            webPathRoot = first
            changed()
        }
        val onSignPage = path == "/sign" || path.startsWith("/sign/")
        // A web app without the bridge (production today) says nothing: its URL tells.
        if (phase == Phase.SIGNED_IN && onSignPage && !renewing) {
            sessionEnded("url-sign")
        } else if (phase == Phase.SIGNED_OUT && signIn == SignInStep.WEB_FALLBACK && !onSignPage && !path.startsWith("/api/")) {
            if (SessionCookies.present(config)) {
                diagnostics.log("signed-in-by-url", mapOf("pathRoot" to first))
                finishSignIn()
            }
        }
    }

    override fun onFinished() {
        // An older web app says nothing over the bridge: read its colours when it has loaded, and
        // end the skeleton once its body has text.
        refreshChrome()
        if (pageLoading && !web.pageReady) {
            // No `ready` within 1.5 s of finishing: a page without the bridge (production today),
            // or one that is not the web app at all (an interactive bot check): never keep it covered.
            main.removeCallbacks(checkContent)
            main.postDelayed(checkContent, NO_READY_MS)
        }
    }

    override fun onCommit() {
        mainFrameCommits += 1
        if (failureSource == FailureSource.WEB || failureSource == null) clearLoadFailure()
        changed()
    }

    companion object {
        const val MIN_SKELETON_MS = 300L
        const val NO_READY_MS = 1_500L
    }
}
