import SwiftUI

/// Covers the whole app while the device has no connection. Lifts by itself when it comes back.
struct OfflineLockScreen: View {
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
    }
}
