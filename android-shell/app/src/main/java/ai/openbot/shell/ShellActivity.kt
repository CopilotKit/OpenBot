package ai.openbot.shell

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import androidx.appcompat.widget.PopupMenu
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
import com.google.android.material.dialog.MaterialAlertDialogBuilder
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
    private lateinit var bottomBar: LinearLayout
    private lateinit var moreButton: ImageButton
    private lateinit var skeleton: LoadingSkeletonView
    private var skeletonShown = false
    private lateinit var signInScreen: View
    private lateinit var signInButton: MaterialButton
    private lateinit var signInProgress: CircularProgressIndicator
    private lateinit var signInLine: TextView
    private lateinit var signInMessage: TextView
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
        config = ShellConfig.from(intent)
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
        bottomBar = findViewById(R.id.bottom_bar)
        moreButton = findViewById(R.id.more_button)
        skeleton = findViewById(R.id.loading_skeleton)
        signInScreen = findViewById(R.id.sign_in_screen)
        signInButton = findViewById(R.id.sign_in_button)
        signInProgress = findViewById(R.id.sign_in_progress)
        signInLine = findViewById(R.id.sign_in_line)
        signInMessage = findViewById(R.id.sign_in_message)
        lock = findViewById(R.id.offline_lock)

        registerLaunchers()

        web = WebController(this, config, diagnostics, webContainer)
        web.create()
        controller = ShellController(this, config, diagnostics, web)
        web.delegate = controller

        signInButton.setOnClickListener { controller.signIn() }
        findViewById<View>(R.id.web_sign_in_cancel).setOnClickListener { controller.cancelWebSignIn() }
        findViewById<View>(R.id.retry_button).setOnClickListener { controller.retryNow() }
        findViewById<View>(R.id.support_email).setOnClickListener { openSupportMail() }
        moreButton.setOnClickListener { showMoreMenu() }

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
        CookieManager.getInstance().flush()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (controller.phase == Phase.SIGNED_IN) outState.putString(STATE_PATH, web.currentPath)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        render()
    }

    override fun onDestroy() {
        if (started) {
            controller.stop()
            web.destroy()
        }
        super.onDestroy()
    }

    // Drawing the state. ----------------------------------------------------------------------------

    fun render() {
        if (!started) return
        val c = controller
        val launching = c.phase == Phase.LAUNCHING
        val busy = c.signIn != SignInStep.IDLE

        signInScreen.isVisible = c.showsSignInScreen
        signInLine.isVisible = !launching
        signInButton.isVisible = !launching
        signInButton.isEnabled = !busy
        signInButton.text = if (busy) "" else getString(R.string.sign_in)
        signInButton.contentDescription = getString(if (busy) R.string.signing_in else R.string.sign_in)
        signInProgress.isVisible = !launching && busy
        signInMessage.text = c.signInMessage ?: ""
        signInMessage.isVisible = c.signInMessage != null && !launching

        web.webView.isVisible = c.webVisible
        webSignInBar.isVisible = c.showsWebSignInBar
        bottomBar.isVisible = c.showsTabBar
        renderSkeleton(c.showsSkeleton)
        val item = bottomNav.menu.findItem(c.selectedTab.itemId)
        if (item != null && !item.isChecked) item.isChecked = true

        lock.isVisible = c.showsLock
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

    /** The native More menu: Reload and Sign out, whatever the web app's version. */
    private fun showMoreMenu() {
        val menu = PopupMenu(this, moreButton, Gravity.END)
        menu.menu.add(0, MENU_RELOAD, 0, R.string.menu_reload)
        menu.menu.add(0, MENU_SIGN_OUT, 1, R.string.menu_sign_out)
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_RELOAD -> controller.reload()
                MENU_SIGN_OUT -> confirmSignOut()
            }
            true
        }
        diagnostics.log("more-menu")
        menu.show()
    }

    private fun confirmSignOut() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.sign_out_question)
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.sign_out_confirm) { _, _ -> controller.nativeSignOut() }
            .show()
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
        bottomBar.setBackgroundColor(color)
        val foreground = if (isDark) 0xFFFAFAFA.toInt() else 0xFF0A0A0A.toInt()
        val muted = if (isDark) 0xFFA1A1AA.toInt() else 0xFF6B6B70.toInt()
        moreButton.imageTintList = ColorStateList.valueOf(muted)
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
        web.webView.setBackgroundColor(if (background == null) Color.TRANSPARENT else color)
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
        bottomBar.setPadding(0, 0, 0, bars.bottom)
        val webBottom = when {
            imeVisible -> maxOf(ime.bottom, bars.bottom)
            bottomBar.isVisible -> 0
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
        private const val MENU_RELOAD = 1
        private const val MENU_SIGN_OUT = 2
    }
}
