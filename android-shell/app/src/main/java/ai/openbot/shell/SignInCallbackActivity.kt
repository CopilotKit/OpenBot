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
        // Only a callback with a well-formed ticket for the pending sign-in's mode is passed on;
        // anything else is dropped here, so the Custom Tab (and the sign-in) stays open.
        val ticket = HandoffConfig.ticket(data?.toString(), PendingSignIn.mode)
        if (data != null && PendingSignIn.isWaiting() && ticket != null && ShellController.TICKET.matches(ticket)) {
            val forward = Intent(this, ShellActivity::class.java)
                .setAction(ShellActivity.ACTION_SIGN_IN_CALLBACK)
                .setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            startActivity(forward)
        }
        finish()
    }
}
