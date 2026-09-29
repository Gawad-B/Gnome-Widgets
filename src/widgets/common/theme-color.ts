import St from 'gi://St';

// A zero-size helper actor whose only role is resolving the system accent colour: giving it
// `color: -st-accent-color` in the stylesheet (.desk-accent-probe) means its own theme node's
// foreground colour is the accent colour, regardless of whatever colour its parent (and the
// drawing area it sits in) actually renders text in. Add one as a child of a drawing area and
// read `probe.get_theme_node().get_foreground_color()` at paint time.
export function accentProbe(): St.Widget {
  return new St.Widget({ style_class: 'desk-accent-probe', visible: false });
}

export function colorRgba(
  color: { red: number; green: number; blue: number }, alpha: number,
): [number, number, number, number] {
  return [color.red / 255, color.green / 255, color.blue / 255, alpha];
}
