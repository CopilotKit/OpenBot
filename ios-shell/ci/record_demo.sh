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
    # simctl normally finishes the MP4 within a few seconds after SIGINT. Keep a
    # stalled encoder from using the rest of the job and hiding XCTest's result.
    for ((tick=0; tick<60; tick++)); do
      kill -0 "$recorder" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$recorder" 2>/dev/null; then
      echo "The simulator recorder did not finish writing its file." >&2
      kill -KILL "$recorder" 2>/dev/null || true
    fi
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
echo "Waiting for XCTest to enter the workbench tour."
for ((tick=0; tick<360; tick++)); do
  [[ ! -f "$signal.ready" ]] && kill -0 "$runner" 2>/dev/null || break
  sleep 0.5
done
if [[ ! -f "$signal.ready" ]] && kill -0 "$runner" 2>/dev/null; then
  echo "XCTest did not enter the workbench tour within three minutes." >&2
  kill -TERM "$runner" 2>/dev/null || true
  exit 1
fi
if [[ -f "$signal.ready" ]]; then
  echo "XCTest is ready. Starting the simulator recorder."
  xcrun simctl io "$device" recordVideo --codec h264 --force artifacts/video/demo-tour.mp4 > artifacts/record.log 2>&1 &
  recorder=$!
  for ((attempt=0; attempt<100; attempt++)); do
    if grep -q 'Recording started' artifacts/record.log; then
      python3 -c 'import time; print("STARTED=" + str(time.time()))' >> "${GITHUB_ENV:?environment file required}"
      touch "$signal.started"
      echo "Simulator recording started."
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
