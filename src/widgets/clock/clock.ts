import Clutter from 'gi://Clutter';
import St from 'gi://St';
import type { ClockValue } from '../../services/clock.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';
import { AnalogFace } from './analog-face.ts';
import { SecondsRing } from './seconds-ring.ts';

const formatTime = ({ now, use24h }: ClockValue) => (now.format(use24h ? '%H:%M' : '%l:%M') ?? '').trim();

// S and L show the chosen face (analog by default); M is always digital with the long date.
// The `seconds` option means the second hand on an analog face, or the seconds ring wrapped
// around a digital one; a digital S with the ring on shows the time only (no date line), like
// M/L which keep the date inside the ring.
class ClockWidget extends DeskWidget {
  constructor(ctx: WidgetContext) {
    const analog = ctx.size !== 'M' && ctx.config.face !== 'digital';
    const secondsOn = ctx.config.seconds === true;
    const showRing = !analog && secondsOn;
    // An analog S face fills the card with no date line, unchanged; a digital S hides its date
    // only once the ring takes over the card's edge, like the reference. M and L always show it.
    const hideDate = ctx.size === 'S' && (analog || showRing);
    const dateFormat = ctx.size === 'S' ? '%a %-d' : '%A, %B %-d';

    // The clock widget bleeds (WidgetDefinition.bleed, below) so the ring can draw all the way
    // to the card's own edge; every other layout re-adds desk-card-content's usual 16px padding
    // itself (desk-clock-inset, stylesheet.css) so it looks exactly as it did before the ring.
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: showRing
        ? `desk-clock desk-clock-${ctx.size}`
        : `desk-clock desk-clock-${ctx.size} desk-clock-inset`,
      x_expand: true,
      y_expand: true,
    });
    super(box);

    const face = analog ? new AnalogFace(secondsOn) : null;
    const ring = showRing ? new SecondsRing() : null;
    const time = analog ? null : new St.Label({ style_class: 'desk-clock-time', x_align: Clutter.ActorAlign.CENTER });
    const date = hideDate ? null : new St.Label({ style_class: 'desk-clock-date', x_align: Clutter.ActorAlign.CENTER });

    if (face) {
      box.add_child(face.actor);
      if (date)
        box.add_child(date);
    } else if (ring) {
      // The ring is a full-size background layer, so it has to actually fill the card: `box`
      // keeps its default FILL alignment (unlike the plain-digital branch below) so `stack`
      // gets the whole content box, not just the text's own natural height. The time (and, on
      // M/L, the date) sits centred on top of the ring, both inside the same BinLayout so
      // neither pushes the other around.
      const stack = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true });
      const text = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      text.add_child(time!);
      if (date)
        text.add_child(date);
      stack.add_child(ring.actor);
      stack.add_child(text);
      box.add_child(stack);
    } else {
      box.add_child(time!);
      if (date)
        box.add_child(date);
      box.y_align = Clutter.ActorAlign.CENTER;
    }

    // The ring and the analog second hand both need a per-second tick; everything else only
    // needs the minute boundary.
    const service = secondsOn ? ctx.hub.clockSeconds() : ctx.hub.clock();
    ctx.scope.watch(service, ({ value }) => {
      if (!value)
        return;
      face?.setTime(value.now);
      ring?.setSecond(value.now.get_second());
      // The ring repaints every second regardless (queue_repaint above); the text labels only
      // need to change once a minute (time) or once a day (date), so skip the reflow otherwise.
      const formatted = formatTime(value);
      if (time && time.text !== formatted)
        time.text = formatted;
      if (date) {
        const formattedDate = value.now.format(dateFormat) ?? '';
        if (date.text !== formattedDate)
          date.text = formattedDate;
      }
    });
  }
}

export const clockWidget: WidgetDefinition = {
  type: 'clock',
  name: 'Clock',
  description: 'The time and date',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'S',
  defaultConfig: { face: 'analog', seconds: false },
  // Only the ring layout needs to draw past desk-card-content's 16px padding; see the box's own
  // style_class above for how the other layouts get that padding back.
  bleed: true,
  options: [
    {
      kind: 'choice',
      key: 'face',
      label: 'Face',
      choices: [{ value: 'analog', label: 'Analog' }, { value: 'digital', label: 'Digital' }],
    },
    { kind: 'toggle', key: 'seconds', label: 'Seconds' },
  ],
  create: ctx => new ClockWidget(ctx),
};
