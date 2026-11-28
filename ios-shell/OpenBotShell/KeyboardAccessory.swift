import ObjectiveC
import UIKit
import WebKit

/// Removes the form-assistant bar WKWebView puts above the software keyboard (the bar with the up
/// and down arrows and the check mark), the way react-native-webview's hideKeyboardAccessoryView and
/// the Ionic keyboard plugin do: the web view's internal content view gets a subclass whose
/// `inputAccessoryView` is nil.
///
/// The trade-off: it relies on WebKit's private content view (a class whose name starts with
/// "WKContent"), which a future iOS may rename or draw differently. When the class is not found
/// nothing changes and the bar stays; it never crashes. Without the check mark the keyboard goes
/// away by dragging the page down (`keyboardDismissMode = .interactive`) or tapping outside a field.
/// The system sign-in sheet is Safari's view, not ours: its bar stays.
enum KeyboardAccessory {
    private static let suffix = "_OpenBotNoAccessory"

    /// Idempotent. Returns what happened, for diagnostics.
    @discardableResult
    static func hide(in webView: WKWebView) -> String {
        guard let content = webView.scrollView.subviews.first(where: {
            NSStringFromClass(type(of: $0)).hasPrefix("WKContent")
        }) else {
            return "no-content-view"
        }
        guard let original = object_getClass(content) else { return "no-class" }
        let originalName = NSStringFromClass(original)
        if originalName.hasSuffix(suffix) { return "already" }
        let subclassName = originalName + suffix
        var subclass: AnyClass? = NSClassFromString(subclassName)
        if subclass == nil {
            guard let created = objc_allocateClassPair(original, subclassName, 0) else { return "allocate-failed" }
            let getter: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            let added = class_addMethod(created, #selector(getter: UIResponder.inputAccessoryView),
                                        imp_implementationWithBlock(getter), "@@:")
            objc_registerClassPair(created)
            guard added else { return "add-method-failed" }
            subclass = created
        }
        guard let target = subclass else { return "no-subclass" }
        object_setClass(content, target)
        return "hidden"
    }
}
