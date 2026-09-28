import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Test-only: lets tools/devshell.sh call org.gnome.Shell.Eval and Screenshot.
export default class TestHelper extends Extension {
  enable() {
    global.context.unsafe_mode = true;
    // Drop the "System was put in unsafe mode" banner so it doesn't cover screenshots.
    for (const n of [...MessageTray.getSystemSource().notifications])
      n.destroy();
  }

  disable() {
    global.context.unsafe_mode = false;
  }
}
