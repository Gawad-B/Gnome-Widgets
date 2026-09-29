import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// A widget only ever holds a reference to its own actor, not the card it lives in (DeskCard adds
// the widget's actor into its own content wrapper after create() returns, so the card isn't even
// an ancestor yet at construction time) - walked lazily here, when the entry actually opens, by
// climbing to the nearest ancestor carrying the card's own style class.
function findCardActor(start: St.Widget): St.Widget {
  let node: Clutter.Actor | null = start;
  while (node) {
    if (node instanceof St.Widget && node.has_style_class_name('desk-card'))
      return node;
    node = node.get_parent();
  }
  return start;
}

// The Reminders "＋" text entry: the only keyboard grab outside edit mode. open() adds an
// St.Entry into the given container, pushes a modal grab on the card and focuses the entry.
// Enter adds a task and clears the entry, keeping it open; an empty Enter, Esc, or a primary
// click outside the card all close it. Every exit path runs through close(), which is safe to
// call any number of times (including when nothing is open): each of its three teardown steps
// is independently guarded, so a widget destroyed mid-edit, or disable() itself, never leaves the
// modal grab held or the stage listener connected.
//
// The "click outside" listener is connected on the card itself, not on global.stage: once
// Main.pushModal(card) is active, Clutter routes every event's capture phase through the grab
// actor first (the same reason ui/grabHelper.js's own _takeModalGrab() connects its
// 'captured-event' handler to the grab owner, not the stage) - a listener on global.stage simply
// never runs for the length of the grab.
export class TaskEntryController {
  private readonly _anchor: St.Widget;
  private readonly _onSubmit: (text: string) => void;
  private readonly _onOpenChange: (() => void) | undefined;
  private _entry: St.Entry | null = null;
  private _grab: Clutter.Grab | null = null;
  private _card: St.Widget | null = null;

  constructor(anchor: St.Widget, onSubmit: (text: string) => void, onOpenChange?: () => void) {
    this._anchor = anchor;
    this._onSubmit = onSubmit;
    this._onOpenChange = onOpenChange;
  }

  get isOpen(): boolean {
    return this._entry !== null;
  }

  open(container: St.Widget): void {
    if (this._entry)
      return;
    const entry = new St.Entry({ style_class: 'desk-rem-entry', hint_text: 'New reminder', can_focus: true });
    container.add_child(entry);
    this._entry = entry;

    const card = findCardActor(this._anchor);
    this._card = card;
    this._grab = Main.pushModal(card, { actionMode: Shell.ActionMode.NORMAL });
    global.stage.set_key_focus(entry);

    entry.clutter_text.connect('key-press-event', (_actor: unknown, event: Clutter.Event) => {
      const symbol = event.get_key_symbol();
      if (symbol === Clutter.KEY_Escape) {
        this.close();
        return Clutter.EVENT_STOP;
      }
      if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
        const text = entry.get_text();
        if (text.trim() === '') {
          this.close();
        } else {
          this._onSubmit(text);
          entry.set_text('');
        }
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Any button press or touch outside the card closes the entry; anything inside it
    // (including the entry itself) is left alone so normal interaction with the rest of the card
    // keeps working. Connected on the card (the grab actor), not the stage - see the class comment.
    card.connectObject('captured-event', (_actor: unknown, event: Clutter.Event) => {
      const type = event.type();
      if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
        return Clutter.EVENT_PROPAGATE;
      const target = global.stage.get_event_actor(event);
      if (target && card.contains(target))
        return Clutter.EVENT_PROPAGATE;
      this.close();
      return Clutter.EVENT_STOP;
    }, this);

    this._onOpenChange?.();
  }

  close(): void {
    const wasOpen = this._entry !== null;
    this._card?.disconnectObject(this);
    this._card = null;
    if (this._entry) {
      this._entry.destroy();
      this._entry = null;
    }
    if (this._grab) {
      Main.popModal(this._grab);
      this._grab = null;
    }
    if (wasOpen)
      this._onOpenChange?.();
  }
}
