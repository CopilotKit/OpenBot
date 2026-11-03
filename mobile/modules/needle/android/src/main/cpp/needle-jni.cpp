// The bridge from Kotlin to Needle's C engine. Four calls, the same ones Needle's own Python
// package makes (needle/__init__.py): load the weights, set the tools, complete, reset.
#include <jni.h>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

extern "C" {
int needle_load(const char *data, uint64_t length);
int needle_init(const char *system, const char *tools_json, const char *tool_index_path);
int needle_complete(const char *text, const float *audio, int audio_length, int max_new_tokens,
                    char *out, int out_length);
void needle_reset(void);
}

#ifdef NEEDLE_MISSING
// Built without Needle's engine: every call says so, and the app carries on without it.
int needle_load(const char *, uint64_t) { return -1; }
int needle_init(const char *, const char *, const char *) { return -1; }
int needle_complete(const char *, const float *, int, int, char *, int) { return -1; }
void needle_reset(void) {}
#endif

namespace {
std::string text(JNIEnv *env, jstring value) {
  if (value == nullptr) return "";
  const char *chars = env->GetStringUTFChars(value, nullptr);
  std::string copy(chars);
  env->ReleaseStringUTFChars(value, chars);
  return copy;
}
}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_needle_NeedleEngine_load(JNIEnv *env, jobject, jbyteArray weights) {
  // Needle sends anonymous usage counts by default. OpenBot never does: switched off before
  // the engine starts.
  setenv("NEEDLE_TELEMETRY", "0", 1);
  setenv("DO_NOT_TRACK", "1", 1);
  // Kept for the life of the app: the engine may read the weights in place rather than copy them.
  static std::vector<char> held;
  const jsize length = env->GetArrayLength(weights);
  held.resize(static_cast<size_t>(length));
  env->GetByteArrayRegion(weights, 0, length, reinterpret_cast<jbyte *>(held.data()));
  return needle_load(held.data(), static_cast<uint64_t>(held.size()));
}

extern "C" JNIEXPORT jint JNICALL
Java_expo_modules_needle_NeedleEngine_setup(JNIEnv *env, jobject, jstring system, jstring tools) {
  const std::string systemText = text(env, system);
  const std::string toolsText = text(env, tools);
  return needle_init(systemText.c_str(), toolsText.c_str(), nullptr);
}

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_needle_NeedleEngine_complete(JNIEnv *env, jobject, jstring input, jint maxTokens) {
  const std::string query = text(env, input);
  std::vector<char> out(65536, 0);
  // One request at a time, each on its own: what one note said never steers the next.
  needle_reset();
  const int result = needle_complete(query.c_str(), nullptr, 0, maxTokens, out.data(),
                                     static_cast<int>(out.size()));
  if (result < 0) {
    return env->NewStringUTF(("{\"error\":" + std::to_string(result) + "}").c_str());
  }
  return env->NewStringUTF(out.data());
}
