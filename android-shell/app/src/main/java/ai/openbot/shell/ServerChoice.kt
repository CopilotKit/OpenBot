package ai.openbot.shell

import android.content.Context

/**
 * The self-hosted OpenBot a person chose instead of OpenBot Cloud: its origin, kept in
 * SharedPreferences (it is not a secret). It survives sign-out and relaunch. Unset: OpenBot Cloud.
 */
object ServerChoice {
    private const val FILE = "openbot.server"
    private const val ORIGIN = "origin"
    private const val OPEN_FIELD = "open_field"

    fun saved(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(ORIGIN, null)
            ?.let { Origins.of(it)?.toString() }

    fun save(context: Context, origin: String?) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().apply {
            if (origin == null) remove(ORIGIN) else putString(ORIGIN, origin)
        }.commit()
    }

    /** The first screen opens with the address field shown once (the lock screen's Change address). */
    fun requestOpenField(context: Context, open: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(OPEN_FIELD, open).commit()
    }

    fun takeOpenField(context: Context): Boolean {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val open = prefs.getBoolean(OPEN_FIELD, false)
        if (open) prefs.edit().putBoolean(OPEN_FIELD, false).commit()
        return open
    }

    fun clear(context: Context) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().commit()
    }
}
