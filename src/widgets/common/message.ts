import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

// A centred, word-wrapped status line for a widget's loading, error or empty state: shared by
// System and Battery, matching the wrapped style the Weather widget already uses for the same
// purpose.
export function buildStatusLabel(text: string): St.Label {
  const label = new St.Label({
    text,
    style_class: 'desk-widget-empty',
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
    x_expand: true,
    y_expand: true,
  });
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  label.clutter_text.line_alignment = Pango.Alignment.CENTER;
  return label;
}
