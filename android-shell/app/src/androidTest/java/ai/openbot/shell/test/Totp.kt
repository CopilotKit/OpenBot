package ai.openbot.shell.test

import android.os.SystemClock
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** RFC 6238 time-based one-time codes (HMAC-SHA1, 30 s step, 6 digits). Never printed. */
object Totp {
    private const val STEP = 30L

    /** RFC 4648 base32 (case-insensitive; spaces, dashes and padding ignored). */
    fun base32Decode(text: String): ByteArray? {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var buffer = 0L
        var bits = 0
        val out = mutableListOf<Byte>()
        for (char in text.uppercase()) {
            if (char == '=' || char == ' ' || char == '-') continue
            val value = alphabet.indexOf(char)
            if (value < 0) return null
            buffer = (buffer shl 5) or value.toLong()
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out.add(((buffer shr bits) and 0xFF).toByte())
            }
        }
        return if (out.isEmpty()) null else out.toByteArray()
    }

    fun code(secret: ByteArray, epochSeconds: Long): String {
        var counter = epochSeconds / STEP
        val message = ByteArray(8)
        for (i in 7 downTo 0) {
            message[i] = (counter and 0xFF).toByte()
            counter = counter shr 8
        }
        val mac = Mac.getInstance("HmacSHA1")
        mac.init(SecretKeySpec(secret, "HmacSHA1"))
        val hash = mac.doFinal(message)
        val offset = hash[hash.size - 1].toInt() and 0x0F
        val value = ((hash[offset].toInt() and 0x7F) shl 24) or
            ((hash[offset + 1].toInt() and 0xFF) shl 16) or
            ((hash[offset + 2].toInt() and 0xFF) shl 8) or
            (hash[offset + 3].toInt() and 0xFF)
        return String.format(java.util.Locale.US, "%06d", value % 1_000_000)
    }

    /** A code with at least 5 seconds of its step left: waits for the next step when needed. */
    fun freshCode(secret: ByteArray): String {
        var now = System.currentTimeMillis() / 1000
        val remaining = STEP - now % STEP
        if (remaining < 5) {
            SystemClock.sleep((remaining + 1) * 1000)
            now = System.currentTimeMillis() / 1000
        }
        return code(secret, now)
    }
}
