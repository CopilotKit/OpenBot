import CryptoKit
import Foundation

/// RFC 6238 time-based one-time codes (HMAC-SHA1, 30 s step, 6 digits), for test k only.
/// The secret and the codes are never printed.
enum TOTP {
    static let step: TimeInterval = 30

    /// Decodes RFC 4648 base32 (case-insensitive; spaces, dashes and padding ignored).
    static func base32Decode(_ text: String) -> Data? {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var lookup: [Character: UInt32] = [:]
        for (index, char) in alphabet.enumerated() { lookup[char] = UInt32(index) }
        var buffer: UInt32 = 0
        var bits = 0
        var output = Data()
        for char in text.uppercased() where char != "=" && char != " " && char != "-" {
            guard let value = lookup[char] else { return nil }
            buffer = (buffer << 5) | value
            bits += 5
            if bits >= 8 {
                bits -= 8
                output.append(UInt8((buffer >> UInt32(bits)) & 0xFF))
            }
        }
        return output.isEmpty ? nil : output
    }

    static func code(secret: Data, at date: Date) -> String {
        var counter = UInt64(floor(date.timeIntervalSince1970 / step)).bigEndian
        let message = withUnsafeBytes(of: &counter) { Data($0) }
        let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: SymmetricKey(data: secret)))
        let offset = Int(mac[mac.count - 1] & 0x0F)
        let value = (UInt32(mac[offset] & 0x7F) << 24)
            | (UInt32(mac[offset + 1]) << 16)
            | (UInt32(mac[offset + 2]) << 8)
            | UInt32(mac[offset + 3])
        return String(format: "%06u", value % 1_000_000)
    }

    /// A code with at least 8 seconds of its step left: waits for the next step when needed.
    static func freshCode(secret: Data) -> String {
        let remaining = step - Date().timeIntervalSince1970.truncatingRemainder(dividingBy: step)
        if remaining < 8 { Thread.sleep(forTimeInterval: remaining + 0.5) }
        return code(secret: secret, at: Date())
    }
}
