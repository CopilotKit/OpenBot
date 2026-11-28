import CryptoKit
import Foundation
import Security

/// A PKCE S256 pair for the sign-in hand-off. The verifier stays in memory and is never logged.
struct PKCEPair {
    /// 43 characters of base64url (32 random bytes).
    let verifier: String
    /// base64url(sha256(verifier)), 43 characters, no padding.
    let challenge: String

    static func make() -> PKCEPair {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // SystemRandomNumberGenerator is cryptographically secure too.
            var generator = SystemRandomNumberGenerator()
            for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255, using: &generator) }
        }
        let verifier = base64url(Data(bytes))
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return PKCEPair(verifier: verifier, challenge: base64url(Data(digest)))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
