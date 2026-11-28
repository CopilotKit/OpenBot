import SwiftUI

/// Shown over the web view while a page has not drawn yet: neutral shapes that read as the app (a
/// title line, the message box, a few rows), with a soft highlight sweeping left to right. With
/// Reduce Motion on, the shapes pulse gently instead. Nothing from the network.
struct LoadingSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1
    @State private var pulse = false

    var body: some View {
        shapes
            .overlay(highlight.mask(shapes))
            .opacity(reduceMotion ? (pulse ? 0.55 : 1) : 1)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color(uiColor: .systemBackground))
            .onAppear {
                if reduceMotion {
                    withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) { pulse = true }
                } else {
                    phase = -1
                    withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) { phase = 1 }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading")
            .accessibilityIdentifier("loading-skeleton")
    }

    private var fill: Color { Color(uiColor: .secondarySystemFill) }

    private var shapes: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                RoundedRectangle(cornerRadius: 6).fill(fill).frame(width: 150, height: 22)
                Spacer()
                Circle().fill(fill).frame(width: 32, height: 32)
            }
            .padding(.top, 24)
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(fill)
                .frame(height: 120)
                .padding(.top, 40)
            VStack(alignment: .leading, spacing: 22) {
                row(first: 0.55, second: 0.8)
                row(first: 0.4, second: 0.65)
                row(first: 0.6, second: 0.75)
                row(first: 0.35, second: 0.55)
            }
            .padding(.top, 36)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
    }

    private func row(first: CGFloat, second: CGFloat) -> some View {
        HStack(spacing: 14) {
            Circle().fill(fill).frame(width: 36, height: 36)
            GeometryReader { geometry in
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 4).fill(fill).frame(width: geometry.size.width * first, height: 12)
                    RoundedRectangle(cornerRadius: 4).fill(fill).frame(width: geometry.size.width * second, height: 10)
                }
            }
            .frame(height: 30)
        }
    }

    /// A soft band of light, moved across the whole width by `phase` (-1 to 1).
    private var highlight: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            LinearGradient(
                colors: [.clear, Color(uiColor: .systemBackground).opacity(0.6), .clear],
                startPoint: .leading, endPoint: .trailing
            )
            .frame(width: width * 0.6)
            .offset(x: phase * width * 1.3 + width * 0.2)
        }
        .allowsHitTesting(false)
        .opacity(reduceMotion ? 0 : 1)
    }
}
