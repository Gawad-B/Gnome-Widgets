// Weather forecast shaping for the widget. Pure: unit-tested under Node.
import { startOfDay } from './calendar-math.ts';

export interface ForecastPoint { time: number; temp: number; icon: string }
export interface DailyForecast { day: Date; min: number; max: number; icon: string }

const HOUR = 3600;

// Up to `count` points from now on, at least an hour apart (the Shell's top-bar weather rule).
export function nextHours(points: readonly ForecastPoint[], nowSec: number, count: number): ForecastPoint[] {
  if (count <= 0)
    return [];
  const result: ForecastPoint[] = [];
  let last = -Infinity;
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    if (point.time < nowSec || point.time - last < HOUR)
      continue;
    result.push(point);
    last = point.time;
    if (result.length === count)
      break;
  }
  return result;
}

// A point that reasonably represents daytime: within the day's usual daylight span and not
// carrying a night icon (the weather source can still tag an in-range hour as night near
// sunrise/sunset, and we want to skip those for a "what does the day look like" icon).
function isDaytime(point: ForecastPoint): boolean {
  const hour = new Date(point.time * 1000).getHours();
  return hour >= 6 && hour <= 18 && !point.icon.includes('-night');
}

// The point closest to local midday, breaking ties by the earlier one — deterministic
// regardless of the order `points` happens to arrive in.
function closestToMidday(points: readonly ForecastPoint[]): ForecastPoint {
  return points.reduce((best, x) => {
    const dx = Math.abs(new Date(x.time * 1000).getHours() - 12);
    const dbest = Math.abs(new Date(best.time * 1000).getHours() - 12);
    if (dx !== dbest)
      return dx < dbest ? x : best;
    return x.time < best.time ? x : best;
  });
}

// One entry per local day from today: min/max temperature and the icon closest to midday.
export function dailyForecast(points: readonly ForecastPoint[], now: Date, count: number): DailyForecast[] {
  const today = startOfDay(now).getTime();
  const byDay = new Map<number, ForecastPoint[]>();
  for (const point of points) {
    const day = startOfDay(new Date(point.time * 1000)).getTime();
    if (day < today)
      continue;
    const list = byDay.get(day) ?? [];
    list.push(point);
    byDay.set(day, list);
  }
  return [...byDay.keys()].sort((a, b) => a - b).slice(0, count).map(day => {
    const list = byDay.get(day)!;
    const temps = list.map(x => x.temp);
    const daytime = list.filter(isDaytime);
    const midday = closestToMidday(daytime.length > 0 ? daytime : list);
    return { day: new Date(day), min: Math.min(...temps), max: Math.max(...temps), icon: midday.icon };
  });
}

export function formatTemp(v: number): string {
  const rounded = Math.round(v);
  // The template literal below already prints -0 as "0" on its own, but this guard keeps the
  // same result if formatting ever switches to something locale-aware (e.g. toLocaleString()),
  // which does render the sign of -0.
  return `${Object.is(rounded, -0) ? 0 : rounded}°`;
}
