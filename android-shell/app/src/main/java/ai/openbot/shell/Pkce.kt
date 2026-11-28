package ai.openbot.shell

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** A PKCE S256 pair for the sign-in hand-off. The verifier stays in memory and is never logged. */
class PkcePair(val verifier: String, val challenge: String) {
    override fun toString(): String = "PkcePair(redacted)"

    companion object {
        /** 32 random bytes as 43 characters of base64url; the challenge is base64url(sha256(verifier)). */
        fun make(random: SecureRandom = SecureRandom()): PkcePair {
            val bytes = ByteArray(32)
            random.nextBytes(bytes)
            val verifier = base64url(bytes)
            return PkcePair(verifier, challengeFor(verifier))
        }

        fun challengeFor(verifier: String): String =
            base64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

        fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

/**
 * The sign-in this app started and is waiting to finish: the only one whose callback it accepts.
 * In memory only: if Android ends the process while the Custom Tab is open, the callback that
 * arrives later is ignored and the person signs in again.
 */
object PendingSignIn {
    private const val MAX_AGE_MS = 10 * 60 * 1000L

    var pair: PkcePair? = null
        private set
    var mode: HandoffMode? = null
        private set
    var returnTo: String = "/"
        private set
    private var startedAt = 0L

    fun begin(pair: PkcePair, mode: HandoffMode, returnTo: String) {
        this.pair = pair
        this.mode = mode
        this.returnTo = returnTo
        startedAt = System.currentTimeMillis()
    }

    fun isWaiting(): Boolean = pair != null && System.currentTimeMillis() - startedAt < MAX_AGE_MS

    fun clear() {
        pair = null
        mode = null
        returnTo = "/"
        startedAt = 0L
    }
}
