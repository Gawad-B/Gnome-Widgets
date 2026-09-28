import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { SIZES, snap, spanPixels, type SizeName } from '../core/grid.ts';
import type { ServiceHub } from '../services/hub.ts';
import type { WidgetDefinition } from '../widgets/base.ts';
import { DeskCard } from './desk-card.ts';
import type { DeskLayer } from './desk-layer.ts';
import type { EditMode } from './edit-mode.ts';
import type { Theme } from './theme.ts';

const PREVIEW_SCALE = 0.6;
const PANEL_MARGIN = 32;
const SLIDE_MS = 250;
const NOTICE_MS = 2000;
const SIZE_LABELS: Record<SizeName, string> = { S: 'S', M: 'M', L: 'L', XL: 'XL' };

// The largest size a widget supports, by grid-cell area, for sizing its preview holder.
function largestSize(sizes: readonly SizeName[]): SizeName {
  return sizes.reduce((best, s) => (SIZES[s].w * SIZES[s].h > SIZES[best].w * SIZES[best].h ? s : best));
}

interface GalleryOptions {
  layer: DeskLayer;
  editMode: EditMode;
  registry: ReadonlyMap<string, WidgetDefinition>;
  hub: ServiceHub;
  theme: Theme;
}

// The panel that slides up from the bottom in edit mode: one tile per widget type with a live
// preview and a size picker. Click a tile to auto-place it, or drag it onto the grid.
export class Gallery {
  private readonly _o: GalleryOptions;
  private _panel: St.BoxLayout | null = null;
  private _notice: St.Label | null = null;
  private _noticeTimeout = 0;
  private readonly _previews = new Set<DeskCard>();

  constructor(options: GalleryOptions) {
    this._o = options;
    options.editMode.onEnter(container => this._show(container));
    options.editMode.onExit(() => this._hide());
  }

  destroy(): void {
    this._hide();
  }

  private _show(container: St.Widget): void {
    const { theme, registry } = this._o;
    const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const panel = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-gallery ${theme.state.mode === 'dark' ? 'desk-dark' : 'desk-light'}`,
      reactive: true,
      x: area.x + PANEL_MARGIN,
      width: area.width - 2 * PANEL_MARGIN,
    });

    const header = new St.BoxLayout({ style_class: 'desk-gallery-header' });
    header.add_child(new St.Label({ text: 'Widgets', style_class: 'desk-gallery-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
    this._notice = new St.Label({ style_class: 'desk-gallery-notice', visible: false, y_align: Clutter.ActorAlign.CENTER });
    header.add_child(this._notice);
    const collapseIcon = new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 16 });
    const collapse = new St.Button({ style_class: 'desk-gallery-collapse', child: collapseIcon, can_focus: true });
    header.add_child(collapse);
    const done = new St.Button({ style_class: 'desk-gallery-done', label: 'Done', can_focus: true });
    done.connect('clicked', () => this._o.editMode.exit());
    header.add_child(done);
    panel.add_child(header);

    const tiles = new St.BoxLayout({ style_class: 'desk-gallery-tiles' });
    for (const def of registry.values())
      tiles.add_child(this._tile(def, container));
    const scroll = new St.ScrollView({ hscrollbar_policy: St.PolicyType.AUTOMATIC, vscrollbar_policy: St.PolicyType.NEVER, x_expand: true });
    scroll.set_child(tiles);
    panel.add_child(scroll);

    container.add_child(panel);
    this._panel = panel;
    // Position once the panel knows its height, then slide it up.
    const [, naturalHeight] = panel.get_preferred_height(panel.width);
    panel.y = area.y + area.height - naturalHeight - PANEL_MARGIN / 2;
    panel.translation_y = naturalHeight + PANEL_MARGIN;
    // ease()'s typed param bag only recognizes the camelCase spelling (see EasingParamsWithProperties
    // in @girs/gnome-shell); direct property assignment above accepts either.
    panel.ease({ translationY: 0, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });

    // Collapsing slides the whole (still full-height) panel down by the tiles' share of that
    // height - `naturalHeight` (header + tiles) minus the header's own preferred height, minus
    // the panel's own vertical padding - which lands the header at the very same bottom anchor
    // (16px, PANEL_MARGIN / 2, below the work area) as the expanded state, since that's also
    // how the expanded position above was derived from `naturalHeight`: subtracting the padding
    // here cancels it back out so `scroll.hide()`'s collapse ends at the same anchor rather than
    // one padding's worth short of it. The scroll view is only
    // actually hidden once that ease completes, both so it stops taking clicks/drags and so the
    // panel's own box - which would otherwise shrink to the header alone the moment the scroll
    // view is hidden - never races the translation. Expanding reverses the order: the scroll
    // view reappears first, which briefly overshoots past the anchor (the box grows again while
    // still translated down), then the translation eases back to 0, reading as a slide up into
    // place - the same slide the panel does when edit mode is first entered, above.
    let collapsed = false;
    collapse.connect('clicked', () => {
      collapsed = !collapsed;
      collapseIcon.icon_name = collapsed ? 'pan-up-symbolic' : 'pan-down-symbolic';
      if (collapsed) {
        const [, headerHeight] = header.get_preferred_height(panel.width);
        panel.ease({
          translationY: naturalHeight - headerHeight - panel.get_theme_node().get_vertical_padding(),
          duration: SLIDE_MS,
          mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
          onComplete: () => scroll.hide(),
        });
      } else {
        scroll.show();
        panel.ease({ translationY: 0, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
      }
    });
  }

  private _hide(): void {
    if (this._noticeTimeout) {
      GLib.Source.remove(this._noticeTimeout);
      this._noticeTimeout = 0;
    }
    for (const preview of this._previews)
      preview.destroy();
    this._previews.clear();
    this._panel?.destroy();
    this._panel = null;
    this._notice = null;
  }

  private _tile(def: WidgetDefinition, container: St.Widget): St.BoxLayout {
    // x_expand: false stops the hit button's expand:true (below) from propagating all the way up
    // through holder into the row: without it, Clutter treats a container as wanting to expand
    // whenever any of its children do, which would let this tile (and its hit area/hover) stretch
    // to fill the whole row in `tiles` instead of staying the tile's own natural width.
    const tile = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-gallery-tile', x_expand: false,
    });
    const geo = this._o.layer.geometry;
    const largest = spanPixels(geo, largestSize(def.sizes));
    // Same reasoning as `tile` above, one level down: without an explicit false here, holder
    // would inherit expand from the hit button placed inside it and grow past its fixed
    // preview-scaled size, widening the hoverable/clickable band beyond the visible tile.
    const holder = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      width: Math.round(largest.width * PREVIEW_SCALE),
      height: Math.round(largest.height * PREVIEW_SCALE),
      x_expand: false,
      y_expand: false,
    });
    tile.add_child(holder);
    tile.add_child(new St.Label({ text: def.name, style_class: 'desk-gallery-name' }));
    tile.add_child(new St.Label({ text: def.description, style_class: 'desk-gallery-description' }));

    // No layout manager, so it just fills the holder (via the BinLayout above stretching an
    // expand:true child) without imposing any allocation on what's placed inside it. Putting the
    // preview card directly in `holder` instead would have BinLayout clamp the card's allocation
    // to the holder's already-scaled-down size before set_scale() ever runs, squeezing anything
    // bigger than S (and distorting M's aspect ratio, since it isn't clamped uniformly).
    const previewWrap = new St.Widget({ x_expand: true, y_expand: true });
    holder.add_child(previewWrap);

    let size: SizeName = def.defaultSize;
    let preview: DeskCard | null = null;
    const showPreview = () => {
      if (preview) {
        this._previews.delete(preview);
        preview.destroy();
      }
      preview = new DeskCard({ id: `preview-${def.type}`, type: def.type, size, col: 0, row: 0, config: {} }, def, this._o.hub);
      preview.applyTheme(this._o.theme.state);
      const { width, height } = spanPixels(geo, size);
      preview.actor.set_size(width, height);
      preview.actor.set_scale(PREVIEW_SCALE, PREVIEW_SCALE);
      preview.actor.reactive = false;
      previewWrap.insert_child_at_index(preview.actor, 0);
      this._previews.add(preview);
    };

    // Transparent button over the preview: the click and drag target (preview content never reacts).
    const hit = new St.Button({ style_class: 'desk-gallery-hit', x_expand: true, y_expand: true, can_focus: true });
    hit.connect('clicked', () => {
      if (this._o.layer.addWidget(def.type, size) === null)
        this._flash('No room on the desktop');
    });
    hit.add_action(this._dragGesture(def, () => size, container));
    holder.add_child(hit);

    const sizes = new St.BoxLayout({ style_class: 'desk-gallery-sizes' });
    const buttons = new Map<SizeName, St.Button>();
    for (const option of def.sizes) {
      const button = new St.Button({ style_class: 'desk-gallery-size', label: SIZE_LABELS[option], toggle_mode: true, checked: option === size, can_focus: true });
      button.connect('clicked', () => {
        // Re-clicking the already-selected chip would otherwise destroy and rebuild the preview
        // for no reason; toggle_mode's own click handling can also flip `checked` off on a
        // re-click of an already-checked button, so force it back on before returning.
        if (option === size) {
          button.checked = true;
          return;
        }
        size = option;
        for (const [name, b] of buttons)
          b.checked = name === size;
        showPreview();
      });
      buttons.set(option, button);
      sizes.add_child(button);
    }
    tile.add_child(sizes);
    showPreview();
    return tile;
  }

  private _dragGesture(def: WidgetDefinition, size: () => SizeName, container: St.Widget): Clutter.PanGesture {
    const pan = new Clutter.PanGesture({ required_button: Clutter.BUTTON_PRIMARY });
    let ghost: St.Widget | null = null;

    const cellUnderGhost = () => {
      const layer = this._o.layer.actor;
      return snap(this._o.layer.geometry, size(), { x: ghost!.x - layer.x, y: ghost!.y - layer.y });
    };
    const overPanel = () => {
      if (!this._panel)
        return false;
      const point = pan.get_centroid_abs();
      const [px, py] = this._panel.get_transformed_position();
      return point.y >= py && point.x >= px && point.x <= px + this._panel.width;
    };

    pan.connect('recognize', () => {
      const { width, height } = spanPixels(this._o.layer.geometry, size());
      ghost = new St.Widget({ style_class: 'desk-card desk-gallery-ghost', width, height, opacity: 220 });
      ghost.set_style(this._o.theme.state.card.css);
      container.add_child(ghost);
    });
    pan.connect('pan-update', () => {
      if (!ghost)
        return;
      const point = pan.get_centroid_abs();
      ghost.set_position(point.x - ghost.width / 2, point.y - ghost.height / 2);
      if (overPanel()) {
        this._o.editMode.hidePlaceholder();
        return;
      }
      const cell = cellUnderGhost();
      this._o.editMode.showPlaceholder(size(), cell, this._o.layer.isFree(size(), cell));
    });
    const finish = (add: boolean) => {
      if (!ghost)
        return;
      if (add && !overPanel() && this._o.layer.addWidget(def.type, size(), cellUnderGhost()) === null)
        this._flash('No room there');
      this._o.editMode.hidePlaceholder();
      ghost.destroy();
      ghost = null;
    };
    pan.connect('end', () => finish(true));
    pan.connect('cancel', () => finish(false));
    return pan;
  }

  private _flash(text: string): void {
    if (!this._notice)
      return;
    this._notice.text = text;
    this._notice.show();
    if (this._noticeTimeout)
      GLib.Source.remove(this._noticeTimeout);
    this._noticeTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTICE_MS, () => {
      this._noticeTimeout = 0;
      this._notice?.hide();
      return GLib.SOURCE_REMOVE;
    });
  }
}
