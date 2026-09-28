import Clutter from 'gi://Clutter';
import St from 'gi://St';

export interface NavHeaderOptions {
  title: string | St.Widget;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onToday: (() => void) | null;
}

const rtl = (): boolean => Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;

function arrow(forward: boolean, cb: () => void): St.Button {
  const icon = forward !== rtl() ? 'go-next-symbolic' : 'go-previous-symbolic';
  const button = new St.Button({
    style_class: 'desk-cal-nav-arrow',
    child: new St.Icon({ icon_name: icon, style_class: 'desk-cal-nav-icon' }),
    can_focus: true,
    accessible_name: forward ? 'Next' : 'Previous',
  });
  button.connect('clicked', cb);
  return button;
}

// ‹ title › with an optional Today pill; a null callback leaves that control out (used by
// message states, which render no nav at all - see calendar.ts).
export function buildNavHeader({ title, onPrev, onNext, onToday }: NavHeaderOptions): St.BoxLayout {
  const box = new St.BoxLayout({ style_class: 'desk-cal-nav', x_expand: true });
  if (onPrev)
    box.add_child(arrow(false, onPrev));
  const titleActor = typeof title === 'string'
    ? new St.Label({ text: title, style_class: 'desk-cal-nav-title', y_align: Clutter.ActorAlign.CENTER })
    : title;
  titleActor.x_expand = true;
  box.add_child(titleActor);
  if (onToday) {
    const today = new St.Button({
      style_class: 'desk-cal-today-pill', label: 'Today', can_focus: true, y_align: Clutter.ActorAlign.CENTER,
    });
    today.connect('clicked', onToday);
    box.add_child(today);
  }
  if (onNext)
    box.add_child(arrow(true, onNext));
  return box;
}
