#!/usr/bin/env bash
# Start capture when XCTest reaches the workbench tour. Simulator setup and test teardown
# can take longer than the tour on a hosted Mac.
set -eu
device="${1:?simulator ID required}"
tests="${2:?built xctestrun required}"
signal_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/openbot-tour.XXXXXX")"
signal="$signal_dir/tour"
export TEST_RUNNER_OPENBOT_SHELL_RECORDING_SIGNAL="$signal"
mkdir -p artifacts/video
recorder=''
runner=''
stop_recording() {
  if [[ -n "$recorder" ]]; then
    kill -INT "$recorder" 2>/dev/null || true
    wait "$recorder" || true
    recorder=''
  fi
}
cancel() {
  [[ -z "$runner" ]] || kill -TERM "$runner" 2>/dev/null || true
  stop_recording
  exit 130
}
trap cancel INT TERM

xcodebuild test-without-building -xctestrun "$tests" -destination "platform=iOS Simulator,id=$device" \
  -parallel-testing-enabled NO -only-testing:OpenBotShellUITests/DemoTourUITests/testDemoTour > xcodebuild-demo.log 2>&1 &
runner=$!
while [[ ! -f "$signal.ready" ]] && kill -0 "$runner" 2>/dev/null; do sleep 0.5; done
if [[ -f "$signal.ready" ]]; then
  xcrun simctl io "$device" recordVideo --codec h264 --force artifacts/video/demo-tour.mp4 > artifacts/record.log 2>&1 &
  recorder=$!
  for ((attempt=0; attempt<100; attempt++)); do
    if grep -q 'Recording started' artifacts/record.log; then
      python3 -c 'import time; print("STARTED=" + str(time.time()))' >> "${GITHUB_ENV:?environment file required}"
      touch "$signal.started"
      break
    fi
    kill -0 "$recorder" 2>/dev/null || break
    sleep 0.2
  done
  while [[ -f "$signal.started" && ! -f "$signal.done" ]] && kill -0 "$runner" 2>/dev/null; do sleep 0.5; done
fi
stop_recording
status=0
wait "$runner" || status=$?
grep -E 'Test Case|error:|SHELL_NOTE' xcodebuild-demo.log || true
[[ -f "$signal.started" ]] || exit 1
exit "$status"
