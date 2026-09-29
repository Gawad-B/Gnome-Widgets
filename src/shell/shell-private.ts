// Typed access to the private GNOME Shell members this extension relies on. Verified against
// Shell 50.5 (ui/layout.js, ui/backgroundMenu.js, ui/workspaceAnimation.js, ui/calendar.js,
// ui/dateMenu.js, misc/weather.js, ui/messageList.js, ui/mpris.js). Nothing else in the
// codebase touches privates.
import type Gio from 'gi://Gio';
import type Clutter from 'gi://Clutter';
import type GWeather from 'gi://GWeather?version=4.0';
import type Meta from 'gi://Meta';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

export interface BackgroundManagerLike {
  // null once the manager has been destroyed (e.g. during monitor teardown).
  backgroundActor: (Meta.BackgroundActor & { _backgroundMenu?: PopupMenu.PopupMenu | null }) | null;
  connectObject(...args: unknown[]): number;
  disconnectObject(owner: object): void;
}

interface LayoutManagerPrivate {
  _backgroundGroup: Meta.BackgroundGroup;
  _startingUp: boolean;
  _bgManagers: BackgroundManagerLike[];
}

const layout = () => Main.layoutManager as unknown as LayoutManagerPrivate;

// Holds the per-monitor wallpapers; children sit above the wallpaper and below every window.
export const backgroundGroup = (): Meta.BackgroundGroup => layout()._backgroundGroup;

export const shellStartingUp = (): boolean => layout()._startingUp;

// One per monitor; each recreates its background actor (and its right-click menu) on 'changed'.
export const backgroundManagers = (): readonly BackgroundManagerLike[] => layout()._bgManagers;

// A manager's current right-click menu, or null when it has none yet (or its actor was
// destroyed: a destroyed BackgroundManager's backgroundActor is null).
export const backgroundMenuOf = (manager: BackgroundManagerLike): PopupMenu.PopupMenu | null =>
  manager.backgroundActor?._backgroundMenu ?? null;

// The primary monitor's own wallpaper actor - null before startup/monitor setup has run, or
// briefly around a monitor change while backgroundManagers() is being rebuilt.
export const primaryBackgroundActor = (): Meta.BackgroundActor | null =>
  backgroundManagers()[Main.layoutManager.primaryIndex]?.backgroundActor ?? null;

// The monitor rect a WorkspaceGroup was built for (a subset of Main.layoutManager.monitors[i]).
export interface AnimationMonitor {
  index: number;
  x: number;
  y: number;
}

// WorkspaceGroup's own background-creation hook, and the fields it sets while doing so, aren't
// part of the shipped @girs typings (workspaceAnimation.d.ts only covers window-record
// bookkeeping) — this interface bridges that gap for the narrow cast below.
interface WorkspaceGroupPrivate {
  _createBackground(): void;
  _background?: Clutter.Actor;
  _monitor: AnimationMonitor;
}

// During a workspace switch, Shell 50/51 gives every WorkspaceGroup its own WorkspaceBackground
// (a full wallpaper actor) via `_createBackground()`, then stacks window clones above it — which
// is what covers DeskLayer's actor for the length of the slide. Installs `cb` to run right after
// each background is created, with that background actor and the monitor it belongs to. Returns
// a remover that restores the original `_createBackground` (call it in teardown).
export const onWorkspaceAnimationBackground = (
  cb: (background: Clutter.Actor, monitor: AnimationMonitor) => void,
): (() => void) => {
  const injections = new InjectionManager();
  const proto = WorkspaceAnimation.WorkspaceGroup.prototype as unknown as WorkspaceGroupPrivate;
  injections.overrideMethod(proto, '_createBackground', originalMethod => function (this: WorkspaceGroupPrivate) {
    originalMethod.call(this);
    if (this._background) {
      // Runs inside the Shell's BaseWorkspaceGroup constructor, mid-_prepareWorkspaceSwitch: an
      // uncaught throw here would leave workspace switching broken until the Shell restarts.
      try {
        cb(this._background, this._monitor);
      } catch (e) {
        console.error('Desk Widgets: onWorkspaceAnimationBackground callback failed', e);
      }
    }
  });
  return () => injections.clear();
};

interface SignalOwner {
  connectObject(...args: unknown[]): number;
  disconnectObject(owner: object): void;
}

export interface ShellCalendarEvent { id: string; date: Date; end: Date; summary: string }

// The top-bar calendar's event source (ui/calendar.js DBusEventSource). Shared, never destroyed
// by us.
export interface ShellEventSource extends SignalOwner {
  readonly hasCalendars: boolean;
  readonly isLoading: boolean;
  requestRange(begin: Date, end: Date): void;
  getEvents(begin: Date, end: Date): ShellCalendarEvent[];
}

// The top-bar weather's client (misc/weather.js WeatherClient). It has no destroy(), so we
// reuse the Shell's instance rather than creating (and leaking) our own.
export interface ShellWeatherClient extends SignalOwner {
  readonly available: boolean;
  readonly loading: boolean;
  readonly hasLocation: boolean;
  readonly info: GWeather.Info;
  update(): void;
  activateApp(): void;
}

// The top-bar calendar popup's menu (ui/popupMenu.js PopupMenuBase). `isOpen` is what
// ui/dateMenu.js itself checks before resetting `_calendar` back to today.
export interface ShellDateMenuPopup extends SignalOwner {
  readonly isOpen: boolean;
}

// ui/calendar.js Calendar, narrowed to the one method we drive from the outside.
interface ShellTopBarCalendar {
  setDate(date: Date): void;
}

// ui/mpris.js MprisPlayer, narrowed to the members the media service and widget use. `app` is
// the looked-up Shell.App for the player's DesktopEntry (or null), narrowed to just the piece
// used for its icon.
export interface ShellMprisPlayer extends SignalOwner {
  readonly _busName: string;
  readonly status: string;                 // 'Playing' | 'Paused' | 'Stopped'
  readonly trackTitle: string;
  readonly trackArtists: string[];
  readonly trackCoverUrl: string;
  readonly app: { get_name(): string; get_icon(): Gio.Icon | null } | null;
  readonly canPlay: boolean;
  readonly canGoNext: boolean;
  readonly canGoPrevious: boolean;
  playPause(): void;
  next(): void;
  previous(): void;
  raise(): void;
}

// ui/mpris.js MprisSource. Has no destroy(): it's the Shell's own instance (the notification
// list's media section already runs it), so it's read from, never created or torn down here.
export interface ShellMprisSource extends SignalOwner {
  readonly players: readonly ShellMprisPlayer[];
}

interface DateMenuPrivate {
  _eventSource: ShellEventSource | null;
  _weatherItem?: { _weatherClient?: ShellWeatherClient };
  _calendar?: ShellTopBarCalendar;
  _messageList?: { _messageView?: { _mediaSource?: ShellMprisSource } };
  menu: ShellDateMenuPopup;
}

const dateMenu = (): DateMenuPrivate | null =>
  (Main.panel.statusArea as unknown as { dateMenu?: DateMenuPrivate }).dateMenu ?? null;

export const shellEventSource = (): ShellEventSource | null => dateMenu()?._eventSource ?? null;
export const shellWeatherClient = (): ShellWeatherClient | null => dateMenu()?._weatherItem?._weatherClient ?? null;
export const dateMenuPopup = (): ShellDateMenuPopup | null => dateMenu()?.menu ?? null;

// The notification list's own MprisSource (ui/messageList.js MessageView._mediaSource, built
// from ui/calendar.js CalendarMessageList._messageView). Reusing it avoids running a second
// MprisSource, which would double the D-Bus proxies and player objects for no reason and, since
// MprisSource has no destroy(), leak the extra one's signal handlers on every re-enable. null in
// a session mode with no notification list (e.g. the lock screen).
export const shellMprisSource = (): ShellMprisSource | null =>
  dateMenu()?._messageList?._messageView?._mediaSource ?? null;

// The D-Bus bus name (e.g. "org.mpris.MediaPlayer2.spotify") behind a player, for the direct
// Properties.Get calls the position poll makes outside the Shell's own MprisPlayer proxies.
export const mprisBusName = (player: ShellMprisPlayer): string | null =>
  typeof player._busName === 'string' ? player._busName : null;

// Puts the top-bar calendar's own displayed month back to today — exactly what ui/dateMenu.js
// does itself on menu open (it resets `_calendar`'s selected date there). This exists because
// the top-bar Calendar reacts to *every* event-source 'changed' signal by re-requesting
// whatever month it's currently showing (ui/calendar.js `_rebuildCalendar`, driven off
// `_selectedDate`, which is otherwise only reset when the menu opens) — so once the user
// browses to another month there, or local midnight rolls the day into a new one, the top bar
// keeps re-asserting that stale month over the calendar server's single shared time range on
// every change, undoing our own request right after we make it. Does nothing while the menu is
// open: the user is actively looking at whatever month they browsed to there, and yanking it
// back to today out from under them would be its own bug.
export const resetShellCalendarToToday = (): void => {
  const menu = dateMenu();
  if (!menu || menu.menu.isOpen)
    return;
  menu._calendar?.setDate?.(new Date());
};

// Points the top-bar calendar at `date`'s month (only while its menu is closed - an open menu
// is the user's). The Shell's calendar then requests that month's grid itself and keeps
// re-requesting it on every 'changed', which is the only way a browsed month stays loaded in
// the shared event source.
export const setShellCalendarDate = (date: Date): void => {
  const menu = dateMenu();
  if (!menu || menu.menu.isOpen)
    return;
  menu._calendar?.setDate?.(new Date(date.getTime()));
};
