// Evaluates JavaScript inside the dev shell through org.gnome.Shell.Eval and prints the
// JSON-encoded result. Exits 1 when evaluation throws or unsafe mode is off.
//   gjs -m tools/shell-eval.js '<js expression>'
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [code] = system.programArgs;
if (!code) {
  printerr('usage: gjs -m tools/shell-eval.js <js expression>');
  system.exit(2);
}

const reply = Gio.DBus.session.call_sync(
  'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
  new GLib.Variant('(s)', [code]), new GLib.VariantType('(bs)'),
  Gio.DBusCallFlags.NONE, 10_000, null);
const [ok, result] = reply.deepUnpack();
print(result);
system.exit(ok ? 0 : 1);
