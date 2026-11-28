package ai.openbot.shell

import org.json.JSONObject

/**
 * Whether an address is an OpenBot the phone app can use, from its answer to
 * `GET <origin>/api/auth/shell/config?platform=android`. Pure decisions, unit-tested; SignInFlow
 * makes the request (10 s, no cookies, no redirect followed).
 */
object ServerCheck {
    enum class Outcome { OK, TOO_OLD, NOT_FOUND, CERTIFICATE, NO_ANSWER }

    /** What went wrong on the way, when there was no HTTP answer. */
    enum class Failure { DNS, TLS, TIMEOUT, REFUSED, OTHER }

    fun fromAnswer(status: Int, body: String?): Outcome {
        if (status != 200 || body == null) return Outcome.TOO_OLD
        val json = try {
            JSONObject(body)
        } catch (error: Exception) {
            return Outcome.TOO_OLD
        }
        return if (json.has("handoff")) Outcome.OK else Outcome.TOO_OLD
    }

    fun fromFailure(failure: Failure): Outcome = when (failure) {
        Failure.DNS -> Outcome.NOT_FOUND
        Failure.TLS -> Outcome.CERTIFICATE
        Failure.TIMEOUT, Failure.REFUSED, Failure.OTHER -> Outcome.NO_ANSWER
    }

    fun failureOf(error: Throwable): Failure = when (error) {
        is java.net.UnknownHostException -> Failure.DNS
        is javax.net.ssl.SSLException -> Failure.TLS
        is java.security.cert.CertificateException -> Failure.TLS
        is java.net.SocketTimeoutException -> Failure.TIMEOUT
        is java.net.ConnectException -> Failure.REFUSED
        else -> if (error.cause != null && error.cause !== error) failureOf(error.cause!!) else Failure.OTHER
    }
}
