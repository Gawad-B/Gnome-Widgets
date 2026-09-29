// Direct org.mpris.MediaPlayer2.Player property reads over D-Bus: Position and Metadata, which
// MprisPlayer itself never exposes (the Shell's own notification message has no use for a value
// that changes every second, or for track length). Kept separate from services/media.ts so that
// file stays about the active-player state machine, not D-Bus plumbing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

// GVariant's 'v' (variant) boxes don't auto-unwrap through deepUnpack() at every level the way a
// DBusProxy's cached properties do, so this recurses until nothing GLib.Variant-shaped is left.
// Metadata (a{sv}) is the case that actually needs more than one level.
function fullyUnpack(value: unknown): unknown {
  if (value instanceof GLib.Variant)
    return fullyUnpack(value.deepUnpack());
  if (Array.isArray(value))
    return value.map(fullyUnpack);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      out[key] = fullyUnpack(entry);
    return out;
  }
  return value;
}

// The 6-argument callback form: the typings expose a Promise-returning overload for this method,
// but it doesn't exist at runtime — GJS still requires the callback argument.
export function getPlayerProperty(busName: string, prop: string, cancellable: Gio.Cancellable): Promise<unknown> {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(
      busName, OBJECT_PATH, PROPERTIES_IFACE, 'Get',
      new GLib.Variant('(ss)', [PLAYER_IFACE, prop]), GLib.VariantType.new('(v)'),
      Gio.DBusCallFlags.NONE, -1, cancellable,
      (source, res) => {
        try {
          const result = (source as Gio.DBusConnection).call_finish(res!);
          const [boxed] = result.deepUnpack<[GLib.Variant]>();
          resolve(fullyUnpack(boxed));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}
