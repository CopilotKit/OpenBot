package expo.modules.needle

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Needle on the phone. The weights ship inside the app (assets/needle3.cact), so it works the first
 * time with no connection and never downloads anything.
 */
class NeedleModule : Module() {
  private var loaded = false
  private var setUp = ""

  override fun definition() = ModuleDefinition {
    Name("OpenBotNeedle")

    /** Whether this build carries Needle at all. */
    Function("isAvailable") {
      try {
        appContext.reactContext?.assets?.open(WEIGHTS)?.close()
        true
      } catch (_: Exception) {
        false
      }
    }

    /** Reads the weights once, then sets the facts and tools Needle works with. Safe to call before every request. */
    AsyncFunction("prepare") { system: String, toolsJson: String ->
      synchronized(this@NeedleModule) {
        if (!loaded) {
          val assets = appContext.reactContext?.assets ?: throw IllegalStateException("No app context")
          val bytes = assets.open(WEIGHTS).use { it.readBytes() }
          if (NeedleEngine.load(bytes) < 0) throw IllegalStateException("Needle could not load its model")
          loaded = true
        }
        // The system facts carry the time, so they change; setting up again is cheap.
        val wanted = system + "\u0000" + toolsJson
        if (wanted != setUp) {
          if (NeedleEngine.setup(system, toolsJson) < 0) throw IllegalStateException("Needle could not read the tools")
          setUp = wanted
        }
      }
    }

    /** What to do for one request, as Needle's JSON: function_calls, reasoning and confidence. */
    AsyncFunction("complete") { text: String ->
      synchronized(this@NeedleModule) {
        if (!loaded) throw IllegalStateException("Call prepare first")
        NeedleEngine.complete(text, 256)
      }
    }
  }

  companion object {
    private const val WEIGHTS = "needle3.cact"
  }
}
