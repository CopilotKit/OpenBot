#!/bin/sh
# The secret the API presents to the browser beside it.
#
# Both processes live in this container and the browser's port is not published, so nobody outside
# can present anything. What this defends is somebody publishing 4100 anyway, and the browser
# refuses to start without it regardless.
#
# Generated rather than required, because an operator should not have to invent a shared secret for
# two processes they cannot address separately. Set COMPUTER_TOKEN yourself and this leaves it be.
set -eu
if [ -z "${COMPUTER_TOKEN:-}" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' \
    > /run/s6/container_environment/COMPUTER_TOKEN
fi
