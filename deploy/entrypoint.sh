#!/bin/sh
# Container entrypoint: virtual display + dummy audio sink, then exec the app.
# - Xvfb: headful Chromium needs *a* display; capture is in-tab so this is fine.
# - PulseAudio null sink: tab-audio capture needs somewhere to render, or the
#   captured track can come out silent in a container with no sound device.
set -e

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
i=0
while [ $i -lt 50 ] && [ ! -S /tmp/.X11-unix/X99 ]; do sleep 0.1; i=$((i+1)); done
export DISPLAY=:99

export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio -D --exit-idle-time=-1 --disallow-exit
# ONE sink, full stop. Edge/Linux tab-audio capture grabs a monitor source and
# ignores routing overrides (verified the hard way) — so isolation = there is
# nothing else to hear. Debug/test browsers that must play audio should run
# against their own throwaway PulseAudio server (PULSE_SERVER=...) so they can
# never reach this one. See deploy/test-audio-crosstalk.cjs.
pactl load-module module-null-sink sink_name=rec sink_properties=device.description=Recorder >/dev/null
pactl set-default-sink rec
pactl set-default-source rec.monitor
echo "[entrypoint] Xvfb + PulseAudio (single sink: rec) up — starting: $*"

exec "$@"
