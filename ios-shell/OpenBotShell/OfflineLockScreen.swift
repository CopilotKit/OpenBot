import SwiftUI
import UIKit

/// Covers the whole app while the device has no connection or the web app did not load (`reason`:
/// "no-network" or "load-failed"). Lifts by itself; Try again retries at once.
struct OfflineLockScreen: View {
    static let heading = "Cannot reach the OpenBot backend"
    static let message = "For security purposes, this application can only be used when connected to the OpenBot backend. Please check your internet connection, VPC configuration and network settings to make sure this device can reach the OpenBot backend. Contact your system administrator if you are unable to connect."
    static let supportAddress = "support@open.bot"

    let reason: String
    /// The host the app is trying to reach, as shown to a person.
    var host: String = ""
    /// A self-hosted OpenBot: Change address goes back to the first screen with the address open.
    var changeAddress: (() -> Void)? = nil
    let retry: () -> Void

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 16) {
                    symbol
                        .padding(.bottom, 4)
                        .accessibilityHidden(true)
                    Text(OfflineLockScreen.heading)
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("offline-lock-heading")
                    Text(OfflineLockScreen.message)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("offline-lock-message")
                    if !host.isEmpty {
                        Text("Trying to reach \(host)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("offline-lock-host")
                    }
                    Button(action: retry) {
                        Text("Try again")
                            .font(.headline)
                            .padding(.horizontal, 28)
                            .frame(minHeight: 48)
                            .foregroundColor(Color(uiColor: .systemBackground))
                            .background(Color(uiColor: .label), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                    .accessibilityIdentifier("retry-button")
                    if let changeAddress = changeAddress {
                        Button(action: changeAddress) {
                            Text("Change address")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("change-address")
                    }
                    HStack(spacing: 4) {
                        Text("Need help?")
                            .foregroundStyle(.secondary)
                        Button(action: openSupportMail) {
                            Text(OfflineLockScreen.supportAddress)
                                .underline()
                                .foregroundColor(Color(uiColor: .label))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Email support at \(OfflineLockScreen.supportAddress)")
                        .accessibilityIdentifier("support-email")
                    }
                    .font(.footnote)
                    .padding(.top, 4)
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 40)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        // Swallows every touch: nothing under the lock is reachable.
        .contentShape(Rectangle())
        .onTapGesture {}
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("offline-lock")
        .accessibilityValue(reason)
    }

    private func openSupportMail() {
        guard let url = URL(string: "mailto:\(OfflineLockScreen.supportAddress)") else { return }
        // Without a mail app (the simulator) open answers false and nothing happens.
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    @ViewBuilder
    private var symbol: some View {
        if UIImage(systemName: "network.slash") != nil {
            Image(systemName: "network.slash")
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.secondary)
        } else {
            Image(systemName: "server.rack")
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.secondary)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                        .background(Circle().fill(Color(uiColor: .systemBackground)))
                        .offset(x: 6, y: 6)
                }
        }
    }
}
