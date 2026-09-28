// Adds one VEVENT to the isolated dev shell's built-in local calendar, through EDataServer/ECal.
// Standalone test tooling only - never run outside the dev shell's isolated environment (see
// `tools/devshell.sh add-event`, the only supported entry point), and never imported by, or
// copied into, extension code: synchronous EDS calls are fine here but forbidden in the Shell.
//
//   tools/devshell.sh add-event "<summary>" <start-iso> <end-iso>
//
// start-iso/end-iso are either "YYYY-MM-DD" (an all-day event, DATE-only) or a local
// "YYYY-MM-DDTHH:MM:SS" (no zone suffix: a floating time, i.e. plain local wall-clock time).
import GLib from 'gi://GLib';
import system from 'system';

// Hard guard, checked before any EDS module is even loaded (the EDataServer/ECal/ICalGLib
// imports below are dynamic, gated behind this, specifically so a failing guard never touches
// them at all): refuses unless this process is unmistakably running inside
// `tools/devshell.sh`'s isolated environment - never the real session's calendar. Both of
// devshell.sh's `use_env` markers must hold: XDG_RUNTIME_DIR is the isolated run dir it exports,
// and the session bus address in the environment is exactly the one devshell.sh wrote to
// .devshell/bus for that same isolated shell (not some other, unrelated bus this process might
// have inherited).
function isolatedDevShellEnv() {
  const runtimeDir = GLib.getenv('XDG_RUNTIME_DIR');
  if (!runtimeDir || !runtimeDir.endsWith('/.devshell/run'))
    return false;
  let busFileContents;
  try {
    const [, contents] = GLib.file_get_contents(`${runtimeDir}/../bus`);
    busFileContents = new TextDecoder().decode(contents).trim();
  } catch {
    return false;
  }
  return (GLib.getenv('DBUS_SESSION_BUS_ADDRESS') ?? '') === busFileContents;
}

if (!isolatedDevShellEnv()) {
  printerr('refusing: not running inside the dev shell (use tools/devshell.sh add-event "<summary>" <start-iso> <end-iso>)');
  system.exit(1);
}

const [summary, startIso, endIso] = system.programArgs;
if (!summary || !startIso || !endIso) {
  printerr('usage: tools/devshell.sh add-event "<summary>" <start-iso> <end-iso>');
  system.exit(2);
}

const { default: ECal } = await import('gi://ECal?version=2.0');
const { default: EDataServer } = await import('gi://EDataServer?version=1.2');
const { default: ICalGLib } = await import('gi://ICalGLib?version=3.0');

// A DATE-only icaltime for an all-day boundary, or a floating (no timezone) one for a timed
// boundary - either way, plain local wall-clock fields, matching what calendar-math's isAllDay()
// and the Shell's own event source both expect.
function icalTime(iso) {
  const isDateOnly = !iso.includes('T');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()))
    throw new Error(`invalid date/time: ${iso}`);
  const time = ICalGLib.Time.new_null_time();
  if (isDateOnly) {
    // The Date constructor parses a bare "YYYY-MM-DD" as UTC midnight; read the UTC fields back
    // so the calendar day is the one that was actually typed, not shifted by the local zone.
    time.set_date(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    time.set_is_date(true);
  } else {
    time.set_date(date.getFullYear(), date.getMonth() + 1, date.getDate());
    time.set_time(date.getHours(), date.getMinutes(), date.getSeconds());
  }
  return time;
}

const registry = EDataServer.SourceRegistry.new_sync(null);
const source = registry.ref_builtin_calendar();
const client = ECal.Client.connect_sync(source, ECal.ClientSourceType.EVENTS, 30, null);

const component = ICalGLib.Component.new_vevent();
component.set_summary(summary);
component.set_dtstart(icalTime(startIso));
component.set_dtend(icalTime(endIso));

// create_object_sync's out-param (the new uid) comes back as gjs's usual [ok, ...outs] array.
const [, uid] = client.create_object_sync(component, ECal.OperationFlags.NONE, null);
print(uid);

// SourceRegistry's C dispose() synchronously pumps the main context to settle its background
// D-Bus watches; done from a normal call here, that is fine, but left for the garbage collector
// to trigger during interpreter shutdown, that same pump reenters mid-GC-sweep and segfaults
// (confirmed via coredumpctl: source_registry_dispose -> g_main_context_iteration during
// gjs's ObjectInstance sweep finalization). Disposing explicitly, and only the registry, avoids
// that: `client` has no such issue and is left for the normal exit-time GC.
registry.run_dispose();
