package ai.openbot.shell

/**
 * What system Back (and predictive back) does while signed in, kept apart from Android so the JVM
 * tests cover it.
 *
 * The web app keeps one navigation stack per tab and says in each `route` message whether the
 * current tab's stack is deeper than its root (`canGoBack`). Then Back is a command to the page
 * (`openbot:back`), and at a root the app lets the system leave, with the predictive back-to-home
 * preview. A page whose last `route` had no `canGoBack` (production today, or no bridge) keeps the
 * WebView's own history, within the app's guards (never another site's page, /sign or /api/).
 */
object BackPolicy {
    enum class Action { CLOSE_KEYBOARD, PAGE_BACK, WEBVIEW_HISTORY, LEAVE_APP }

    fun decide(keyboardUp: Boolean, pageCanGoBack: Boolean?, historyCanGoBack: Boolean): Action = when {
        keyboardUp -> Action.CLOSE_KEYBOARD
        pageCanGoBack == true -> Action.PAGE_BACK
        pageCanGoBack == false -> Action.LEAVE_APP
        historyCanGoBack -> Action.WEBVIEW_HISTORY
        else -> Action.LEAVE_APP
    }

    /** The app's back callback is on unless Back should leave: then the system's default runs. */
    fun handles(action: Action): Boolean = action != Action.LEAVE_APP
}
