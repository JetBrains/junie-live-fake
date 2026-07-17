#!/usr/bin/env bash
# Supervised, bounded run loop for the Yana sandbox inside a GitHub Actions job.
#
# Runs `yana --env-file <env> --agent <agent> yana.yaml` in the foreground for a
# total time budget (YANA_RUN_DURATION_SECONDS). If the yana process exits before
# the budget elapses (crash or clean stop), the stack is torn down and the run is
# restarted until the budget is exhausted. Continuous operation across hours is
# achieved by the caller workflow's hourly schedule.
#
# Required environment:
#   YANA_AGENT                 - agent name
#   YANA_ENV_FILE              - path to the generated .env file
#   YANA_RUN_DURATION_SECONDS  - total time budget in seconds
#   YANA_WORKING_DIRECTORY     - dir containing yana.yaml (and .yana/<agent>/)
#   YANA_LOG_DIR               - dir for the per-run yana log files (artifact)

set -euo pipefail

AGENT="${YANA_AGENT:?YANA_AGENT is required}"
ENV_FILE="${YANA_ENV_FILE:?YANA_ENV_FILE is required}"
DURATION="${YANA_RUN_DURATION_SECONDS:-3600}"
WORKDIR="${YANA_WORKING_DIRECTORY:-.}"
BACKOFF_SECONDS="${YANA_RESTART_BACKOFF_SECONDS:-5}"
LOG_DIR="${YANA_LOG_DIR:-${RUNNER_TEMP:-/tmp}/yana-logs}"

mkdir -p "$LOG_DIR"

cd "$WORKDIR"

log() { printf '[yana-sandbox] %s\n' "$*"; }

down() {
  log "Tearing down the sandbox stack..."
  yana --env-file "$ENV_FILE" --agent "$AGENT" yana.yaml down || \
    log "WARN: 'yana ... down' returned non-zero (continuing)."
}

deadline=$(( $(date +%s) + DURATION ))
log "Starting supervised sandbox: agent='${AGENT}', budget=${DURATION}s (deadline epoch ${deadline})."

# --- Cancellation / timeout signal forwarding ---------------------------------------
# On cancel or job-level timeout, GitHub sends SIGINT to ONLY the step's top-level
# process (this script — it is the step's entry process thanks to the `exec` in
# action.yml), then SIGTERM 7.5s later, then SIGKILL ~2.5s after that. yana runs its
# agent-state snapshot on a clean stop (SIGINT/SIGTERM), but bash does NOT relay signals
# to a child it is `wait`-ing on — so without this trap, yana would never see the signal
# and would be SIGKILLed with no snapshot. We therefore run yana in the BACKGROUND, keep
# its PID, and forward the signal from the trap. (GNU `timeout` relays the forwarded
# signal on to yana.) NOTE: a full snapshot can exceed GitHub's ~10s kill window on
# cancel; periodic checkpoints — state.checkpoint_interval_seconds in agent.yaml — are
# the cancel-safe net, and the end-of-budget path below (timeout -s INT) gives yana the
# full grace it needs.
cancelled=0
yana_pid=""

forward_signal() {
  cancelled=1
  if [ -n "$yana_pid" ]; then
    log "Cancellation/timeout signal received — forwarding SIGINT to yana (pid ${yana_pid}) so it can snapshot agent state before shutdown."
    kill -INT "$yana_pid" 2>/dev/null || true
  fi
}
trap forward_signal INT TERM

attempt=0
while :; do
  now=$(date +%s)
  remaining=$(( deadline - now ))
  if [ "$remaining" -le 0 ] || [ "$cancelled" -eq 1 ]; then
    log "Time budget exhausted (or run cancelled); stopping."
    break
  fi

  attempt=$(( attempt + 1 ))
  # Per-run yana log file at a known absolute path: passed to the CLI via
  # --log-file. yana also streams to stdout (visible live in the job log), and
  # this file is uploaded as an artifact so users can download the full log.
  log_file="$(printf '%s/yana-run-%03d.log' "$LOG_DIR" "$attempt")"
  log "Run #${attempt}: launching yana for up to ${remaining}s. Log: ${log_file}"

  # Run under `timeout` for the per-run budget. `timeout -s INT` makes the END-OF-BUDGET
  # path send SIGINT to yana directly (yana then snapshots and exits; timeout reports
  # 124). Backgrounded so the trap above can run while yana is alive.
  rc=0
  timeout -s INT "${remaining}s" \
    yana --log-file "$log_file" --env-file "$ENV_FILE" --agent "$AGENT" yana.yaml &
  yana_pid=$!

  # `wait` is interrupted by a trapped signal (the trap relays it to yana); loop until
  # yana has actually exited so its shutdown snapshot can finish. `if wait` keeps this
  # safe under `set -e` (a non-zero child exit must not abort the supervisor).
  while kill -0 "$yana_pid" 2>/dev/null; do
    if wait "$yana_pid"; then rc=0; else rc=$?; fi
  done
  yana_pid=""

  if [ "$cancelled" -eq 1 ]; then
    log "Run #${attempt} interrupted by cancellation/timeout (exit ${rc}); yana was signalled to snapshot before shutdown."
    break
  fi

  now=$(date +%s)
  if [ "$now" -ge "$deadline" ] || [ "$rc" -eq 124 ]; then
    # rc 124 = the per-run budget elapsed (timeout sent SIGINT; yana snapshotted).
    log "Run #${attempt} reached the time budget (exit ${rc})."
    break
  fi

  log "Run #${attempt} exited early (exit ${rc}) with $(( deadline - now ))s remaining; restarting."
  down
  sleep "$BACKOFF_SECONDS"
done

down
log "Sandbox supervisor finished cleanly."
exit 0
