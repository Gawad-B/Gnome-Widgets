// Serializes async writes that share a key (typically a file path), so two overlapping writes
// to the same destination can never finish out of order and leave a stale one as the last word
// on disk. Each write only runs once every earlier one for its key has settled, and only reads
// whatever it captures at that point - never a snapshot taken back when it was queued.
const chains = new Map<string, Promise<void>>();

// The write currently in flight (or already finished) for `key`, or an already-resolved promise
// if nothing is outstanding. A caller that only needs to know "nothing is writing right now"
// (a fresh load, before it reads) awaits this directly, without enqueuing anything itself.
export function currentWrite(key: string): Promise<void> {
  return chains.get(key) ?? Promise.resolve();
}

export function enqueueWrite(key: string, run: () => Promise<void>): Promise<void> {
  const next = currentWrite(key).then(run, run);
  // The stored link must never itself become a rejected promise, or the *next* write's
  // `.then(run, run)` would still run `run` (both handlers do), but currentWrite() needs a
  // promise that settles, not one that throws past whoever is just awaiting it.
  chains.set(key, next.catch(() => undefined));
  return next;
}
