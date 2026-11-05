#!/usr/bin/env bash
# Put Apple's Developer ID G2 intermediate into a signing keychain, once.
#
# A Developer ID certificate does not chain to a root a fresh macOS runner trusts without this
# intermediate, and codesign then reports the far less obvious "unable to build chain to
# self-signed root". A .p12 exported with its chain already carries the intermediate, and importing
# it a second time fails with "The specified item already exists in the keychain", which stopped the
# first real signing run before it signed anything. So it is imported only when the keychain does not
# hold it yet, matched by its SHA-1 fingerprint, and running this again is harmless.
#
# Usage: import-developer-id-intermediate.sh <keychain>
set -euo pipefail

keychain="${1:?usage: import-developer-id-intermediate.sh <keychain>}"
intermediate="$(mktemp -t DeveloperIDG2CA).cer"
trap 'rm -f "$intermediate"' EXIT

curl -fsSL --retry 3 https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o "$intermediate"
sha1="$(openssl x509 -inform der -in "$intermediate" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')"

if security find-certificate -a -Z "$keychain" | grep -qi "SHA-1 hash: $sha1"; then
  echo "The Developer ID G2 intermediate is already in the keychain."
else
  security import "$intermediate" -k "$keychain"
fi
