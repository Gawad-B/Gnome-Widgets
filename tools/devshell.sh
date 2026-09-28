#!/usr/bin/env bash
# Isolated GNOME Shell for development and automated checks. Its session bus, dconf, XDG dirs
# (config/data/cache/state) and runtime dir all live under .devshell/, so the real session's
# desktop, extensions, and settings are never touched by anything this script does.
#
# System-bus services - logind, polkit, NetworkManager, and the like - are the real machine's:
# shared with every other session, since there is only one system bus. Never lock the nested
# shell: it grabs real input like any GNOME Shell, and nothing here can unlock it for you.
#
#   tools/devshell.sh start [--devkit]    (re)start with dist/ installed; headless unless --devkit
#   tools/devshell.sh status              extension state as JSON ({"state":1} = ACTIVE)
#   tools/devshell.sh eval '<js>'         evaluate JS in the shell, print the JSON result
#   tools/devshell.sh shot <file.png>     screenshot of the desktop (overview hidden first)
#   tools/devshell.sh gsettings <args>    gsettings against the isolated dconf
#   tools/devshell.sh app <cmd> [args]    launch an app window inside the shell
#   tools/devshell.sh add-event "<summary>" <start-iso> <end-iso>
#                                          add a test event to the isolated session's calendar
#   tools/devshell.sh log                 print the shell log
#   tools/devshell.sh stop                stop the shell and its bus
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.devshell"
UUID='desk-widgets@gawad-b.github.io'
HELPER='testhelper@desk-widgets.local'
REAL_RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
REAL_WAYLAND="${WAYLAND_DISPLAY:-wayland-0}"

require_running() {
  [[ -f "$STATE/bus" ]] || { echo 'dev shell not running (run tools/devshell.sh start)' >&2; exit 1; }
}

use_env() {
  export XDG_CONFIG_HOME="$STATE/config" XDG_DATA_HOME="$STATE/data"
  export XDG_CACHE_HOME="$STATE/cache" XDG_STATE_HOME="$STATE/state"
  export XDG_RUNTIME_DIR="$STATE/run"
  # WAYLAND_DISPLAY/DISPLAY: never let the isolated shell (or anything it spawns, including a
  # D-Bus-activated service) pick up the real session's display. GDK_BACKEND: some outer
  # environments force this (e.g. an Electron-based caller pinning GTK to x11 for its own
  # embedded views), and an inherited `x11` would make every GTK child here - including a
  # D-Bus-activated one whose activation environment doesn't otherwise carry it - refuse to even
  # try the nested Wayland compositor this shell actually provides.
  unset WAYLAND_DISPLAY DISPLAY GDK_BACKEND
  if [[ -f "$STATE/bus" ]]; then
    DBUS_SESSION_BUS_ADDRESS="$(cat "$STATE/bus")"
    export DBUS_SESSION_BUS_ADDRESS
  else
    # No isolated bus (stopped, or never started): never let a caller inherit the real session bus.
    export DBUS_SESSION_BUS_ADDRESS='disabled:'
  fi
}

shell_eval() { gjs -m "$ROOT/tools/shell-eval.js" "$1"; }

status_js="(() => { const e = Main.extensionManager.lookup('$UUID'); return e ? { state: e.state, error: e.error || null } : null; })()"

# True only if $1 is a process this harness started: its environment carries the
# XDG_RUNTIME_DIR we launched it with. An unreadable or missing /proc entry is "not ours".
is_ours() {
  local pid="$1" env_file="/proc/$1/environ"
  [[ -n "$pid" && -r "$env_file" ]] || return 1
  tr '\0' '\n' < "$env_file" 2>/dev/null | grep -qxF "XDG_RUNTIME_DIR=$STATE/run"
}

# Unmounts anything under $STATE/run (gvfsd-fuse's `gvfs`, the document portal's `doc`, etc.)
# before anything ever `rm -rf`s through it: GNU rm crosses filesystem boundaries, so deleting
# through a live FUSE mount would recurse into and unlink whatever it exposes (real host files,
# in the `doc` portal's case), not just the isolated runtime dir. Only paths under $STATE/run
# are ever touched. Bounded retry (~5s), then refuses rather than deleting through a mount still
# up.
unmount_run() {
  local mnt tries
  for tries in $(seq 1 20); do
    # Unmount anything under run/ (deepest first) instead of deleting through it.
    while IFS= read -r mnt; do
      fusermount3 -u "$mnt" 2>/dev/null || fusermount -u "$mnt" 2>/dev/null || true
    done < <(findmnt -rn -o TARGET | awk -v p="$STATE/run/" 'index($0,p)==1' | sort -r)
    findmnt -rn -o TARGET | awk -v p="$STATE/run/" 'index($0,p)==1' | grep -q . || return 0
    sleep 0.25
  done
  echo "stop: a mount is still active under $STATE/run; refusing to remove it" >&2
  return 1
}

cmd_stop() {
  local f pid n
  for f in shell.pid dbus.pid; do
    if [[ -f "$STATE/$f" ]]; then
      pid="$(cat "$STATE/$f" 2>/dev/null || true)"
      if is_ours "$pid"; then
        kill "$pid" 2>/dev/null || true
        # Wait for it to actually exit before touching $STATE/run: gvfsd-fuse, auto-spawned by
        # GVfs clients in this session (not gnome-shell itself), holds a FUSE mount under the
        # runtime dir that only unwinds once the session it was spawned for (this dbus-daemon,
        # or gnome-shell) is gone.
        for n in $(seq 1 40); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.25
        done
      fi
      rm -f "$STATE/$f"
    fi
  done
  rm -f "$STATE/bus"
  unmount_run
  rm -rf --one-file-system "$STATE/run"
}

cmd_start() {
  local mode="${1:-}"
  cmd_stop
  [[ -f "$ROOT/dist/metadata.json" ]] || { echo 'dist/ missing: run make build' >&2; exit 1; }
  # Fresh extension copies and runtime dir every start; dconf (config/) persists across restarts.
  unmount_run
  rm -rf --one-file-system "$STATE/data" "$STATE/run"
  mkdir -p "$STATE"/{config,data,cache,state,run}
  chmod 700 "$STATE/run"
  local ext="$STATE/data/gnome-shell/extensions"
  mkdir -p "$ext"
  cp -r "$ROOT/dist" "$ext/$UUID"
  cp -r "$ROOT/tools/testhelper" "$ext/$HELPER"

  use_env
  dbus-daemon --session --fork --print-address=3 --print-pid=4 3>"$STATE/bus" 4>"$STATE/dbus.pid"
  use_env
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
  gsettings set org.gnome.shell enabled-extensions "['$HELPER', '$UUID']"

  if [[ "$mode" == --devkit ]]; then
    # The devkit viewer receives the nested shell's frames over PipeWire, whose socket lives
    # in the real runtime dir. PIPEWIRE_RUNTIME_DIR points only PipeWire there; everything
    # else keeps the isolated XDG_RUNTIME_DIR.
    WAYLAND_DISPLAY="$REAL_RUNTIME/$REAL_WAYLAND" PIPEWIRE_RUNTIME_DIR="$REAL_RUNTIME" \
      setsid gnome-shell --wayland --no-x11 --devkit >"$STATE/shell.log" 2>&1 &
  else
    setsid gnome-shell --wayland --no-x11 --headless --virtual-monitor 1920x1080 \
      >"$STATE/shell.log" 2>&1 &
  fi
  echo $! >"$STATE/shell.pid"

  local i ready=
  for i in $(seq 1 60); do
    if shell_eval '1' >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [[ -z "$ready" ]]; then
    echo "shell did not become ready; see $STATE/shell.log" >&2
    # Don't leave the bus, gvfsd-fuse or portal mounts behind a failed start.
    cmd_stop || true
    exit 1
  fi
  shell_eval 'Main.overview.hide()' >/dev/null

  # Registers this session's isolated XDG dirs and its nested Wayland socket with the isolated
  # D-Bus daemon's own activation environment (use_env's DBUS_SESSION_BUS_ADDRESS, exported
  # above, points dbus-update-activation-environment at it), so anything the isolated bus
  # D-Bus-activates - a portal helper, an extension's own prefs window - inherits them instead
  # of an empty environment. Explicit NAME=VALUE pairs only: never `--systemd` (would push this
  # into the systemd --user manager's environment, visible to every other unit on the real
  # session) and never `--all` (would republish this whole isolated shell's environment,
  # which can carry secrets, onto the bus).
  if [[ -f "$STATE/bus" ]]; then
    local sock
    sock="$(cd "$STATE/run" && ls wayland-* 2>/dev/null | grep -v '\.lock$' | head -1)"
    if [[ -n "$sock" ]]; then
      dbus-update-activation-environment \
        "WAYLAND_DISPLAY=$sock" \
        "XDG_RUNTIME_DIR=$STATE/run" \
        "XDG_CONFIG_HOME=$STATE/config" \
        "XDG_DATA_HOME=$STATE/data" \
        "XDG_CACHE_HOME=$STATE/cache" \
        "XDG_STATE_HOME=$STATE/state"
    fi
  fi

  # Wait for the desk-widgets extension to reach a terminal state (anything but INITIALIZED(6),
  # ACTIVATING(8), or a not-yet-registered null) so `start` doesn't race the extension's own
  # enable(), bounded to ~10s.
  local status state
  for i in $(seq 1 20); do
    status="$(shell_eval "$status_js" 2>/dev/null || echo null)"
    if [[ "$status" =~ \"state\":(-?[0-9]+) ]]; then
      state="${BASH_REMATCH[1]}"
    else
      state=null
    fi
    case "$state" in
      6|8|null) sleep 0.5 ;;
      *) break ;;
    esac
  done

  echo "shell ready; extension: $status"
  [[ "$state" == 1 ]]
}

cmd_shot() {
  local out
  out="$(realpath -m "$1")"
  shell_eval 'Main.overview.hide()' >/dev/null
  sleep 1
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false "$out" >/dev/null
  echo "$out"
}

cmd_app() {
  local sock
  sock="$(cd "$STATE/run" && ls wayland-* 2>/dev/null | grep -v '\.lock$' | head -1)"
  [[ -n "$sock" ]] || { echo 'no wayland socket: is the shell running?' >&2; exit 1; }
  WAYLAND_DISPLAY="$sock" GDK_BACKEND=wayland setsid "$@" >>"$STATE/apps.log" 2>&1 &
}

sub="${1:-}"
shift || true
case "$sub" in
  start) cmd_start "$@" ;;
  stop) cmd_stop ;;
  status) require_running; use_env; shell_eval "$status_js" ;;
  eval) require_running; use_env; shell_eval "$1" ;;
  shot) require_running; use_env; cmd_shot "$1" ;;
  gsettings) require_running; use_env; gsettings --schemadir "$STATE/data/gnome-shell/extensions/$UUID/schemas" "$@" ;;
  app) require_running; use_env; cmd_app "$@" ;;
  add-event) require_running; use_env; gjs -m "$ROOT/tools/add-test-event.js" "$@" ;;
  log) cat "$STATE/shell.log" ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
