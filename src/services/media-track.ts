// Everything MediaService tracks about the *current* track: its resolved art path (and the
// fetch behind it), its length (read once per track over D-Bus, with one retry if it initially
// comes back empty), and the cancellables/timer backing both. trackChanged() is the one entry
// point for moving on to a different track — whether that's the same player advancing to its
// next song, or the active player switching outright — and it always clears both art and length
// length outright, cancelling whatever was still in flight for the track that just ended, so a
// new song never shows the previous one's length. Art is kept when the new track has the same
// cover URL (the next song on the same album), so it doesn't flicker to the app icon.
import Gio from 'gi://Gio';
import type { ShellMprisPlayer } from '../shell/shell-private.ts';
import type { ArtCache } from './art-cache.ts';
import { isCancelled } from './gio-file.ts';
import { getPlayerProperty } from './mpris-properties.ts';
import type { Scheduler } from './service.ts';

const LENGTH_RETRY_MS = 800;

export class TrackDetails {
  private readonly _ticks: Scheduler;
  private readonly _onChange: () => void;
  private _cache: ArtCache | null = null;

  private _artUrl: string | null = null;
  private _artPath: string | null = null;
  private _artSeq = 0;
  private _artCancellable: Gio.Cancellable | null = null;

  private _length: number | null = null;
  private _metadataCancellable: Gio.Cancellable | null = null;
  private _lengthRetried = false;
  private _lengthRetryTick: number | null = null;

  constructor(scheduler: Scheduler, onChange: () => void) {
    this._ticks = scheduler;
    this._onChange = onChange;
  }

  get artPath(): string | null {
    return this._artPath;
  }

  get length(): number | null {
    return this._length;
  }

  setArtCache(cache: ArtCache | null): void {
    this._cache = cache;
  }

  // A different track is now current: cancel whatever art/length fetch was still in flight for
  // the one that just ended (its eventual reply, cancelled or not, must never be applied here),
  // clear both outright, and kick off a fresh art fetch (always) and length read (only while
  // `wantLength` — i.e. some widget currently cares about position/length at all).
  trackChanged(player: ShellMprisPlayer, busName: string, wantLength: boolean): void {
    const sameCover = player.trackCoverUrl !== '' && player.trackCoverUrl === this._artUrl;
    if (!sameCover) {
      this._artPath = null;
      this._artCancellable?.cancel();
      this._artCancellable = null;
    }
    this._length = null;
    this._metadataCancellable?.cancel();
    this._metadataCancellable = null;
    this._cancelLengthRetry();
    this._lengthRetried = false;
    if (!sameCover)
      void this._refreshArt(player);
    if (wantLength)
      void this._refreshLength(busName);
  }

  // Called when a widget starts wanting position/length (wantPosition(true)) and the current
  // track's length isn't known yet.
  ensureLength(busName: string): void {
    if (this._length === null)
      void this._refreshLength(busName);
  }

  stop(): void {
    this._artCancellable?.cancel();
    this._artCancellable = null;
    this._metadataCancellable?.cancel();
    this._metadataCancellable = null;
    this._cancelLengthRetry();
    this._artPath = null;
    this._artUrl = null;
    this._length = null;
    this._lengthRetried = false;
  }

  private async _refreshArt(player: ShellMprisPlayer): Promise<void> {
    const cache = this._cache;
    if (!cache)
      return;
    const url = player.trackCoverUrl;
    this._artUrl = url;
    const seq = ++this._artSeq;
    if (!url) {
      this._artCancellable?.cancel();
      this._artCancellable = null;
      this._onChange();
      return;
    }
    const cancellable = new Gio.Cancellable();
    this._artCancellable?.cancel();
    this._artCancellable = cancellable;
    try {
      const path = await cache.resolve(url, cancellable);
      // A later call (a further track change, or this same one racing a new resolve) has
      // already taken over; this result belongs to a URL nobody wants anymore.
      if (seq !== this._artSeq)
        return;
      this._artPath = path;
      this._onChange();
    } catch (e) {
      if (!isCancelled(e))
        console.error('Desk Widgets: resolving track art failed', e);
    }
  }

  private async _refreshLength(busName: string): Promise<void> {
    const cancellable = new Gio.Cancellable();
    this._metadataCancellable?.cancel();
    this._metadataCancellable = cancellable;
    try {
      const metadata = await getPlayerProperty(busName, 'Metadata', cancellable) as Record<string, unknown>;
      const lengthUs = metadata['mpris:length'];
      this._length = typeof lengthUs === 'number' ? lengthUs / 1_000_000 : null;
      this._onChange();
      if (this._length === null && !this._lengthRetried) {
        this._lengthRetried = true;
        this._cancelLengthRetry();
        this._lengthRetryTick = this._ticks.schedule(LENGTH_RETRY_MS, () => {
          this._lengthRetryTick = null;
          void this._refreshLength(busName);
        });
      }
    } catch (e) {
      if (!isCancelled(e))
        console.error('Desk Widgets: reading track length failed', e);
    }
  }

  private _cancelLengthRetry(): void {
    if (this._lengthRetryTick !== null) {
      this._ticks.cancel(this._lengthRetryTick);
      this._lengthRetryTick = null;
    }
  }
}
