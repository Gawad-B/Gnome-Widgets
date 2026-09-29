// Resolves an MPRIS track's art URL to a local file path: `file://` URLs are handed back as-is
// (once checked to be a regular file), `https://` ones are fetched once and cached under
// ~/.cache/desk-widgets/art. Owned by MediaService, recreated on every start() and destroyed on
// stop() so no fetch ever outlives the service that asked for it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { artCacheName, pruneList } from '../core/media.ts';
import { deleteFile, ensureDirectory, isCancelled, isRegularFile, replaceBytes } from './gio-file.ts';

const KEEP = 50;
const IDLE_TIMEOUT_S = 10;
// A cover image has no business being this large; a server that claims (or turns out to have
// sent) more than this is treated as not usable art rather than filling the cache with it.
const MAX_ART_BYTES = 5 * 1024 * 1024;
// Soup's own `timeout` only bounds gaps between bytes actually arriving (an idle timeout), not
// the request as a whole — a slow-but-steady trickle would otherwise never time out at all.
const OVERALL_TIMEOUT_S = 20;

// Fetches the full response body, bounded three ways: a Content-Length over MAX_ART_BYTES aborts
// as soon as the headers say so (before reading any of the body); a running total over
// MAX_ART_BYTES aborts mid-stream even when no Content-Length was given at all (chunked
// transfer-encoding, or a server that simply lies about it); and an overall timeout aborts a
// request that's technically still making idle-timeout-avoiding progress but never finishes.
function sendAndRead(session: Soup.Session, message: Soup.Message, cancellable: Gio.Cancellable): Promise<GLib.Bytes> {
  return new Promise((resolve, reject) => {
    const headersHandler = message.connect('got-headers', () => {
      const contentLength = message.get_response_headers().get_one('Content-Length');
      const length = contentLength !== null ? Number(contentLength) : NaN;
      if (Number.isFinite(length) && length > MAX_ART_BYTES)
        cancellable.cancel();
    });
    let received = 0;
    // GJS passes the emitting message first, then the chunk size.
    const bodyDataHandler = message.connect('got-body-data', (...args: unknown[]) => {
      received += typeof args[1] === 'number' ? args[1] : 0;
      if (received > MAX_ART_BYTES)
        cancellable.cancel();
    });
    let timedOut = false;
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, OVERALL_TIMEOUT_S, () => {
      timedOut = true;
      cancellable.cancel();
      return GLib.SOURCE_REMOVE;
    });
    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (source, res) => {
      message.disconnect(headersHandler);
      message.disconnect(bodyDataHandler);
      // A source that already fired removed itself; removing it again would be an error.
      if (!timedOut)
        GLib.Source.remove(timeoutId);
      try {
        resolve((source as Soup.Session).send_and_read_finish(res));
      } catch (e) {
        reject(e);
      }
    });
  });
}

interface CacheEntry { name: string; mtime: number }

// Lists the cache directory's children with their mtimes, a page at a time. A missing directory
// (nothing has ever been cached) is just an empty list.
function listArt(dir: Gio.File, cancellable: Gio.Cancellable): Promise<CacheEntry[]> {
  return new Promise((resolve, reject) => {
    dir.enumerate_children_async(
      `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_TIME_MODIFIED}`,
      Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable,
      (source, res) => {
        let enumerator: Gio.FileEnumerator;
        try {
          enumerator = (source as Gio.File).enumerate_children_finish(res!);
        } catch (e) {
          if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            resolve([]);
          else
            reject(e);
          return;
        }
        const entries: CacheEntry[] = [];
        const step = (): void => {
          enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable, (source2, res2) => {
            try {
              const infos = (source2 as Gio.FileEnumerator).next_files_finish(res2!);
              if (infos.length === 0) {
                enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                resolve(entries);
                return;
              }
              for (const info of infos) {
                entries.push({
                  name: info.get_name(),
                  mtime: info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED),
                });
              }
              step();
            } catch (e) {
              reject(e);
            }
          });
        };
        step();
      },
    );
  });
}

export class ArtCache {
  private readonly _session = new Soup.Session({ timeout: IDLE_TIMEOUT_S });
  private readonly _cancellable = new Gio.Cancellable();
  private readonly _dir = Gio.File.new_for_path(
    GLib.build_filenamev([GLib.get_user_cache_dir(), 'desk-widgets', 'art']),
  );

  // Resolves `url` to a local path, or null when it isn't usable art (empty, an unsupported
  // scheme, a missing or non-regular file:// target, or a failed/oversized/empty fetch).
  // `cancellable` is the caller's own — MediaService cancels it when the URL it was resolving
  // for goes stale.
  async resolve(url: string, cancellable: Gio.Cancellable): Promise<string | null> {
    if (url.startsWith('file://')) {
      const file = Gio.File.new_for_uri(url);
      const path = file.get_path();
      if (!path)
        return null;
      return (await isRegularFile(file, cancellable)) ? path : null;
    }
    if (!url.startsWith('https://'))
      return null;

    const cacheFile = this._dir.get_child(artCacheName(url));
    if (await isRegularFile(cacheFile, cancellable))
      return cacheFile.get_path();

    const message = Soup.Message.new('GET', url);
    if (!message)
      return null;
    const bytes = await sendAndRead(this._session, message, cancellable);
    // Soup follows redirects, so the final URI can differ from the request: keep it https-only.
    if (message.get_status() !== 200 || message.get_uri().get_scheme() !== 'https')
      return null;
    const data = bytes.get_data();
    if (!data || data.length === 0 || data.length > MAX_ART_BYTES)
      return null;

    await ensureDirectory(this._dir, cancellable);
    await replaceBytes(cacheFile, data, cancellable);
    void this._prune();
    return cacheFile.get_path();
  }

  private async _prune(): Promise<void> {
    try {
      const files = await listArt(this._dir, this._cancellable);
      const stale = pruneList(files, KEEP);
      await Promise.all(stale.map(f => deleteFile(this._dir.get_child(f.name), this._cancellable)));
    } catch (e) {
      if (!isCancelled(e))
        console.error('Desk Widgets: art cache pruning failed', e);
    }
  }

  // Aborting the session fails every in-flight send_and_read_async immediately (whichever
  // cancellable each caller passed in), and cancelling this cache's own cancellable stops a
  // pruning pass that's still enumerating or deleting.
  destroy(): void {
    this._cancellable.cancel();
    this._session.abort();
  }
}
