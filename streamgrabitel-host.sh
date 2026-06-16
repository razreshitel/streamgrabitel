#!/usr/bin/env sh
# Launcher Chrome/Edge/Chromium invokes as the native messaging host on
# macOS/Linux. Runs the Node host, inheriting stdin/stdout for the message
# framing. Requires Node.js on PATH.
exec node "$(dirname "$0")/src/native-host/host.js"
