// Milliseconds from `nowMs` until the next multiple of `periodMs`. A time exactly on a
// boundary waits a full period, so a timer that fires on time never schedules a 0 ms repeat.
export function msUntilNext(nowMs: number, periodMs: number): number {
  return periodMs - (nowMs % periodMs);
}
