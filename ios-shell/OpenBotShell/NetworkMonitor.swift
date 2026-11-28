import Foundation
import Network

/// Whether the device is connected, from NWPathMonitor. Reports on the main queue.
///
/// DEBUG test hooks: OPENBOT_SHELL_FORCE_OFFLINE=1 reports offline for good;
/// OPENBOT_SHELL_FORCE_OFFLINE_SECONDS=n reports offline for n seconds, then the real network.
final class NetworkMonitor {
    var onChange: ((_ offline: Bool) -> Void)?

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ai.openbot.shell.network")
    private var pathOffline = false
    private var forcedForever = false
    private var forcedUntilTimer = false
    private var reported: Bool?

    var isOffline: Bool { forcedForever || forcedUntilTimer || pathOffline }

    func start(forceOffline: Bool, forceOfflineSeconds: Double?) {
        forcedForever = forceOffline
        if let seconds = forceOfflineSeconds {
            forcedUntilTimer = true
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
                self?.forcedUntilTimer = false
                self?.publish(reason: "forced-offline-ended")
            }
        }
        monitor.pathUpdateHandler = { [weak self] path in
            let offline = path.status != .satisfied
            DispatchQueue.main.async {
                self?.pathOffline = offline
                self?.publish(reason: "path-\(path.status)")
            }
        }
        monitor.start(queue: queue)
        publish(reason: "start")
    }

    private(set) var lastReason = ""

    private func publish(reason: String) {
        let offline = isOffline
        guard offline != reported else { return }
        reported = offline
        lastReason = reason
        onChange?(offline)
    }
}
