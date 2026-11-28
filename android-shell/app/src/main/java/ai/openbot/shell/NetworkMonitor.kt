package ai.openbot.shell

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/**
 * Whether the device has a network, from ConnectivityManager's default-network callback. Reports
 * on the main thread.
 *
 * Offline means no default network, or one without the INTERNET capability. A network Android has
 * not VALIDATED (its connectivity check to Google failed) does not lock the app by itself: a private
 * deployment reachable only inside a VPC or a corporate network fails that check while OpenBot is
 * perfectly reachable. Whether OpenBot answers is decided by the loads themselves (load failures
 * and the watchdog lock the app). VALIDATED is recorded in diagnostics.
 *
 * Debug hooks: forceOffline reports offline for good; forceOfflineSeconds for that many seconds.
 */
class NetworkMonitor(context: Context, private val diagnostics: Diagnostics) {
    var onChange: ((offline: Boolean) -> Unit)? = null
    var lastReason = ""
        private set

    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var hasNetwork = true
    private var forcedForever = false
    private var forcedUntilTimer = false
    private var reported: Boolean? = null
    private var registered = false

    val isOffline: Boolean get() = forcedForever || forcedUntilTimer || !hasNetwork

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post {
                hasNetwork = true
                publish("available")
            }
        }

        override fun onLost(network: Network) {
            main.post {
                hasNetwork = false
                publish("lost")
            }
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            val internet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            main.post {
                if (validated != lastValidated) {
                    lastValidated = validated
                    diagnostics.log("network-capabilities", mapOf("internet" to internet, "validated" to validated))
                }
                hasNetwork = internet
                publish("capabilities")
            }
        }
    }
    private var lastValidated: Boolean? = null

    fun start(forceOffline: Boolean, forceOfflineSeconds: Long?) {
        forcedForever = forceOffline
        if (forceOfflineSeconds != null) {
            forcedUntilTimer = true
            main.postDelayed({
                forcedUntilTimer = false
                publish("forced-offline-ended")
            }, forceOfflineSeconds * 1000)
        }
        val active = connectivity?.activeNetwork
        val capabilities = active?.let { connectivity?.getNetworkCapabilities(it) }
        hasNetwork = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        try {
            connectivity?.registerDefaultNetworkCallback(callback)
            registered = true
        } catch (error: RuntimeException) {
            diagnostics.log("network-callback-failed", mapOf("error" to error.javaClass.simpleName))
        }
        publish("start")
    }

    fun stop() {
        if (registered) {
            try {
                connectivity?.unregisterNetworkCallback(callback)
            } catch (error: RuntimeException) {
                // Already gone.
            }
            registered = false
        }
        main.removeCallbacksAndMessages(null)
        onChange = null
    }

    private fun publish(reason: String) {
        val offline = isOffline
        if (offline == reported) return
        reported = offline
        lastReason = reason
        onChange?.invoke(offline)
    }
}
