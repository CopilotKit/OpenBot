import SwiftUI
import UIKit

/// The first screen: native, drawn without the network. While the app decides at launch it shows
/// the name alone; signed out it adds the line and the Sign in button.
struct SignInScreen: View {
    let launching: Bool
    let busy: Bool
    let message: String?
    let signIn: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 12) {
                if let mark = UIImage(named: "OpenBotMark") {
                    Image(uiImage: mark)
                        .resizable()
                        .frame(width: 72, height: 72)
                        .padding(.bottom, 8)
                        .accessibilityHidden(true)
                }
                Text("OpenBot")
                    .font(.system(size: 40, weight: .semibold))
                    .accessibilityAddTraits(.isHeader)
                if !launching {
                    Text("Sign in to talk to your Bots and pick up your conversations.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 32)
            Spacer()
            if !launching {
                VStack(spacing: 12) {
                    if let message = message {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .accessibilityIdentifier("sign-in-message")
                    }
                    Button(action: signIn) {
                        ZStack {
                            Text("Sign in").opacity(busy ? 0 : 1)
                            if busy {
                                ProgressView()
                                    .tint(Color(uiColor: .systemBackground))
                            }
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .foregroundColor(Color(uiColor: .systemBackground))
                        .background(Color(uiColor: .label), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityLabel(busy ? "Signing in" : "Sign in")
                    .accessibilityIdentifier("sign-in-button")
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sign-in-screen")
    }
}
