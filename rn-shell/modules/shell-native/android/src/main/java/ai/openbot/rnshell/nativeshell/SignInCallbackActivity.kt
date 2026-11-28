package ai.openbot.rnshell.nativeshell

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * The trampoline for the sign-in callback (see AndroidManifest.xml). It forwards the callback to the
 * app's main activity only while a sign-in this app started is pending (ShellNativeModule's
 * setSignInPending) and only when the address carries exactly one well-formed ticket; the
 * JavaScript then checks it again against the pending sign-in's mode. Otherwise it finishes at once,
 * invisibly: another app firing openbotshell:// neither ends the sign-in nor closes the Custom Tab.
 */
class SignInCallbackActivity : Activity() {
  companion object {
    @Volatile var pending: Boolean = false
    private val TICKET = Regex("^[A-Za-z0-9._~-]{16,512}$")

    fun wellFormed(uri: Uri?): Boolean {
      if (uri == null) return false
      val scheme = uri.scheme?.lowercase()
      val shape = when (scheme) {
        "openbotshell" -> uri.host == "signed-in" && (uri.path.isNullOrEmpty() || uri.path == "/")
        "https" -> uri.host?.lowercase() == "my.open.bot" && uri.path == "/api/auth/shell/callback"
        else -> false
      }
      if (!shape) return false
      val tickets = try { uri.getQueryParameters("ticket") } catch (error: Exception) { emptyList<String>() }
      return tickets.size == 1 && TICKET.matches(tickets[0])
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val data = intent?.data
    if (pending && wellFormed(data)) {
      val forward = packageManager.getLaunchIntentForPackage(packageName)
      if (forward != null) {
        forward.action = Intent.ACTION_VIEW
        forward.data = data
        forward.removeCategory(Intent.CATEGORY_LAUNCHER)
        forward.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        startActivity(forward)
      }
    }
    finish()
  }
}
