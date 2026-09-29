import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { copyFile, isCancelled, moveFile } from './gio-file.ts';

function backupTimestamp(): string {
  return GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S') ?? String(Date.now());
}

// Shows the "unreadable and backed up" notification at most once for as long as the Shell
// keeps running, no matter how many times the extension is disabled and re-enabled in between.
let notifiedThisSession = false;

function notifyOnce(): void {
  if (notifiedThisSession)
    return;
  notifiedThisSession = true;
  Main.notify('Desk Widgets', 'The tasks file was unreadable and has been backed up.');
}

// Renames the corrupt file aside so it's never touched again, falling back to a copy (leaving
// the original in place) when the rename itself fails - e.g. a cross-filesystem tasks.json, or
// a permissions quirk on just that one operation. Only reports success, and only notifies, once
// the corrupt content is actually preserved somewhere; a caller that gets false back must not
// start writing a fresh empty list over a file nothing has captured a copy of.
export async function backupCorruptTasksFile(file: Gio.File, cancellable: Gio.Cancellable): Promise<boolean> {
  const backup = Gio.File.new_for_path(`${file.get_path()}.bak-${backupTimestamp()}`);
  try {
    await moveFile(file, backup, cancellable);
  } catch (moveError) {
    if (isCancelled(moveError))
      return false;
    try {
      await copyFile(file, backup, cancellable);
    } catch (copyError) {
      if (!isCancelled(copyError))
        console.error('Desk Widgets: failed to back up the unreadable tasks file', copyError);
      return false;
    }
  }
  notifyOnce();
  return true;
}
