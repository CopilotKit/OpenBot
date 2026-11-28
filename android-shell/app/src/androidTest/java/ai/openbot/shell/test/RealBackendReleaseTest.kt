package ai.openbot.shell.test

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Suite 1 on the RELEASE-LIKE build (releaseTest: minified like release, no debug hooks; installed
 * beside the debug build as ai.openbot.shell.releasetest). This test runs in the debug build's
 * process and drives that other app from outside, through UiAutomator only, each test on cleared
 * app data (like a fresh install). https://my.open.bot as deployed today: no shell mode, no
 * /conversations, no sign-in hand-off.
 */
@RunWith(AndroidJUnit4::class)
class RealBackendReleaseTest : ShellTestBase() {
    override val pkg: String get() = "ai.openbot.shell.releasetest"
    override val variant: String get() = "releaseTest"

    @Before
    fun freshInstall() {
        val installed = shell("pm list packages $pkg").contains(pkg)
        if (!installed) skip("the releaseTest build ($pkg) is not installed")
        shell("am force-stop $pkg")
        shell("pm clear $pkg")
    }

    /** Only what a shipped app reads: the base URL and diagnostics extras (TEST_OVERRIDES), no hook. */
    private fun launchPlain(base: String?, moment: String) = launch(base, moment, reset = false)

    @Test
    fun testRealFirstScreenAndWebSignIn() {
        requireProduction()
        launchPlain(null, "web")
        val button = waitFor("sign_in_button", 15_000)
        if (!check(button != null, "no Sign in button")) return
        check(!exists("openbot_webview"), "a web view is visible on the first screen")
        screenshot("1-first-screen")
        button!!.click()
        if (!check(waitFor("web_sign_in_cancel", 25_000) != null, "no web sign-in fallback (production has no hand-off: config 404)")) {
            screenshot("no-web-fallback")
            return
        }
        val heading = waitWebObject("Sign in to OpenBot Cloud", 30_000)
        check(heading != null, "the real web sign-in did not show")
        sleep(1_500)
        screenshot("2-web-sign-in")
        val start = waitWebObject("Sign in or create an account", 15_000)
        if (!check(start != null, "no 'Sign in or create an account'")) return
        start!!.click()
        val idp = firstWebObject(listOf("GitHub", "Google", "Microsoft"), 30_000)
        sleep(4_000)
        screenshot("3-identity-provider")
        check(idp != null, "the identity provider's page did not show")
        for (name in listOf("GitHub", "Google", "Microsoft", "Email", "email")) {
            note("identity provider offers $name: ${webObject(name) != null}")
        }
        check(exists("web_sign_in_cancel"), "the Cancel bar went away on the identity provider's page")
        check(foregroundPackage() == pkg, "the identity provider left the app's web view (foreground ${foregroundPackage()})")

        // What Google does with Android's WebView (its user agent says '; wv').
        val google = device.findObject(By.textContains("Google")) ?: device.findObject(By.descContains("Google"))
        if (google == null) {
            note("no Google button in the web view")
            return
        }
        google.click()
        sleep(10_000)
        screenshot("4-google-in-webview")
        val refused = listOf("disallowed_useragent", "may not be secure", "Access blocked", "Error 403")
            .filter { webObject(it) != null }
        val emailPage = webObject("Email or phone") != null
        note("Google in the WebView: sign-in page shown $emailPage; refusal text $refused; foreground ${foregroundPackage()}")
    }

    @Test
    fun testRealLockScreenWhenBackendUnreachable() {
        launchPlain("https://unreachable.openbot.invalid", "unreachable")
        val button = waitFor("sign_in_button", 15_000)
        if (!check(button != null, "no Sign in button")) return
        button!!.click()
        check(waitFor("offline_lock", 30_000) != null, "no lock screen")
        assertLockScreen(null)
        sleep(1_000)
        screenshot("lock-screen")
        find("retry_button")?.click()
        sleep(2_000)
        check(exists("offline_lock"), "the lock went away with nothing to reach")
    }
}
