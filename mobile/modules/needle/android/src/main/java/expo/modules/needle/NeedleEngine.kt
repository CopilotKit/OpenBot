package expo.modules.needle

/** Needle's engine, through needle-jni.cpp. Only one model is held at a time, as the engine allows. */
internal object NeedleEngine {
  init {
    System.loadLibrary("openbotneedle")
  }

  external fun load(weights: ByteArray): Int
  external fun setup(system: String, tools: String): Int
  external fun complete(text: String, maxTokens: Int): String
}
