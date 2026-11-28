package ai.openbot.shell

/**
 * The decisions of one hand-off sign-in, kept apart from Android so the JVM tests cover them.
 *
 * - From the signed-out first screen, the web view's session and site data are cleared, and only
 *   when that has finished is `enter` loaded. The server refuses `enter` when the web view holds
 *   another person's live session, and the web app's /sign would then carry on as that person.
 *   A renewal keeps the session: it is the same person, and the server swaps it.
 * - Once the server's failure page (`/sign?native-sign-in=failed`) has been seen for an `enter`,
 *   that attempt failed, whatever cookie or page follows.
 * - A callback does not use up the sign-in: the PKCE verifier stays until an `enter` succeeds or
 *   the person cancels, so a well-formed fake ticket from another app cannot spend it. A failed
 *   `enter` goes back to waiting for the real callback, at most [MAX_CALLBACKS] times.
 */
class SignInAttempt(val renewal: Boolean) {
    enum class Step { CLEAR_SESSION, LOAD_ENTER }

    enum class AfterFailure { WAIT_FOR_CALLBACK, GIVE_UP }

    var callbacks = 0
        private set
    var entering = false
        private set
    var failurePageSeen = false
        private set

    /** What runs before `enter`, in order; each step starts when the one before it has finished. */
    fun stepsForEnter(): List<Step> =
        if (renewal) listOf(Step.LOAD_ENTER) else listOf(Step.CLEAR_SESSION, Step.LOAD_ENTER)

    /** A well-formed callback arrived. False: ignore it (an `enter` is running, or too many). */
    fun acceptCallback(): Boolean {
        if (entering || callbacks >= MAX_CALLBACKS) return false
        callbacks += 1
        entering = true
        failurePageSeen = false
        return true
    }

    /** A main-frame address of the app's own origin, while `enter` runs. */
    fun onOwnPage(path: String, query: String?) {
        if (!entering) return
        if (isFailurePage(path, query)) failurePageSeen = true
    }

    /** Whether the session cookie (or the page saying "signed in") may finish this sign-in. */
    fun mayFinish(): Boolean = entering && !failurePageSeen

    /** The `enter` of the current callback failed. */
    fun enterFailed(): AfterFailure {
        entering = false
        return if (!renewal && callbacks < MAX_CALLBACKS) AfterFailure.WAIT_FOR_CALLBACK else AfterFailure.GIVE_UP
    }

    companion object {
        const val MAX_CALLBACKS = 3

        fun isFailurePage(path: String, query: String?): Boolean =
            (path == "/sign" || path.startsWith("/sign/")) &&
                (query ?: "").split("&").any { it == "native-sign-in=failed" }
    }
}
