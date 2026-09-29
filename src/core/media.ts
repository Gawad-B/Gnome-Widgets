// Pure media-data helpers: no gi:// imports. Shared by services/media.ts (active-player choice,
// elapsed-time formatting) and services/art-cache.ts (the cache filename and pruning), and
// unit-tested under Node.

// Formats a duration in seconds as "m:ss" or "h:mm:ss" (e.g. "0:07", "3:45", "1:02:03").
// Negative or non-finite input (a player that hasn't reported a position yet) is "".
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0)
    return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export interface PlayerState {
  id: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  lastPlayingAt: number;
}

// The active player is whichever most recently entered the Playing state; if none ever has
// (every lastPlayingAt is 0, e.g. right after startup before any 'changed' signal lands), the
// first player already Playing; otherwise just the first player. null when there are none.
export function pickActivePlayer(players: readonly PlayerState[]): string | null {
  if (players.length === 0)
    return null;
  let best: PlayerState | null = null;
  for (const player of players) {
    if (player.lastPlayingAt > 0 && (best === null || player.lastPlayingAt > best.lastPlayingAt))
      best = player;
  }
  if (best)
    return best.id;
  const playing = players.find(player => player.status === 'Playing');
  return (playing ?? players[0]!).id;
}

// The files pruneList would delete: everything past the newest `keep` by mtime (ties broken by
// input order). Returns [] once files.length <= keep.
export function pruneList<T extends { mtime: number }>(files: readonly T[], keep: number): T[] {
  return [...files].sort((a, b) => b.mtime - a.mtime).slice(keep);
}

// A from-scratch, dependency-free SHA-1 (FIPS 180-1) over raw bytes, so the cache key stays pure
// and testable under Node like the rest of this file. Used only to name cached art files, never
// for anything security-sensitive.
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function sha1Hex(data: Uint8Array): string {
  const h = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0);
  const bitLength = data.length * 8;
  const paddedLength = (data.length + 9 + 63) & ~63;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  // A 64-bit big-endian bit count; bitLength fits in 32 bits for anything this cache ever
  // hashes (a URL), so the high word is always 0.
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Uint32Array(80);
  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i++)
      w[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 80; i++)
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);

    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
  }
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}

const utf8Encoder = new TextEncoder();

// The cache filename for a piece of art: the SHA-1 hex digest of the UTF-8 art URL.
export function artCacheName(url: string): string {
  return sha1Hex(utf8Encoder.encode(url));
}
