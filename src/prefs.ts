import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const THEME_MODES = ['system', 'light', 'dark'];
const THEME_LABELS = ['Follow System', 'Light', 'Dark'];
const DIM_MODES = ['automatic', 'always', 'never'];
const DIM_LABELS = ['Automatically', 'Always', 'Never'];

export default class DeskWidgetsPrefs extends ExtensionPreferences {
  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    // getSettings() returns a fresh Gio.Settings, and the prefs process can outlive this
    // window (idle timeout, or another D-Bus client holding it open). Every settings.connect()
    // below is collected here and disconnected on close, so a later `changed::*` signal never
    // reaches a disposed row.
    const handlerIds: number[] = [];
    window.add(appearancePage(settings, handlerIds));
    window.add(generalPage(settings, window, handlerIds));
    window.connect('close-request', () => {
      for (const id of handlerIds)
        settings.disconnect(id);
      return false;
    });
  }
}

function appearancePage(settings: Gio.Settings, handlerIds: number[]): Adw.PreferencesPage {
  const page = new Adw.PreferencesPage({ title: 'Appearance', icon_name: 'applications-graphics-symbolic' });
  const group = new Adw.PreferencesGroup({ title: 'Widgets' });
  group.add(comboRow(settings, 'theme-mode', 'Style', THEME_MODES, THEME_LABELS, handlerIds));
  group.add(translucencyRow(settings, handlerIds));
  group.add(comboRow(settings, 'dim-mode', 'Dim widgets', DIM_MODES, DIM_LABELS, handlerIds,
    'Fade widgets while a window is focused'));
  group.add(intSpinRow(settings, 'grid-gap', 'Grid spacing', 8, 64, 2, handlerIds));
  group.add(switchRow(settings, 'glass', 'Glass effect', 'Blur the wallpaper behind widgets', handlerIds));
  page.add(group);
  return page;
}

function generalPage(settings: Gio.Settings, window: Adw.PreferencesWindow, handlerIds: number[]): Adw.PreferencesPage {
  const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'preferences-system-symbolic' });

  const editing = new Adw.PreferencesGroup({ title: 'Editing' });
  editing.add(shortcutRow(settings, handlerIds));
  page.add(editing);

  const layout = new Adw.PreferencesGroup({ title: 'Layout' });
  const reset = new Adw.ButtonRow({ title: 'Reset Layout…' });
  reset.add_css_class('destructive-action');
  reset.connect('activated', () => confirmReset(settings, window));
  layout.add(reset);
  page.add(layout);

  const data = new Adw.PreferencesGroup({ title: 'Reminders' });
  data.add(tasksFileRow(window));
  page.add(data);
  return page;
}

// Opens GLib.get_user_data_dir()/desk-widgets (creating it first if it doesn't exist yet - fine
// here, since prefs isn't Shell code and never runs on the compositor's own async-only path) in
// the desktop's default file manager.
function tasksFileRow(window: Adw.PreferencesWindow): Adw.ButtonRow {
  const row = new Adw.ButtonRow({ title: 'Open tasks file location' });
  row.connect('activated', () => {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'desk-widgets']);
    GLib.mkdir_with_parents(dir, 0o755);
    // A launch context (rather than null) lets the launched app's window open on the same
    // workspace/monitor and get proper startup-notification focus, instead of the fallback
    // behavior an unspecified context falls back to.
    const context = window.get_display().get_app_launch_context();
    Gio.AppInfo.launch_default_for_uri_async(GLib.filename_to_uri(dir, null), context, null, (_source, result) => {
      try {
        Gio.AppInfo.launch_default_for_uri_finish(result!);
      } catch (e) {
        console.error('Desk Widgets: failed to open the tasks folder', e);
      }
    });
  });
  return row;
}

// Enum settings stored as strings, shown as a combo row.
function comboRow(
  settings: Gio.Settings, key: string, title: string, values: string[], labels: string[], handlerIds: number[],
  subtitle = '',
): Adw.ComboRow {
  const row = new Adw.ComboRow({ title, subtitle, model: Gtk.StringList.new(labels) });
  const sync = () => {
    row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
  };
  sync();
  row.connect('notify::selected', () => {
    const value = values[row.selected];
    if (value !== undefined && value !== settings.get_string(key))
      settings.set_string(key, value);
  });
  handlerIds.push(settings.connect(`changed::${key}`, sync));
  return row;
}

function translucencyRow(settings: Gio.Settings, handlerIds: number[]): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: 'Translucency', subtitle: 'From solid cards to fully clear' });
  const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 5);
  scale.set_value(settings.get_int('translucency'));
  scale.set_draw_value(true);
  scale.set_hexpand(true);
  scale.set_size_request(220, -1);
  scale.set_valign(Gtk.Align.CENTER);
  scale.connect('value-changed', () => {
    const value = Math.round(scale.get_value());
    if (value !== settings.get_int('translucency'))
      settings.set_int('translucency', value);
  });
  handlerIds.push(settings.connect('changed::translucency', () => scale.set_value(settings.get_int('translucency'))));
  row.add_suffix(scale);
  return row;
}

function switchRow(
  settings: Gio.Settings, key: string, title: string, subtitle: string, handlerIds: number[],
): Adw.SwitchRow {
  const row = new Adw.SwitchRow({ title, subtitle, active: settings.get_boolean(key) });
  row.connect('notify::active', () => {
    if (row.active !== settings.get_boolean(key))
      settings.set_boolean(key, row.active);
  });
  handlerIds.push(settings.connect(`changed::${key}`, () => {
    row.active = settings.get_boolean(key);
  }));
  return row;
}

function intSpinRow(
  settings: Gio.Settings, key: string, title: string, min: number, max: number, step: number, handlerIds: number[],
): Adw.SpinRow {
  const row = Adw.SpinRow.new_with_range(min, max, step);
  row.title = title;
  row.value = settings.get_int(key);
  row.connect('notify::value', () => {
    const value = Math.round(row.value);
    if (value !== settings.get_int(key))
      settings.set_int(key, value);
  });
  handlerIds.push(settings.connect(`changed::${key}`, () => {
    row.value = settings.get_int(key);
  }));
  return row;
}

// GDK_KEY_F1..GDK_KEY_F24: the one class of accelerator that is legitimately bare (no
// modifier), since a function key is never a stray printable character being typed.
function isFunctionKey(key: number): boolean {
  return key >= Gdk.KEY_F1 && key <= Gdk.KEY_F24;
}

// Accelerator typed as text (e.g. <Super><Alt>w); invalid input, and anything without a
// modifier other than a function key, is flagged and not saved. On success the row is
// normalized to what Gtk.accelerator_name renders (fixed case, canonical modifier order).
function shortcutRow(settings: Gio.Settings, handlerIds: number[]): Adw.EntryRow {
  const row = new Adw.EntryRow({ title: 'Edit mode shortcut', show_apply_button: true });
  const sync = () => {
    row.text = settings.get_strv('edit-shortcut')[0] ?? '';
  };
  sync();
  row.connect('apply', () => {
    const text = row.text.trim();
    const [ok, key, rawMods] = Gtk.accelerator_parse(text);
    const mods = rawMods ?? 0;
    // A modifier set of Shift alone is still effectively bare: Shift+a is just "A", a printable
    // character someone can type by accident, not a deliberate accelerator. Requiring a
    // non-Shift modifier (Control/Alt/Super/...) - or a function key, which is never a stray
    // printable - rules that out while still accepting <Shift> combined with anything else.
    if (ok && key !== 0 && ((mods & ~Gdk.ModifierType.SHIFT_MASK) !== 0 || isFunctionKey(key))) {
      const normalized = Gtk.accelerator_name(key, mods);
      row.remove_css_class('error');
      row.text = normalized;
      settings.set_strv('edit-shortcut', [normalized]);
    } else {
      row.add_css_class('error');
    }
  });
  // Typing after a failed apply should not keep showing the old error indefinitely.
  row.connect('notify::text', () => row.remove_css_class('error'));
  handlerIds.push(settings.connect('changed::edit-shortcut', sync));
  return row;
}

function confirmReset(settings: Gio.Settings, window: Adw.PreferencesWindow): void {
  const dialog = new Adw.AlertDialog({
    heading: 'Reset widget layout?',
    body: 'All widgets are removed and the default layout is restored.',
  });
  dialog.add_response('cancel', 'Cancel');
  dialog.add_response('reset', 'Reset');
  dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_dialog, response: string) => {
    if (response === 'reset')
      settings.set_string('layout', '');
  });
  dialog.present(window);
}
