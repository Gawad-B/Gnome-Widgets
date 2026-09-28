import GLib from 'gi://GLib';

// Shared by every calendar file (widget, popup, and their sub-modules): a `Date` as a
// `GLib.DateTime` in the local timezone, for `%`-style formatting. Not weather.ts's own helper -
// that one takes a unix-seconds number, not a `Date`.
export const localDate = (d: Date): GLib.DateTime => GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000));
