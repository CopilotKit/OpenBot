import SwiftUI
import UIKit
import WebKit

/// The whole app: the web view, edge to edge, and a native overlay when a page fails to load.
struct ShellView: View {
    @StateObject private var controller = WebController()

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            WebView(controller: controller)
                .ignoresSafeArea()
            if let message = controller.errorMessage {
                ErrorOverlay(message: message) { controller.retry() }
                    .ignoresSafeArea()
            }
        }
        .onAppear {
            // The window shows through before the first paint: keep it the system background so
            // dark mode does not flash white.
            for scene in UIApplication.shared.connectedScenes {
                guard let windowScene = scene as? UIWindowScene else { continue }
                for window in windowScene.windows {
                    window.backgroundColor = .systemBackground
                }
            }
            controller.start()
        }
    }
}

struct WebView: UIViewRepresentable {
    let controller: WebController

    func makeUIView(context: Context) -> WKWebView {
        controller.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct ErrorOverlay: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("OpenBot could not load")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("retry-button")
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}
