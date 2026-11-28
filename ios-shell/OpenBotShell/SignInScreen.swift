import SwiftUI
import UIKit

/// The first screen: native, drawn without the network. While the app decides at launch it shows
/// the name alone; signed out it adds the line and the Sign in button, and under it a quiet way to
/// sign in to a self-hosted OpenBot instead of OpenBot Cloud (the same wording as the Android app).
struct SignInScreen: View {
    @ObservedObject var model: AppModel
    let launching: Bool
    let busy: Bool
    let message: String?
    let signIn: () -> Void
    let chooseServer: (String) -> Void
    let useCloud: () -> Void
    let openAddress: () -> Void
    let cancelAddress: () -> Void

    @FocusState private var addressFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 24)
                    header
                    Spacer(minLength: 24)
                    if !launching {
                        if model.addressOpen { addressForm } else { actions }
                    }
                }
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.addressOpen)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sign-in-screen")
        .onChange(of: model.addressOpen) { open in addressFocused = open }
        .onAppear { if model.addressOpen { addressFocused = true } }
    }

    private var header: some View {
        VStack(spacing: 12) {
            // The mark and the line step aside while the address field is open, so the field and
            // its buttons stay above the keyboard.
            if !model.addressOpen, let mark = UIImage(named: "OpenBotMark") {
                Image(uiImage: mark)
                    .resizable()
                    .frame(width: 72, height: 72)
                    .padding(.bottom, 8)
                    .accessibilityHidden(true)
            }
            Text("OpenBot")
                .font(.system(size: 40, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            if !launching && !model.addressOpen {
                Text("Sign in to talk to your Bots and pick up your conversations.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 32)
    }

    private var actions: some View {
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
            if model.selfHosted {
                Text("Signs in to \(model.serverHost)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("server-host")
                quiet("Use OpenBot Cloud", id: "use-cloud", action: useCloud)
            } else {
                quiet("Or sign in to a self-hosted OpenBot", id: "self-hosted-toggle", action: openAddress)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
    }

    private var addressForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your OpenBot's address")
                .font(.subheadline.weight(.medium))
            TextField("openbot.example.com", text: $model.addressText)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .submitLabel(.go)
                .onSubmit { chooseServer(model.addressText) }
                .focused($addressFocused)
                .disabled(model.addressChecking)
                .padding(.horizontal, 12)
                .frame(height: 48)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(uiColor: .separator)))
                .accessibilityIdentifier("server-address")
                .onChange(of: model.addressText) { _ in model.addressError = nil }
            if let error = model.addressError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Color(uiColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("server-address-error")
            }
            HStack {
                quiet("Cancel", id: "server-address-cancel", action: cancelAddress)
                    .disabled(model.addressChecking)
                Spacer()
                Button(action: { chooseServer(model.addressText) }) {
                    Text(model.addressChecking ? "Checking" : "Continue")
                        .font(.headline)
                        .padding(.horizontal, 24)
                        .frame(height: 48)
                        .foregroundColor(Color(uiColor: .systemBackground))
                        .background(Color(uiColor: .label), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(model.addressChecking)
                .accessibilityIdentifier("server-address-continue")
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
    }

    /// A quiet text button with a 44 pt tall touch area.
    private func quiet(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}
