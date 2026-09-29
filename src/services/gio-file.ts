// Small async Gio.File wrappers shared by services that persist to disk: TaskStore
// (tasks.json) and ArtCache (the cached album art). Each uses the explicit callback (or, for
// move/copy, closure) form: GJS still requires that explicit ready-callback argument for these
// methods at runtime even where the TypeScript types also advertise a Promise-returning
// overload, so this file never relies on the Promise form.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const isCancelled = (e: unknown): boolean =>
  e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
export const isNotFound = (e: unknown): boolean =>
  e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
export const isExists = (e: unknown): boolean =>
  e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS);

export function loadText(file: Gio.File, cancellable: Gio.Cancellable): Promise<string> {
  return new Promise((resolve, reject) => {
    file.load_contents_async(cancellable, (source, res) => {
      try {
        const [, bytes] = (source as Gio.File).load_contents_finish(res!);
        resolve(decoder.decode(bytes));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function replaceBytes(file: Gio.File, bytes: Uint8Array, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve, reject) => {
    file.replace_contents_bytes_async(
      bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable,
      (source, res) => {
        try {
          (source as Gio.File).replace_contents_finish(res!);
          resolve();
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

export function replaceText(file: Gio.File, text: string, cancellable: Gio.Cancellable): Promise<void> {
  return replaceBytes(file, encoder.encode(text), cancellable);
}

export function deleteFile(file: Gio.File, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve, reject) => {
    file.delete_async(GLib.PRIORITY_DEFAULT, cancellable, (source, res) => {
      try {
        (source as Gio.File).delete_finish(res!);
        resolve();
      } catch (e) {
        if (isNotFound(e))
          resolve();
        else
          reject(e);
      }
    });
  });
}

// The move_async closures overload is what GJS actually exposes at runtime for a plain
// function argument in the ready-callback position, the same as the callback forms above.
export function moveFile(file: Gio.File, destination: Gio.File, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve, reject) => {
    file.move_async(destination, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, null,
      (source, res) => {
        try {
          (source as Gio.File).move_finish(res!);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
  });
}

// Same closures-based signature as moveFile, for a backup path that can't rename the original
// away (e.g. it's on a different filesystem, or the rename itself is refused) but can still
// leave a safe copy of it elsewhere before anything overwrites it.
export function copyFile(file: Gio.File, destination: Gio.File, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve, reject) => {
    file.copy_async(destination, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, null,
      (source, res) => {
        try {
          (source as Gio.File).copy_finish(res!);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
  });
}

// True only for a regular file (not a directory, not a special file). A directory sitting at a
// cache path, or a file:// art URL pointing at one, must never be treated as usable art.
export function isRegularFile(file: Gio.File, cancellable: Gio.Cancellable): Promise<boolean> {
  return new Promise((resolve, reject) => {
    file.query_info_async(
      Gio.FILE_ATTRIBUTE_STANDARD_TYPE, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable,
      (source, res) => {
        try {
          const info = (source as Gio.File).query_info_finish(res!);
          resolve(info.get_file_type() === Gio.FileType.REGULAR);
        } catch (e) {
          if (isNotFound(e))
            resolve(false);
          else
            reject(e);
        }
      },
    );
  });
}

function makeDirectory(dir: Gio.File, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve, reject) => {
    dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, (source, res) => {
      try {
        (source as Gio.File).make_directory_finish(res!);
        resolve();
      } catch (e) {
        if (isExists(e))
          resolve();
        else
          reject(e);
      }
    });
  });
}

// Creates `dir`, walking up to its parents (each ignoring EXISTS) whenever the immediate
// attempt fails with NOT_FOUND.
export async function ensureDirectory(dir: Gio.File, cancellable: Gio.Cancellable): Promise<void> {
  try {
    await makeDirectory(dir, cancellable);
  } catch (e) {
    if (!isNotFound(e))
      throw e;
    const parent = dir.get_parent();
    if (!parent)
      throw e;
    await ensureDirectory(parent, cancellable);
    await makeDirectory(dir, cancellable);
  }
}
