import Clutter from 'gi://Clutter';
import type St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { onWorkspaceAnimationBackground } from './shell-private.ts';

// During a workspace switch, Shell 50/51 stacks a WorkspaceGroup (with its own wallpaper
// background and the window clones sliding over it) above `global.window_group`, entirely
// covering DeskLayer's actor underneath for the length of the animation — so the widgets vanish,
// then pop back in once the switch finishes. This class clones the layer onto the primary
// monitor's animated background, below the window clones, so the widgets stay visible and slide
// with the wallpaper like the rest of the desktop.
export class WorkspaceSwitchClones {
  private readonly _layerActor: St.Widget;
  private readonly _removeHook: () => void;

  constructor(layerActor: St.Widget) {
    this._layerActor = layerActor;
    this._removeHook = onWorkspaceAnimationBackground((background, monitor) => {
      if (monitor.index !== Main.layoutManager.primaryIndex)
        return;
      // The window clones get stacked above `background` (see WorkspaceGroup._syncStacking), so
      // this clone only needs to sit above `background`'s own wallpaper (its first child, a
      // Meta.BackgroundGroup) and below everything else — including desktop-icon extensions like
      // DING, which clone their icons into `background` too. It's destroyed along with
      // `background` when the animation's groups are torn down; if `_layerActor` is destroyed
      // first (extension disabled mid-switch), the clone just stops painting its source rather
      // than erroring — Clutter.Clone tolerates that.
      const clone = new Clutter.Clone({
        source: this._layerActor,
        x: this._layerActor.x - monitor.x,
        y: this._layerActor.y - monitor.y,
        opacity: this._layerActor.opacity,
      });
      background.insert_child_above(clone, background.get_first_child());
      // Dimmer eases the layer's opacity on every workspace/focus change, i.e. exactly when this
      // clone is alive — keep it in sync so it doesn't slide in at a stale opacity and then jump.
      this._layerActor.connectObject('notify::opacity', () => {
        clone.opacity = this._layerActor.opacity;
      }, clone);
    });
  }

  destroy(): void {
    this._removeHook();
  }
}
