import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { formatMediaTime } from '../../core/media.ts';
import type { MediaPlayerInfo, MediaService, MediaValue } from '../../services/media.ts';
import type { Snapshot } from '../../services/service.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';
import { Bar } from '../common/bar.ts';
import { buildStatusLabel } from '../common/message.ts';

const ART_SIZE = { S: 72, M: 96 } as const;
// How far S's play/pause button hangs past the art's bottom-right corner, in pixels.
const PLAY_OVERHANG = 6;

const fallbackIcon = (): Gio.Icon => Gio.ThemedIcon.new('audio-x-generic-symbolic');

function iconButton(iconName: string, styleClass: string): { button: St.Button; icon: St.Icon } {
  const icon = new St.Icon({ icon_name: iconName, style_class: 'desk-media-btn-icon' });
  const button = new St.Button({ style_class: `desk-media-btn ${styleClass}`, child: icon, can_focus: true });
  return { button, icon };
}

// S: the art (or app icon) fills a rounded square, with a play/pause button overlaid at its
// bottom-right corner. M: the same art on the left, title/artists and prev/play/next on the
// right. L: M plus a progress bar with elapsed/remaining time, and it's the only size that asks
// the service for position (wantPosition), releasing it again in scope cleanup.
// Clicking the art or the title raises the player's own window; the transport buttons call the
// service's actions directly. Rebuilt only when the size or the state kind (loading/no-player/
// error/ready) changes; every field within "ready" (art, text, button availability, progress)
// updates in place, since the service republishes once a second while a poll is running.
class MediaWidget extends DeskWidget {
  private readonly _box: St.BoxLayout;
  private readonly _size: WidgetContext['size'];
  private readonly _service: MediaService;
  private _mode: string | null = null;

  private _art: St.Widget | null = null;
  private _artIcon: St.Icon | null = null;
  private _artPath: string | null = null;
  private _title: St.Label | null = null;
  private _artists: St.Label | null = null;
  private _playBtn: St.Button | null = null;
  private _playIcon: St.Icon | null = null;
  private _prevBtn: St.Button | null = null;
  private _nextBtn: St.Button | null = null;
  private _bar: Bar | null = null;
  private _elapsed: St.Label | null = null;
  private _remaining: St.Label | null = null;

  constructor(ctx: WidgetContext) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-media desk-media-${ctx.size}`,
      x_expand: true,
      y_expand: true,
    });
    super(box);
    this._box = box;
    this._size = ctx.size;
    this._service = ctx.hub.media();
    ctx.scope.watch(this._service, snapshot => this._render(snapshot));
    if (ctx.size === 'L') {
      this._service.wantPosition(this, true);
      ctx.scope.onCleanup(() => this._service.wantPosition(this, false));
    }
  }

  private _render(snapshot: Snapshot<MediaValue>): void {
    if (snapshot.state === 'loading') {
      this._show('loading', () => this._box.add_child(buildStatusLabel('…')));
      return;
    }
    if (snapshot.state !== 'ready' || !snapshot.value) {
      this._show('error', () => this._box.add_child(buildStatusLabel('Media unavailable')));
      return;
    }
    const player = snapshot.value.player;
    if (!player) {
      this._show('no-player', () => this._box.add_child(buildStatusLabel('Nothing playing')));
      return;
    }
    this._show('ready', () => this._build());
    this._update(player);
  }

  private _show(mode: string, build: () => void): void {
    if (this._mode === mode)
      return;
    this._box.destroy_all_children();
    this._art = null; this._artIcon = null; this._artPath = null;
    this._title = null; this._artists = null;
    this._playBtn = null; this._playIcon = null; this._prevBtn = null; this._nextBtn = null;
    this._bar = null; this._elapsed = null; this._remaining = null;
    this._mode = mode;
    build();
  }

  private _build(): void {
    if (this._size === 'S')
      this._buildS();
    else
      this._buildML();
  }

  private _buildS(): void {
    const stack = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
      x_expand: true, y_expand: true,
    });
    this._art = this._makeArt(ART_SIZE.S);
    stack.add_child(this._art);

    const { button, icon } = iconButton('media-playback-start-symbolic', 'desk-media-play-overlay');
    // BinLayout only honours a child's END alignment when that child also expands; without it
    // the button lands centred over the art.
    button.x_expand = true;
    button.y_expand = true;
    button.x_align = Clutter.ActorAlign.END;
    button.y_align = Clutter.ActorAlign.END;
    // Hangs past the art's corner by a paint-time offset rather than a negative CSS margin (see
    // .desk-media-play-overlay in stylesheet.css): a translation never feeds back into layout.
    button.translation_x = PLAY_OVERHANG;
    button.translation_y = PLAY_OVERHANG;
    button.connect('clicked', () => this._service.playPause());
    this._playBtn = button;
    this._playIcon = icon;
    stack.add_child(button);

    this._box.add_child(stack);
  }

  private _buildML(): void {
    const row = new St.BoxLayout({ style_class: 'desk-media-row', x_expand: true, y_expand: true });
    this._art = this._makeArt(ART_SIZE.M);
    row.add_child(this._art);

    const info = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-media-info',
      x_expand: true, y_align: Clutter.ActorAlign.CENTER,
    });

    this._title = new St.Label({ style_class: 'desk-media-title', reactive: true });
    this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    this._attachRaise(this._title);
    info.add_child(this._title);

    this._artists = new St.Label({ style_class: 'desk-media-artists' });
    this._artists.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    info.add_child(this._artists);

    const controls = new St.BoxLayout({ style_class: 'desk-media-controls' });
    const prev = iconButton('media-skip-backward-symbolic', 'desk-media-btn-side');
    prev.button.connect('clicked', () => this._service.previous());
    this._prevBtn = prev.button;
    controls.add_child(prev.button);

    const play = iconButton('media-playback-start-symbolic', 'desk-media-btn-play');
    play.button.connect('clicked', () => this._service.playPause());
    this._playBtn = play.button;
    this._playIcon = play.icon;
    controls.add_child(play.button);

    const next = iconButton('media-skip-forward-symbolic', 'desk-media-btn-side');
    next.button.connect('clicked', () => this._service.next());
    this._nextBtn = next.button;
    controls.add_child(next.button);

    info.add_child(controls);

    if (this._size === 'L') {
      const progress = new St.BoxLayout({ style_class: 'desk-media-progress-row', x_expand: true });
      this._elapsed = new St.Label({ style_class: 'desk-media-time' });
      progress.add_child(this._elapsed);
      this._bar = new Bar();
      this._bar.actor.x_expand = true;
      this._bar.actor.y_align = Clutter.ActorAlign.CENTER;
      progress.add_child(this._bar.actor);
      this._remaining = new St.Label({ style_class: 'desk-media-time' });
      progress.add_child(this._remaining);
      info.add_child(progress);
    }

    row.add_child(info);
    this._box.add_child(row);
  }

  private _makeArt(size: number): St.Widget {
    const holder = new St.Widget({
      style_class: 'desk-media-art', layout_manager: new Clutter.BinLayout(),
      width: size, height: size, reactive: true,
      // Without this, the row's BoxLayout stretches the holder to the row's full height (its
      // fixed width is already honoured, since width is the row's main axis): the art ends up
      // taller than it is wide instead of a square, and background-size: cover then crops it.
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._attachRaise(holder);
    return holder;
  }

  // A primary click anywhere on the art or the title raises the player's own window. Each actor
  // is destroyed with the rest of the mode's content on the next rebuild, taking this gesture
  // with it, so there's nothing further to release in scope cleanup.
  private _attachRaise(actor: St.Widget): void {
    const click = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true });
    click.connect('recognize', () => this._service.raise());
    actor.add_action(click);
  }

  private _update(player: MediaPlayerInfo): void {
    if (this._art)
      this._updateArt(this._art, player);
    if (this._title)
      this._title.text = player.title || 'Unknown title';
    if (this._artists)
      this._artists.text = player.artists;
    if (this._playIcon)
      this._playIcon.icon_name = player.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    if (this._playBtn)
      this._playBtn.reactive = player.canPlay;
    if (this._prevBtn)
      this._prevBtn.reactive = player.canPrevious;
    if (this._nextBtn)
      this._nextBtn.reactive = player.canNext;

    if (this._size !== 'L')
      return;
    const { position, length } = player;
    const fraction = position !== null && length !== null && length > 0 ? position / length : 0;
    this._bar?.set(fraction);
    if (this._elapsed)
      this._elapsed.text = position !== null ? formatMediaTime(position) : '';
    if (this._remaining)
      this._remaining.text = position !== null && length !== null ? `-${formatMediaTime(Math.max(0, length - position))}` : '';
  }

  // Only touches the holder's own inline background style when the art path actually changed
  // (an St.Widget re-parses its style string on every set_style() call, and the service
  // republishes once a second while a poll is running), and swaps between a background image and
  // a centred fallback icon as art comes and goes.
  private _updateArt(holder: St.Widget, player: MediaPlayerInfo): void {
    if (player.artPath !== this._artPath) {
      this._artPath = player.artPath;
      // Gio.File.get_uri() percent-encodes whatever a raw `file://${path}` template wouldn't - a
      // literal '#', '%' or '"' in the path breaks the URL, or the surrounding CSS string, left
      // unescaped. https:// art resolves to a SHA-1-named cache file and never hits this, but a
      // file:// URL resolves straight to the player's own reported path (ArtCache.resolve()
      // returns it as-is), which can be any real filesystem path.
      const uri = player.artPath ? Gio.File.new_for_path(player.artPath).get_uri() : null;
      holder.set_style(uri ? `background-image: url("${uri}"); background-size: cover;` : null);
    }
    if (player.artPath) {
      if (this._artIcon) {
        this._artIcon.destroy();
        this._artIcon = null;
      }
      return;
    }
    if (!this._artIcon) {
      this._artIcon = new St.Icon({
        style_class: 'desk-media-art-icon',
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        x_expand: true, y_expand: true,
      });
      holder.add_child(this._artIcon);
    }
    this._artIcon.gicon = player.appIcon ?? fallbackIcon();
  }
}

export const mediaWidget: WidgetDefinition = {
  type: 'media',
  name: 'Media',
  description: 'Now playing',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: {},
  options: [],
  create: ctx => new MediaWidget(ctx),
};
