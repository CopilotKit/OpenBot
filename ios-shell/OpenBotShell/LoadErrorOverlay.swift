import SwiftUI

/// Connected, but OpenBot did not answer: says so, with Try again.
struct LoadErrorOverlay: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.icloud")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("OpenBot couldn't load")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
                .tint(Color(uiColor: .label))
                .foregroundColor(Color(uiColor: .systemBackground))
                .accessibilityIdentifier("retry-button")
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}
