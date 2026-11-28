package ai.openbot.shell.test

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Signing in to a self-hosted OpenBot. Mock stack A stands in for OpenBot Cloud (the base URL the
 * tests give the debug build) and mock stack C, on another origin with the hand-off, for the
 * self-hosted one. No production.
 */
@RunWith(AndroidJUnit4::class)
class SelfHostedTest : ShellTestBase() {
    private val text get() = instrumentation.targetContext

    private fun string(id: Int, vararg args: Any): String = text.getString(id, *args)

    private fun imeTop(): Int? = device.findObjects(By.pkg("com.google.android.inputmethod.latin"))
        .mapNotNull { bounds(it) }.maxByOrNull { it.width() * it.height() }?.top

    private fun openField(moment: String): Boolean {
        val toggle = waitFor("self_hosted_toggle", 15_000)
        if (!check(toggle != null, "$moment: no quiet self-hosted control")) return false
        toggle!!.click()
        val field = waitFor("self_hosted_address", 5_000)
        return check(field != null, "$moment: the address field did not appear")
    }

    private fun submit(address: String) {
        val field = find("self_hosted_address") ?: return
        field.text = address
        sleep(300)
        find("self_hosted_continue")?.click()
    }

    private fun errorText(timeoutMs: Long = 20_000): String {
        val error = device.wait(Until.findObject(res("self_hosted_error")), timeoutMs)
        return error?.text ?: ""
    }

    private fun chooseSelfHosted(moment: String): Boolean {
        if (!openField(moment)) return false
        submit(MOCK_C)
        // The app restarts for the new server: the first screen names it.
        val host = device.wait(Until.findObject(res("server_host")), 25_000)
        return check(host?.text == string(ai.openbot.shell.R.string.self_hosted_signs_in_to, "127.0.0.1:3013"),
            "$moment: the first screen does not name the self-hosted server (${host?.text}; error '${find("self_hosted_error")?.text}')")
    }

    private fun pageOrigin(): String = pageString("location.origin")

    // 1. At rest no field; the quiet control opens it in place, above the keyboard.
    @Test
    fun testFieldOnlyWhenAsked() {
        for (dark in listOf(false, true)) {
            val mode = if (dark) "dark" else "light"
            launch(MOCK_A, "rest-$mode", extras = if (dark) mapOf("openbot.force_dark" to "1") else emptyMap())
            check(waitFor("sign_in_button", 20_000) != null, "no Sign in button")
            sleep(800)
            check(find("self_hosted_address") == null, "the address field shows before it is asked for")
            check(find("server_host") == null, "the first screen names a server while on OpenBot Cloud")
            screenshot("1-rest-$mode")
            if (!openField(mode)) return
            sleep(600)
            check(waitKeyboard(true, 5_000), "$mode: no keyboard for the address")
            sleep(800)
            val field = bounds(find("self_hosted_address"))
            val button = bounds(find("self_hosted_continue"))
            val top = imeTop()
            note("$mode: field $field, Continue $button, keyboard top $top")
            if (top != null) {
                check(field != null && field.bottom <= top, "$mode: the keyboard covers the address field ($field, keyboard at $top)")
                check(button != null && button.bottom <= top, "$mode: the keyboard covers Continue ($button, keyboard at $top)")
            }
            screenshot("3-expanded-keyboard-$mode")
            device.pressBack()
            waitKeyboard(false, 3_000)
            sleep(600)
            screenshot("2-expanded-$mode")
            find("self_hosted_cancel")?.click()
            sleep(600)
            check(find("self_hosted_address") == null, "$mode: Cancel did not fold the field away")
        }
    }

    // 3. http, an address that is not an OpenBot, one that does not answer, one that does not exist.
    @Test
    fun testRefusedAddressesStayOnCloud() {
        launch(MOCK_A, "refused")
        check(waitFor("sign_in_button", 20_000) != null, "no Sign in button")
        if (!openField("refused")) return
        val cases = listOf(
            Triple("http", "http://openbot.example.com", string(ai.openbot.shell.R.string.self_hosted_error_http)),
            Triple("too-old", "http://127.0.0.1:8765", string(ai.openbot.shell.R.string.self_hosted_error_too_old, "127.0.0.1:8765")),
            Triple("no-answer", "http://127.0.0.1:8799", string(ai.openbot.shell.R.string.self_hosted_error_no_answer, "127.0.0.1:8799")),
            Triple("not-found", "openbot.invalid", string(ai.openbot.shell.R.string.self_hosted_error_not_found, "openbot.invalid")),
            Triple("invalid", "openbot", string(ai.openbot.shell.R.string.self_hosted_error_invalid)),
        )
        for ((name, address, expected) in cases) {
            submit(address)
            sleep(1_000)
            var shown = errorText()
            val deadline = System.currentTimeMillis() + 15_000
            while (shown != expected && System.currentTimeMillis() < deadline) {
                sleep(500)
                shown = find("self_hosted_error")?.text ?: ""
            }
            note("$name: '$shown'")
            if (name == "not-found" && shown == string(ai.openbot.shell.R.string.self_hosted_error_no_answer, "openbot.invalid")) {
                // The emulator's resolver may time out instead of answering "no such host".
                note("not-found: the emulator's DNS did not answer; the no-answer sentence showed")
            } else {
                checkEquals(expected, shown, "the sentence for '$name'")
            }
            dismissKeyboardIfUp()
            sleep(400)
            screenshot("error-$name")
        }
        find("self_hosted_cancel")?.click()
        sleep(600)
        check(find("server_host") == null, "a refused address changed the server")
        if (!check(signInThroughCustomTab("cloud", shots = false), "Sign in did not reach OpenBot Cloud")) return
        checkEquals(MOCK_A, pageOrigin(), "the page's origin after refused addresses")
    }

    // 2, 4, 5 and 6: the self-hosted server's sign-in, relaunch and sign-out there, the bridge only on
    // its origin, then back to OpenBot Cloud with nothing of it left.
    @Test
    fun testSelfHostedSignInAndBackToCloud() {
        launch(MOCK_A, "choose")
        check(waitFor("sign_in_button", 20_000) != null, "no Sign in button")
        if (!chooseSelfHosted("choose")) return
        sleep(800)
        screenshot("1-self-hosted-first-screen")
        if (!check(signInThroughCustomTab("self-hosted", shots = true), "signing in to the self-hosted server did not reach the tabs")) return
        check(waitPageText("Start a conversation", 30_000), "no Home on the self-hosted server")
        checkEquals(MOCK_C, pageOrigin(), "the page's origin on the self-hosted server")
        check(pageString("typeof window.__OPENBOT_NATIVE_SHELL__") == "object", "the self-hosted server's page has no marker")
        screenshot("2-self-hosted-home")

        // 6. A page of OpenBot Cloud's origin, loaded while on the self-hosted server: foreign.
        pageJs("location.href = '$MOCK_A/'")
        val deadline = System.currentTimeMillis() + 15_000
        while (pageOrigin() != MOCK_A && System.currentTimeMillis() < deadline) sleep(500)
        sleep(1_500)
        checkEquals(MOCK_A, pageOrigin(), "the other origin's page did not load")
        checkEquals("undefined", pageString("typeof window.__OPENBOT_NATIVE_SHELL__"), "the other origin's page got the marker")
        checkEquals("undefined", pageString("typeof window.OpenBotShellAndroid"), "the other origin's page got the bridge")
        screenshot("3-other-origin-foreign")
        pageJs("location.href = '$MOCK_C/'")
        check(waitPageText("Start a conversation", 20_000), "back on the self-hosted server's Home")

        // 4. Relaunch: still the self-hosted server, still signed in.
        launch(MOCK_A, "relaunch", reset = false)
        check(waitForTab(Tab.HOME, 25_000) != null, "the relaunch did not stay signed in")
        check(waitPageText("Start a conversation", 25_000), "no Home after the relaunch")
        checkEquals(MOCK_C, pageOrigin(), "the page's origin after the relaunch")
        screenshot("4-relaunched-self-hosted")

        // Sign out there: the first screen for that server.
        check(tapWeb("Account"), "no Account button")
        sleep(800)
        check(tapWeb("Sign out"), "no Sign out")
        val host = device.wait(Until.findObject(res("server_host")), 20_000)
        checkEquals(string(ai.openbot.shell.R.string.self_hosted_signs_in_to, "127.0.0.1:3013"), host?.text, "the first screen after signing out")
        screenshot("5-signed-out-self-hosted")

        // 5. Back to OpenBot Cloud: the default first screen, nothing of the self-hosted server left.
        val toCloud = find("self_hosted_toggle")
        checkEquals(string(ai.openbot.shell.R.string.self_hosted_use_cloud), toCloud?.text, "the way back to OpenBot Cloud")
        toCloud?.click()
        check(device.wait(Until.gone(res("server_host")), 20_000), "the first screen still names the self-hosted server")
        sleep(1_000)
        checkEquals(string(ai.openbot.shell.R.string.self_hosted_toggle), find("self_hosted_toggle")?.text, "the default quiet control")
        val leftover = android.webkit.CookieManager.getInstance().getCookie("$MOCK_C/") ?: ""
        check(!leftover.contains("session_token"), "the self-hosted session survived the change")
        screenshot("6-back-on-cloud")
        if (!check(signInThroughCustomTab("cloud", shots = false), "Sign in did not reach OpenBot Cloud")) return
        checkEquals(MOCK_A, pageOrigin(), "the page's origin back on OpenBot Cloud")
        screenshot("7-cloud-home")
    }

    /** The recording (video workflow, which=self-hosted): spec tests 2 then 5, paced, 20-30 s. */
    @Test
    fun testClipSelfHostedThenCloud() {
        mark("start")
        try {
            launch(MOCK_A, "clip")
            check(waitFor("sign_in_button", 20_000) != null, "no Sign in button")
            sleep(1_200)
            if (!openField("clip")) return
            sleep(600)
            val field = find("self_hosted_address") ?: return
            field.text = MOCK_C
            sleep(900)
            find("self_hosted_continue")?.click()
            val host = device.wait(Until.findObject(res("server_host")), 25_000)
            check(host != null, "clip: the first screen does not name the self-hosted server")
            sleep(1_500)
            if (!check(signInThroughCustomTab("clip", shots = false, paceMs = 700), "clip: the self-hosted sign-in did not reach the tabs")) return
            check(waitPageText("Start a conversation", 30_000), "clip: no Home on the self-hosted server")
            sleep(2_000)
            check(tapWeb("Account"), "clip: no Account button")
            sleep(1_200)
            check(tapWeb("Sign out"), "clip: no Sign out")
            check(device.wait(Until.findObject(res("server_host")), 20_000) != null, "clip: no self-hosted first screen after signing out")
            sleep(1_500)
            find("self_hosted_toggle")?.click()
            check(device.wait(Until.gone(res("server_host")), 20_000), "clip: not back on OpenBot Cloud")
            sleep(2_000)
        } finally {
            mark("end")
        }
    }

    // 7. The lock screen names the server; Change address opens the field with the address in it.
    @Test
    fun testLockNamesTheServer() {
        launch(MOCK_A, "lock-choose")
        check(waitFor("sign_in_button", 20_000) != null, "no Sign in button")
        if (!chooseSelfHosted("lock")) return
        launch(MOCK_A, "lock", reset = false, extras = mapOf("openbot.force_offline" to "1"))
        check(waitFor("offline_lock", 15_000) != null, "no lock screen")
        checkEquals(string(ai.openbot.shell.R.string.lock_reaching, "127.0.0.1:3013"), find("offline_lock_host")?.text, "the host on the lock screen")
        val change = find("lock_change_address")
        if (!check(change != null, "no Change address on the lock screen")) return
        screenshot("1-lock-self-hosted")
        change!!.click()
        val field = waitFor("self_hosted_address", 5_000)
        checkEquals(MOCK_C, field?.text, "the address field after Change address")
        dismissKeyboardIfUp()
        sleep(600)
        screenshot("2-change-address")
        find("self_hosted_cancel")?.click()
        check(waitFor("offline_lock", 5_000) != null, "Cancel did not return to the lock screen")

        launch(MOCK_A, "lock-cloud", extras = mapOf("openbot.force_offline" to "1"))
        check(waitFor("offline_lock", 15_000) != null, "no lock screen on OpenBot Cloud")
        checkEquals(string(ai.openbot.shell.R.string.lock_reaching, "localhost:3010"), find("offline_lock_host")?.text, "the host on OpenBot Cloud's lock screen")
        check(find("lock_change_address") == null, "Change address shows on OpenBot Cloud")
        screenshot("3-lock-cloud")
    }

    companion object {
        const val MOCK_C = "http://127.0.0.1:3013"
    }
}
