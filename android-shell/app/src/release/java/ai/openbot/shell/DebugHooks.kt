package ai.openbot.shell

import android.content.Intent
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity

/** No test hooks in this build: every one is off (the debug build's are in src/debug). */
object DebugHooks {
    @Suppress("UNUSED_PARAMETER")
    fun read(intent: Intent?): HookValues = HookValues()

    @Suppress("UNUSED_PARAMETER")
    fun beforeCreate(activity: AppCompatActivity, hooks: HookValues) {}

    @Suppress("UNUSED_PARAMETER")
    fun stateLabel(root: FrameLayout): ((String) -> Unit)? = null
}
