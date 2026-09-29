// Minimal typings for the parts of libsoup 3 this extension uses (only what ArtCache calls).
// Split into its own file, with no top-level import of its own, because TypeScript only lets a
// file introduce a brand-new ambient module (as opposed to augmenting one) while the file itself
// has no top-level import/export — exactly how @girs' own leaf `*-ambient.d.ts` files are shaped
// (see e.g. node_modules/@girs/gio-2.0/gio-2.0-ambient.d.ts). ambient.d.ts pulls this in the
// same way it pulls in those.
declare module 'gi://Soup?version=3.0' {
  import type Gio from 'gi://Gio';
  import type GLib from 'gi://GLib';

  namespace Soup {
    class Session {
      constructor(props?: { timeout?: number });
      timeout: number;
      send_and_read_async(
        message: Message,
        io_priority: number,
        cancellable: Gio.Cancellable | null,
        callback: (source: Session | null, result: Gio.AsyncResult) => void,
      ): void;
      send_and_read_finish(result: Gio.AsyncResult): GLib.Bytes;
      abort(): void;
    }

    class MessageHeaders {
      get_one(name: string): string | null;
    }

    class Message {
      static new(method: string, uri: string): Message | null;
      get_status(): number;
      get_uri(): { get_scheme(): string };
      get_response_headers(): MessageHeaders;
      // Standard GObject signal connection, narrowed to the two signals ArtCache listens for:
      // 'got-headers' (response headers have arrived, before the body is read) and
      // 'got-body-data' (fired per chunk of the body as it streams in, with that chunk's size).
      connect(signal: string, callback: (...args: unknown[]) => void): number;
      disconnect(handler_id: number): void;
    }
  }

  export default Soup;
}
