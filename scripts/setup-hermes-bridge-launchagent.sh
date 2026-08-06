#!/bin/zsh
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-hermes-bridge-launchagent.sh [--dry-run] [--load]

Creates a persistent macOS LaunchAgent for the local Hermes bridge.

Options:
  --dry-run   Print the generated files without writing them
  --load      Reload the LaunchAgent after writing files
  -h, --help  Show this help text
EOF
}

DRY_RUN=0
LOAD_AGENT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --load)
      LOAD_AGENT=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PI_HOME="${PI_HOME:-$HOME/.pi}"
STATE_ROOT="${PI_HERMES_BRIDGE_STATE_ROOT:-$PI_HOME/hermes-bridge-state}"
TOKEN_FILE="${PI_HERMES_BRIDGE_TOKEN_FILE:-$PI_HOME/hermes-bridge-token}"
RUN_SCRIPT="${PI_HERMES_BRIDGE_RUN_SCRIPT:-$PI_HOME/run-hermes-bridge.sh}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="${PI_HERMES_BRIDGE_PLIST:-$LAUNCH_AGENTS_DIR/ai.pi.hermes-bridge.plist}"
BRIDGE_HOST="${PI_HERMES_BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${PI_HERMES_BRIDGE_PORT:-8787}"
LOG_PATH="${PI_HERMES_BRIDGE_LOG:-$PI_HOME/hermes-bridge.log}"
ERR_LOG_PATH="${PI_HERMES_BRIDGE_ERR_LOG:-$PI_HOME/hermes-bridge.err.log}"

if [[ -n "${PI_HERMES_BINARY:-}" ]]; then
  HERMES_BIN="$PI_HERMES_BINARY"
elif command -v hermes >/dev/null 2>&1; then
  HERMES_BIN="$(command -v hermes)"
else
  HERMES_BIN="$HOME/.local/bin/hermes"
fi

if [[ ! -x "$HERMES_BIN" && $DRY_RUN -ne 1 ]]; then
  echo "Hermes binary not found or not executable: $HERMES_BIN" >&2
  exit 1
fi

mkdir_cmds() {
  cat <<EOF
mkdir -p "$PI_HOME"
mkdir -p "$STATE_ROOT"
mkdir -p "$LAUNCH_AGENTS_DIR"
EOF
}

generate_token() {
  python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
}

if [[ -f "$TOKEN_FILE" ]]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  TOKEN="$(generate_token)"
fi

RUN_SCRIPT_CONTENT=$(cat <<EOF
#!/bin/zsh
set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PI_HERMES_BRIDGE_TOKEN="\$(/bin/cat $TOKEN_FILE)"

cd $REPO_ROOT
exec npm run hermes:bridge -- --host $BRIDGE_HOST --port $BRIDGE_PORT --state-root $STATE_ROOT
EOF
)

PLIST_CONTENT=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.pi.hermes-bridge</string>

  <key>ProgramArguments</key>
  <array>
    <string>$RUN_SCRIPT</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>

  <key>StandardErrorPath</key>
  <string>$ERR_LOG_PATH</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF
)

if [[ $DRY_RUN -eq 1 ]]; then
  echo "# directories"
  mkdir_cmds
  echo
  echo "# token file: $TOKEN_FILE"
  # Never print the token itself: --dry-run output lands in terminals and
  # logs, and when the token file already exists this would leak the live
  # bearer token guarding the bridge.
  if [[ -f "$TOKEN_FILE" ]]; then
    echo "(existing token redacted)"
  else
    echo "(new token will be generated)"
  fi
  echo
  echo "# run script: $RUN_SCRIPT"
  echo "$RUN_SCRIPT_CONTENT"
  echo
  echo "# plist: $PLIST_PATH"
  echo "$PLIST_CONTENT"
  exit 0
fi

mkdir -p "$PI_HOME" "$STATE_ROOT" "$LAUNCH_AGENTS_DIR"
umask 077
printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
printf '%s\n' "$RUN_SCRIPT_CONTENT" > "$RUN_SCRIPT"
chmod 700 "$RUN_SCRIPT"
printf '%s\n' "$PLIST_CONTENT" > "$PLIST_PATH"

echo "Wrote token: $TOKEN_FILE"
echo "Wrote run script: $RUN_SCRIPT"
echo "Wrote LaunchAgent: $PLIST_PATH"
echo "Bridge URL: http://$BRIDGE_HOST:$BRIDGE_PORT"
echo "State root: $STATE_ROOT"
echo "Hermes binary: $HERMES_BIN"

if [[ $LOAD_AGENT -eq 1 ]]; then
  launchctl bootout "gui/$UID" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$PLIST_PATH"
  echo "Loaded LaunchAgent: ai.pi.hermes-bridge"
else
  cat <<EOF

To load the bridge now:
launchctl bootout gui/\$UID "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap gui/\$UID "$PLIST_PATH"

To inspect it:
launchctl print gui/\$UID/ai.pi.hermes-bridge
EOF
fi
