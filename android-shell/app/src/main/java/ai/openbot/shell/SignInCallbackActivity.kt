package ai.openbot.shell

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Receives `openbotshell://signed-in?ticket=` (and, once App Links are verified, the https
 * callback) from the browser. Passes it to ShellActivity only while a sign-in this app started is
 * waiting; otherwise drops it. Never logs the URL.
 */
class SignInCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        if (data != null && PendingSignIn.isWaiting()) {
            val forward = Intent(this, ShellActivity::class.java)
                .setAction(ShellActivity.ACTION_SIGN_IN_CALLBACK)
                .setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            startActivity(forward)
        }
        finish()
    }
}
