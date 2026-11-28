import SwiftUI

/// Covers the whole app while the device has no connection or the web app did not load (`reason`:
/// "no-network" or "load-failed"). Lifts by itself; Try again retries at once.
struct OfflineLockScreen: View {
    let reason: String
    let retry: () -> Void

    static let heading = "No internet connection"
    static let message = "For security purposes, this application can only be used when connected to the internet. Please connect to the internet to continue."

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(OfflineLockScreen.heading)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(OfflineLockScreen.message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: retry) {
                Text("Try again")
                    .font(.headline)
                    .padding(.horizontal, 28)
                    .frame(height: 48)
                    .foregroundColor(Color(uiColor: .systemBackground))
                    .background(Color(uiColor: .label), in: Capsule())
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
            .accessibilityIdentifier("retry-button")
        }
        .padding(32)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        // Swallows every touch: nothing under the lock is reachable.
        .contentShape(Rectangle())
        .onTapGesture {}
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("offline-lock")
        .accessibilityValue(reason)
    }
}
