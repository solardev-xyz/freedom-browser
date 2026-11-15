// TEMPORARY diagnostic (removed before review): the OSStatus SecItemDelete
// returns, with user interaction off as the helper has it, in the default
// keychain. `add <account>` or `delete <account>`.
import Foundation
import Security

let args = CommandLine.arguments
let op = args[1]
let account = args[2]
let service = "baby.freedom.diag"
SecKeychainSetUserInteractionAllowed(false)
var status: OSStatus
if op == "add" {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecValueData as String: Data(repeating: 7, count: 32),
  ]
  status = SecItemAdd(query as CFDictionary, nil)
} else {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
  ]
  status = SecItemDelete(query as CFDictionary)
}
let message = (SecCopyErrorMessageString(status, nil) as String?) ?? "?"
print("\(op) \(status) \(message)")
