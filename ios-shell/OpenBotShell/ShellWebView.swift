import UIKit
import WebKit

/// A zero-height input accessory keeps WebKit's form controls out of the shell's keyboard.
final class ShellWebView: WKWebView {
    private let emptyAccessory = UIView(frame: .zero)

    override var inputAccessoryView: UIView? { emptyAccessory }
}
