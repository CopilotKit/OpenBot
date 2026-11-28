package ai.openbot.shell

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.webkit.WebViewCompat
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.CircularProgressIndicator

/**
 * The one activity. Edge to edge (target 36): the status bar and navigation bar insets are applied
 * here, so the WebView sits between the status bar and the bottom bar and never under either, and
 * above the keyboard while it is up (the bottom bar hides then).
 */
class ShellActivity : AppCompatActivity() {
    private lateinit var config: ShellConfig
    private lateinit var diagnostics: Diagnostics
    private lateinit var web: WebController
    private lateinit var controller: ShellController

    private lateinit var root: FrameLayout
    private lateinit var content: LinearLayout
    private lateinit var webSignInBar: FrameLayout
    private lateinit var webContainer: FrameLayout
    private lateinit var bottomNav: BottomNavigationView
    private lateinit var skeleton: LoadingSkeletonView
    private var skeletonShown = false
    private lateinit var signInScreen: View
    private lateinit var signInButton: MaterialButton
    private lateinit var signInProgress: CircularProgressIndicator
    private lateinit var signInLine: TextView
    private lateinit var signInMessage: TextView
    private lateinit var serverHost: TextView
    private lateinit var selfHostedToggle: MaterialButton
    private lateinit var selfHostedPanel: View
    private lateinit var addressField: com.google.android.material.textfield.TextInputLayout
    private lateinit var addressInput: android.widget.EditText
    private lateinit var addressError: TextView
    private lateinit var addressContinue: MaterialButton
    private lateinit var lockHost: TextView
    private lateinit var lockChange: MaterialButton
    private var serverPanelOpen = false
    private var checkingServer = false
    private var serverCheck: SignInFlow? = null
    private lateinit var lock: View

    private var lastInsets: WindowInsetsCompat? = null
    private var debugLabel: ((String) -> Unit)? = null
    private var started = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooser: ActivityResultLauncher<Intent>
    private lateinit var pickMedia: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var pickMultipleMedia: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var permissions: ActivityResultLauncher<Array<String>>
    private var permissionsDone: ((Map<String, Boolean>) -> Unit)? = null

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            controller.onBack()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        config = ShellConfig.from(this, intent, fresh = savedInstanceState == null)
        DebugHooks.beforeCreate(this, config.hooks)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_shell)
        diagnostics = Diagnostics(applicationContext, config.diagnosticsEnabled, config.testName)

        root = findViewById(R.id.root)
        content = findViewById(R.id.content)
        webSignInBar = findViewById(R.id.web_sign_in_bar)
        webContainer = findViewById(R.id.web_container)
        bottomNav = findViewById(R.id.bottom_nav)
        skeleton = findViewById(R.id.loading_skeleton)
        signInScreen = findViewById(R.id.sign_in_screen)
        signInButton = findViewById(R.id.sign_in_button)
        signInProgress = findViewById(R.id.sign_in_progress)
        signInLine = findViewById(R.id.sign_in_line)
        signInMessage = findViewById(R.id.sign_in_message)
        lock = findViewById(R.id.offline_lock)
        serverHost = findViewById(R.id.server_host)
        selfHostedToggle = findViewById(R.id.self_hosted_toggle)
        selfHostedPanel = findViewById(R.id.self_hosted_panel)
        addressField = findViewById(R.id.self_hosted_field)
        addressInput = findViewById(R.id.self_hosted_address)
        addressError = findViewById(R.id.self_hosted_error)
        addressContinue = findViewById(R.id.self_hosted_continue)
        lockHost = findViewById(R.id.offline_lock_host)
        lockChange = findViewById(R.id.lock_change_address)

        registerLaunchers()

        web = WebController(this, config, diagnostics, webContainer)
        web.create()
        controller = ShellController(this, config, diagnostics, web)
        web.delegate = controller

        signInButton.setOnClickListener { controller.signIn() }
        setUpServerPicker()
        findViewById<View>(R.id.web_sign_in_cancel).setOnClickListener { controller.cancelWebSignIn() }
        findViewById<View>(R.id.retry_button).setOnClickListener { controller.retryNow() }
        findViewById<View>(R.id.support_email).setOnClickListener { openSupportMail() }

        bottomNav.setOnItemSelectedListener { item ->
            ShellTab.fromItem(item.itemId)?.let { controller.selectTab(it) }
            true
        }
        // A tap on the selected tab navigates too: back to the tab's own page.
        bottomNav.setOnItemReselectedListener { item ->
            ShellTab.fromItem(item.itemId)?.let { controller.selectTab(it) }
        }
        // Insets are applied here, not by the bar itself.
        ViewCompat.setOnApplyWindowInsetsListener(bottomNav, null)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            lastInsets = insets
            controller.setKeyboardVisible(insets.isVisible(WindowInsetsCompat.Type.ime()))
            applyLayout()
            WindowInsetsCompat.CONSUMED
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        debugLabel = DebugHooks.stateLabel(root)

        started = true
        render()
        controller.start(savedInstanceState?.getString(STATE_PATH))
        // A recreated activity (Don't keep activities, a theme flip while the Custom Tab was open)
        // can be started by the callback itself.
        if (intent?.action == ACTION_SIGN_IN_CALLBACK) controller.handleCallback(intent.data)
        // The lock screen's Change address before a restart, or a server change that asked for it.
        if (ServerChoice.takeOpenField(this)) openServerPanel(if (config.selfHosted) config.addressForField else "")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_SIGN_IN_CALLBACK) controller.handleCallback(intent.data)
    }

    override fun onResume() {
        super.onResume()
        controller.onResume()
    }

    override fun onPause() {
        super.onPause()
        hideKeyboard()
        CookieManager.getInstance().flush()
    }

    /** The keyboard goes before a tab switch, the lock screen, signing out and the background. */
    fun hideKeyboard() {
        if (lastInsets?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
            WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (controller.phase == Phase.SIGNED_IN) outState.putString(STATE_PATH, web.currentPath)
    }

    /**
     * Dark mode switched while open (uiMode is in configChanges, so the WebView keeps its page):
     * the native screens take the new colours, and the page's are read again.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        recolorNativeScreens()
        render()
        root.postDelayed({ if (started) controller.refreshChrome() }, 500)
    }

    private fun recolorNativeScreens() {
        val ink = ContextCompat.getColor(this, R.color.ink)
        val paper = ContextCompat.getColor(this, R.color.paper)
        val secondary = ContextCompat.getColor(this, R.color.ink_secondary)
        for (screen in listOf(signInScreen, lock)) screen.setBackgroundColor(paper)
        findViewById<TextView>(R.id.sign_in_title).setTextColor(ink)
        signInLine.setTextColor(secondary)
        signInMessage.setTextColor(secondary)
        findViewById<TextView>(R.id.offline_lock_heading).setTextColor(ink)
        findViewById<TextView>(R.id.offline_lock_message).setTextColor(secondary)
        findViewById<TextView>(R.id.support_email).setTextColor(ink)
        for (quiet in listOf(serverHost, selfHostedToggle, lockHost, lockChange, findViewById<TextView>(R.id.self_hosted_cancel))) {
            quiet.setTextColor(secondary)
        }
        for (button in listOf(signInButton, addressContinue, findViewById<MaterialButton>(R.id.retry_button))) {
            button.backgroundTintList = ColorStateList.valueOf(ink)
            button.setTextColor(paper)
        }
        signInProgress.setIndicatorColor(paper)
    }

    /**
     * The page's downloads: http(s) on the app's own origin to the system's DownloadManager, into
     * Downloads, with the page's cookies and user agent; other sites' files are declined; blob: and data: addresses (made in the page) cannot be handed over, so they are
     * declined with a short message.
     */
    fun download(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val uri = Uri.parse(url)
        val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
        if (uri.scheme != "https" && uri.scheme != "http") {
            diagnostics.log("download", mapOf("result" to "unsupported", "scheme" to uri.scheme))
            android.widget.Toast.makeText(this, R.string.download_unsupported, android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        if (!config.isOwnOrigin(url)) {
            // Only files from the app's own origin are saved; another site's is declined.
            diagnostics.log("download", mapOf("result" to "other-origin", "host" to uri.host))
            android.widget.Toast.makeText(this, R.string.download_unsupported, android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val request = android.app.DownloadManager.Request(uri)
                .setTitle(name)
                .setMimeType(mimeType)
                .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            // In Downloads, where the person can find it (API 29+ needs no storage permission for
            // that; below, the system's own download area is all the app may use).
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
            }
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent)
            getSystemService(android.app.DownloadManager::class.java).enqueue(request)
            diagnostics.log("download", mapOf("result" to "enqueued", "url" to Diagnostics.redact(url)))
            android.widget.Toast.makeText(this, getString(R.string.download_started, name), android.widget.Toast.LENGTH_SHORT).show()
        } catch (error: RuntimeException) {
            diagnostics.log("download", mapOf("result" to "failed", "error" to error.javaClass.simpleName))
            android.widget.Toast.makeText(this, R.string.download_unsupported, android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        serverCheck?.shutdown()
        if (started) {
            controller.stop()
            web.destroy()
        }
        super.onDestroy()
    }

    // A self-hosted OpenBot. ------------------------------------------------------------------------

    private fun setUpServerPicker() {
        selfHostedToggle.setOnClickListener {
            if (config.selfHosted) switchServer(null) else openServerPanel("")
        }
        findViewById<View>(R.id.self_hosted_cancel).setOnClickListener { closeServerPanel() }
        addressContinue.setOnClickListener { submitAddress() }
        addressInput.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_GO || enter) {
                submitAddress()
                true
            } else {
                false
            }
        }
        addressInput.doAfterTextChangedCompat { if (!checkingServer) showAddressError(null) }
        lockChange.setOnClickListener { openServerPanel(config.addressForField, fromLock = true) }
    }

    private fun android.widget.EditText.doAfterTextChangedCompat(action: () -> Unit) {
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) = action()
        })
    }

    /** Expands the field in place: a short fade and slide, none when animations are off. */
    private fun openServerPanel(prefill: String, fromLock: Boolean = false) {
        if (fromLock) controller.pickingServer = true
        beginServerTransition()
        serverPanelOpen = true
        addressInput.setText(prefill)
        addressInput.setSelection(prefill.length)
        showAddressError(null)
        render()
        addressInput.requestFocus()
        WindowCompat.getInsetsController(window, addressInput).show(WindowInsetsCompat.Type.ime())
        diagnostics.log("server-picker", mapOf("open" to true, "prefilled" to prefill.isNotEmpty()))
    }

    private fun closeServerPanel() {
        beginServerTransition()
        serverPanelOpen = false
        serverCheck?.shutdown()
        serverCheck = null
        checkingServer = false
        showAddressError(null)
        hideKeyboard()
        controller.pickingServer = false
        render()
    }

    private fun beginServerTransition() {
        if (!android.animation.ValueAnimator.areAnimatorsEnabled()) return
        android.transition.TransitionManager.beginDelayedTransition(
            findViewById(R.id.sign_in_column),
            android.transition.AutoTransition().setDuration(180),
        )
    }

    private fun submitAddress() {
        if (checkingServer) return
        val parsed = ServerAddress.parse(addressInput.text?.toString() ?: "", allowDevelopmentHttp = BuildConfig.DEBUG)
        val ok = when (parsed) {
            is ServerAddress.Result.Refused -> {
                showAddressError(getString(when (parsed.reason) {
                    ServerAddress.Reason.EMPTY -> R.string.self_hosted_error_empty
                    ServerAddress.Reason.INVALID -> R.string.self_hosted_error_invalid
                    ServerAddress.Reason.CREDENTIALS -> R.string.self_hosted_error_credentials
                    ServerAddress.Reason.HTTP -> R.string.self_hosted_error_http
                }))
                diagnostics.log("server-address", mapOf("result" to parsed.reason.name))
                return
            }
            is ServerAddress.Result.Ok -> parsed
        }
        if (Origins.same(ok.origin, config.cloudUrl.toString())) {
            // OpenBot Cloud typed out: no check needed.
            switchServer(null)
            return
        }
        checkingServer = true
        render()
        val check = SignInFlow(diagnostics)
        serverCheck = check
        check.checkServer(ok.origin) { outcome, _ ->
            if (serverCheck !== check) return@checkServer
            checkingServer = false
            if (outcome == ServerCheck.Outcome.OK) {
                switchServer(ok.origin)
                return@checkServer
            }
            showAddressError(getString(when (outcome) {
                ServerCheck.Outcome.TOO_OLD -> R.string.self_hosted_error_too_old
                ServerCheck.Outcome.NOT_FOUND -> R.string.self_hosted_error_not_found
                ServerCheck.Outcome.CERTIFICATE -> R.string.self_hosted_error_certificate
                else -> R.string.self_hosted_error_no_answer
            }, ok.host))
            render()
        }
    }

    private fun showAddressError(message: String?) {
        addressError.text = message ?: ""
        addressError.isVisible = message != null
        addressField.isErrorEnabled = false
    }

    /**
     * Changes the app's OpenBot (null: OpenBot Cloud). The web view's site data and any sign-in
     * attempt go first, awaited; then the activity restarts with the new own origin everywhere.
     */
    private fun switchServer(origin: String?) {
        diagnostics.log("server-change", mapOf("to" to if (origin == null) "cloud" else "self-hosted"))
        hideKeyboard()
        controller.prepareServerChange()
        web.clearAllData {
            ServerChoice.save(this, origin)
            CookieManager.getInstance().flush()
            recreate()
        }
    }

    private fun renderServerPicker(launching: Boolean, busy: Boolean) {
        val idle = !launching && !busy
        selfHostedPanel.isVisible = serverPanelOpen && !launching
        selfHostedToggle.isVisible = idle && !serverPanelOpen
        selfHostedToggle.text = getString(if (config.selfHosted) R.string.self_hosted_use_cloud else R.string.self_hosted_toggle)
        serverHost.isVisible = config.selfHosted && !launching && !serverPanelOpen
        serverHost.text = getString(R.string.self_hosted_signs_in_to, config.displayHost)
        // While the field is open its Continue is the one action; Sign in (OpenBot Cloud) steps back.
        signInButton.isVisible = !launching && !serverPanelOpen
        addressContinue.isEnabled = !checkingServer
        addressContinue.text = getString(if (checkingServer) R.string.self_hosted_checking else R.string.self_hosted_continue)
        addressInput.isEnabled = !checkingServer
        // With the keyboard up the field and its buttons come first: the mark and the line step aside.
        val compact = serverPanelOpen && controller.keyboardVisible
        findViewById<View>(R.id.sign_in_mark).isVisible = !compact
        signInLine.isVisible = !launching && !compact
    }

    // Drawing the state. ----------------------------------------------------------------------------

    fun render() {
        if (!started) return
        val c = controller
        val launching = c.phase == Phase.LAUNCHING
        val busy = c.signIn != SignInStep.IDLE

        if (c.showsSignInScreen && !signInScreen.isVisible) hideKeyboard()
        signInScreen.isVisible = c.showsSignInScreen
        signInLine.isVisible = !launching
        signInButton.isVisible = !launching
        signInButton.isEnabled = !busy
        signInButton.text = if (busy) "" else getString(R.string.sign_in)
        signInButton.contentDescription = getString(if (busy) R.string.signing_in else R.string.sign_in)
        signInProgress.isVisible = !launching && busy
        signInMessage.text = c.signInMessage ?: ""
        signInMessage.isVisible = c.signInMessage != null && !launching
        renderServerPicker(launching, busy)

        web.webView.isVisible = c.webVisible
        webSignInBar.isVisible = c.showsWebSignInBar
        bottomNav.isVisible = c.showsTabBar
        renderSkeleton(c.showsSkeleton)
        val item = bottomNav.menu.findItem(c.selectedTab.itemId)
        if (item != null && !item.isChecked) item.isChecked = true

        if (c.showsLock && !lock.isVisible) hideKeyboard()
        lock.isVisible = c.showsLock
        lockHost.text = getString(R.string.lock_reaching, config.displayHost)
        lockChange.isVisible = config.selfHosted
        val hidden = if (c.showsLock) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        content.importantForAccessibility = hidden
        signInScreen.importantForAccessibility = hidden

        applyChrome(c.chromeBackground, c.chromeIsDark)
        backCallback.isEnabled = c.handlesBack
        debugLabel?.invoke(c.debugState)
        applyLayout()
    }

    /** Shows the skeleton at once; fades it out over 200 ms. */
    private fun renderSkeleton(show: Boolean) {
        if (show == skeletonShown) return
        skeletonShown = show
        skeleton.animate().cancel()
        if (show) {
            skeleton.alpha = 1f
            skeleton.isVisible = true
        } else {
            skeleton.animate().alpha(0f).setDuration(200).withEndAction { skeleton.isVisible = false }.start()
        }
    }

    /** Back should leave after all: the callback steps aside and the system's default runs. */
    fun leaveBySystemBack() {
        backCallback.isEnabled = false
        onBackPressedDispatcher.onBackPressed()
    }

    fun onBackStateChanged() {
        if (started) backCallback.isEnabled = controller.handlesBack
    }

    fun onWebViewRecreated() {
        render()
    }

    private fun systemIsDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** The page's colour behind the status bar, the Cancel bar and the bottom bar; icons to match. */
    private fun applyChrome(background: Int?, dark: Boolean?) {
        val isDark = dark ?: systemIsDark()
        val color = background ?: ContextCompat.getColor(this, R.color.paper)
        root.setBackgroundColor(color)
        webSignInBar.setBackgroundColor(color)
        bottomNav.setBackgroundColor(color)
        val foreground = if (isDark) 0xFFFAFAFA.toInt() else 0xFF0A0A0A.toInt()
        val muted = if (isDark) 0xFFA1A1AA.toInt() else 0xFF6B6B70.toInt()
        skeleton.setColors(isDark, background)
        val tint = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(foreground, muted),
        )
        bottomNav.setItemIconTintList(tint)
        bottomNav.setItemTextColor(tint)
        bottomNav.setItemActiveIndicatorColor(ColorStateList.valueOf(ColorUtils.setAlphaComponent(foreground, 0x24)))
        bottomNav.setItemRippleColor(ColorStateList.valueOf(ColorUtils.setAlphaComponent(foreground, 0x1F)))
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        bars.isAppearanceLightStatusBars = !isDark
        bars.isAppearanceLightNavigationBars = !isDark
        // Never white while empty: the page's colour, or the app's own background.
        web.webView.setBackgroundColor(color)
    }

    /**
     * The status bar's inset above the content; the navigation bar's inset inside the bottom bar
     * (or under the WebView when the bar is hidden); the keyboard's inset under the WebView while it
     * is up, so the page's message box sits on the keyboard.
     */
    private fun applyLayout() {
        val insets = lastInsets ?: return
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
        content.setPadding(bars.left, bars.top, bars.right, 0)
        bottomNav.setPadding(0, 0, 0, bars.bottom)
        val webBottom = when {
            imeVisible -> maxOf(ime.bottom, bars.bottom)
            bottomNav.isVisible -> 0
            else -> bars.bottom
        }
        webContainer.setPadding(0, 0, 0, webBottom)
        signInScreen.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, if (imeVisible) ime.bottom else 0))
        lock.setPadding(bars.left, bars.top, bars.right, bars.bottom)
    }

    // What the shell asks of the activity. -------------------------------------------------------------

    fun openInCustomTab(url: Uri, purpose: String): Boolean = CustomTabs.open(this, url, purpose, diagnostics)

    fun webViewPackageDescription(): String {
        val info = WebViewCompat.getCurrentWebViewPackage(this) ?: return "unknown"
        return "${info.packageName} ${info.versionName}"
    }

    private fun openSupportMail() {
        val mail = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + getString(R.string.support_address)))
        try {
            startActivity(mail)
        } catch (error: ActivityNotFoundException) {
            diagnostics.log("support-mail", mapOf("result" to "no-mail-app"))
        }
    }

    private fun registerLaunchers() {
        fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
            fileCallback = null
        }
        pickMedia = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            fileCallback?.onReceiveValue(if (uri == null) null else arrayOf(uri))
            fileCallback = null
        }
        pickMultipleMedia = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
            fileCallback?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            fileCallback = null
        }
        permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            permissionsDone?.invoke(result)
            permissionsDone = null
        }
    }

    /**
     * The page's file input: the photo picker when it accepts only images (no media permission is
     * asked), the system's document picker otherwise.
     */
    fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        val types = params.acceptTypes.filter { it.isNotBlank() }
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        return try {
            if (types.isNotEmpty() && types.all { it.startsWith("image/") }) {
                val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                if (multiple) pickMultipleMedia.launch(request) else pickMedia.launch(request)
            } else {
                fileChooser.launch(params.createIntent())
            }
            true
        } catch (error: ActivityNotFoundException) {
            fileCallback = null
            false
        }
    }

    /** Asks for the runtime permissions behind the WebView's media resources; answers the granted ones. */
    fun requestMediaPermissions(resources: List<String>, done: (List<String>) -> Unit) {
        val needed = resources.associateWith { resource ->
            if (resource == PermissionRequest.RESOURCE_AUDIO_CAPTURE) Manifest.permission.RECORD_AUDIO else Manifest.permission.CAMERA
        }
        fun granted(permission: String) =
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
        val missing = needed.values.filterNot { granted(it) }.distinct()
        if (missing.isEmpty()) {
            done(resources)
            return
        }
        permissionsDone = { _ -> done(resources.filter { granted(needed.getValue(it)) }) }
        permissions.launch(missing.toTypedArray())
    }

    companion object {
        const val ACTION_SIGN_IN_CALLBACK = "ai.openbot.shell.SIGN_IN_CALLBACK"
        private const val STATE_PATH = "openbot.path"
    }
}
