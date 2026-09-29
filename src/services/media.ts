// The active MPRIS player, reusing the Shell's own MprisSource (it has no destroy(), so a second
// instance would leak its D-Bus signal handlers on every re-enable). Position is polled directly
// over D-Bus; media-track.ts's TrackDetails handles art and length, neither of which MprisPlayer
// exposes on its own.
import Gio from 'gi://Gio';
import { pickActivePlayer, type PlayerState } from '../core/media.ts';
import { PositionPoll } from '../core/position-poll.ts';
import { shellMprisSource, mprisBusName, type ShellMprisPlayer, type ShellMprisSource } from '../shell/shell-private.ts';
import { ArtCache } from './art-cache.ts';
import { isCancelled } from './gio-file.ts';
import { TrackDetails } from './media-track.ts';
import { getPlayerProperty } from './mpris-properties.ts';
import { Service, type Scheduler } from './service.ts';

export interface MediaPlayerInfo {
  id: string;
  app: string;
  title: string;
  artists: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  artPath: string | null;
  appIcon: Gio.Icon | null;
  canPlay: boolean;
  canNext: boolean;
  canPrevious: boolean;
  position: number | null;   // seconds; only populated while wantPosition() has an owner
  length: number | null;     // seconds; only populated while wantPosition() has an owner
}

export interface MediaValue {
  player: MediaPlayerInfo | null;
}

// Slower while Paused (a seek is still caught reasonably promptly) than while actually moving.
const PLAYING_POLL_MS = 1000;
const PAUSED_POLL_MS = 5000;

function toStatus(status: string): 'Playing' | 'Paused' | 'Stopped' {
  return status === 'Playing' || status === 'Paused' ? status : 'Stopped';
}

// The Shell's player drops its D-Bus proxy as soon as the player's name vanishes, which can be a
// moment before 'player-removed' arrives; reading status in that window throws. Treat it as
// stopped until the removal lands.
function statusOf(player: ShellMprisPlayer): 'Playing' | 'Paused' | 'Stopped' {
  try {
    return toStatus(player.status);
  } catch {
    return 'Stopped';
  }
}

let loggedMissingBusName = false;

interface PlayerRecord {
  player: ShellMprisPlayer;
  lastPlayingAt: number;
  previousStatus: 'Playing' | 'Paused' | 'Stopped';
}

const trackKeyOf = (player: ShellMprisPlayer): string =>
  `${player.trackTitle}\u0000${player.trackArtists.join('\u0001')}\u0000${player.trackCoverUrl}`;

// The active player (the one that most recently started Playing) and its live MPRIS state.
// `wantPosition()` is ref-counted across possibly several L-size widgets; the position poll only
// runs while at least one owner wants it. Art and length live in media-track.ts's TrackDetails.
export class MediaService extends Service<MediaValue> {
  private _source: ShellMprisSource | null = null;
  private readonly _players = new Map<string, PlayerRecord>();
  private _artCache: ArtCache | null = null;
  private _activeBusName: string | null = null;
  private _trackKey: string | null = null;
  private readonly _track: TrackDetails;
  private _position: number | null = null;
  private readonly _positionOwners = new Set<object>();
  private readonly _positionPoll: PositionPoll;
  private _positionCancellable: Gio.Cancellable | null = null;
  private readonly _loggedPositionFailure = new Set<string>();
  private _loggedMissingSource = false;

  constructor(scheduler: Scheduler) {
    super(scheduler);
    this._track = new TrackDetails(scheduler, () => this._emit());
    this._positionPoll = new PositionPoll(
      scheduler,
      generation => this._fetchPosition(generation),
      value => this._onPositionResult(value),
      PLAYING_POLL_MS,
    );
  }

  playPause(): void { this._activePlayer()?.playPause(); }
  next(): void { this._activePlayer()?.next(); }
  previous(): void { this._activePlayer()?.previous(); }
  raise(): void { this._activePlayer()?.raise(); }

  wantPosition(owner: object, want: boolean): void {
    if (want)
      this._positionOwners.add(owner);
    else
      this._positionOwners.delete(owner);
    if (want && this._activeBusName)
      this._track.ensureLength(this._activeBusName);
    this._emit();
  }

  protected start(): void {
    const cache = new ArtCache();
    this._artCache = cache;
    this._track.setArtCache(cache);
    const source = shellMprisSource();
    if (!source) {
      // The message list itself exists in every session mode; null here means the Shell's
      // internal structure no longer matches what shellMprisSource() expects.
      if (!this._loggedMissingSource) {
        this._loggedMissingSource = true;
        console.error('Desk Widgets: the Shell\'s MprisSource was not found');
      }
      this.publish({ player: null });
      return;
    }
    this._source = source;
    source.connectObject(
      'player-added', (_source: unknown, player: ShellMprisPlayer) => this._addPlayer(player),
      'player-removed', (_source: unknown, player: ShellMprisPlayer) => this._removePlayer(player),
      this,
    );
    for (const player of source.players)
      this._addPlayer(player);
    this._emit();
  }

  protected stop(): void {
    this._source?.disconnectObject(this);
    this._source = null;
    for (const record of this._players.values())
      record.player.disconnectObject(this);
    this._players.clear();
    this._positionPoll.stop();
    this._positionCancellable?.cancel();
    this._positionCancellable = null;
    this._positionOwners.clear();
    this._loggedPositionFailure.clear();
    this._track.stop();
    this._track.setArtCache(null);
    this._artCache?.destroy();
    this._artCache = null;
    this._activeBusName = null;
    this._trackKey = null;
    this._position = null;
  }

  private _activePlayer(): ShellMprisPlayer | null {
    return this._activeBusName ? this._players.get(this._activeBusName)?.player ?? null : null;
  }

  private _addPlayer(player: ShellMprisPlayer): void {
    const busName = mprisBusName(player);
    if (busName === null) {
      if (!loggedMissingBusName) {
        loggedMissingBusName = true;
        console.error('Desk Widgets: a media player has no readable bus name; skipping it');
      }
      return;
    }
    if (this._players.has(busName))
      return;
    const status = statusOf(player);
    this._players.set(busName, { player, lastPlayingAt: status === 'Playing' ? Date.now() : 0, previousStatus: status });
    player.connectObject('changed', () => this._onPlayerChanged(busName), this);
    this._emit();
  }

  private _removePlayer(player: ShellMprisPlayer): void {
    const busName = mprisBusName(player);
    if (busName === null || !this._players.delete(busName))
      return;
    player.disconnectObject(this);
    this._loggedPositionFailure.delete(busName);
    this._emit();
  }

  // Stamps lastPlayingAt only on a genuine not-Playing -> Playing transition, not on every
  // 'changed' signal — otherwise a player already Playing in the background re-stamps itself as
  // "most recently started" on every track advance and steals active-player status right back.
  private _onPlayerChanged(busName: string): void {
    const record = this._players.get(busName);
    if (!record)
      return;
    const status = statusOf(record.player);
    if (status === 'Playing' && record.previousStatus !== 'Playing')
      record.lastPlayingAt = Date.now();
    record.previousStatus = status;
    this._emit();
  }

  private _emit(): void {
    const states: PlayerState[] = [...this._players.entries()].map(([id, record]) => ({
      id, status: statusOf(record.player), lastPlayingAt: record.lastPlayingAt,
    }));
    const activeId = pickActivePlayer(states);

    if (activeId !== this._activeBusName) {
      this._activeBusName = activeId;
      // Forces the track-change branch below to refresh art/length for the new player, even if
      // it happens to share its current track's title/artists/cover with the previous one.
      this._trackKey = null;
      this._positionPoll.reset();
    }
    if (!activeId) {
      this._armPoll();
      this.publish({ player: null });
      return;
    }

    const record = this._players.get(activeId)!;
    const player = record.player;
    const key = trackKeyOf(player);
    if (key !== this._trackKey) {
      this._trackKey = key;
      this._position = null;
      // A position fetch already in flight belongs to the track that just ended; its eventual
      // reply is a position for a track no longer playing and must never be accepted.
      this._positionPoll.reset();
      this._track.trackChanged(player, activeId, this._positionOwners.size > 0);
    }
    this._armPoll();

    const wantsPosition = this._positionOwners.size > 0;
    this.publish({
      player: {
        id: activeId,
        app: player.app?.get_name() ?? '',
        title: player.trackTitle,
        artists: player.trackArtists.join(', '),
        status: statusOf(player),
        artPath: this._track.artPath,
        appIcon: player.app?.get_icon() ?? null,
        canPlay: player.canPlay,
        canNext: player.canGoNext,
        canPrevious: player.canGoPrevious,
        position: wantsPosition ? this._position : null,
        length: wantsPosition ? this._track.length : null,
      },
    });
  }

  private _armPoll(): void {
    const record = this._activeBusName ? this._players.get(this._activeBusName) : undefined;
    const status = record ? statusOf(record.player) : null;
    const wanted = this._positionOwners.size > 0 && (status === 'Playing' || status === 'Paused');
    this._positionPoll.setWanted(wanted, status === 'Playing' ? PLAYING_POLL_MS : PAUSED_POLL_MS);
  }

  private _onPositionResult(value: number | null): void {
    if (!this.running)
      return;
    this._position = value;
    this._emit();
  }

  // The generation argument is PositionPoll's own bookkeeping; a fresh busName is read below
  // regardless of which generation this call belongs to.
  private async _fetchPosition(_generation: number): Promise<number | null> {
    const busName = this._activeBusName;
    if (!busName)
      return null;
    const cancellable = new Gio.Cancellable();
    this._positionCancellable?.cancel();
    this._positionCancellable = cancellable;
    try {
      const value = await getPlayerProperty(busName, 'Position', cancellable);
      return typeof value === 'number' ? value / 1_000_000 : null;
    } catch (e) {
      // Logged once per player, not every tick: a player that can't answer Position tends to
      // keep not answering it for as long as it stays active.
      if (!isCancelled(e) && !this._loggedPositionFailure.has(busName)) {
        this._loggedPositionFailure.add(busName);
        console.error('Desk Widgets: polling track position failed', e);
      }
      throw e;
    }
  }
}
