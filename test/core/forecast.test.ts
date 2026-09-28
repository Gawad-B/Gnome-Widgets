import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyForecast, formatTemp, nextHours, type ForecastPoint } from '../../src/core/forecast.ts';

const at = (y: number, m: number, day: number, h: number) => new Date(y, m - 1, day, h).getTime() / 1000;
const p = (time: number, temp: number, icon = 'weather-clear-symbolic'): ForecastPoint => ({ time, temp, icon });

test('nextHours skips the past and keeps points at least an hour apart', () => {
  const now = at(2026, 9, 26, 12);
  const pts = [p(at(2026, 9, 26, 11), 1), p(now + 1800, 2), p(now + 3600, 3), p(now + 5400, 4), p(now + 7200, 5)];
  assert.deepEqual(nextHours(pts, now, 5).map(x => x.temp), [2, 4]);
  assert.deepEqual(nextHours(pts, now, 1).map(x => x.temp), [2]);
});

test('nextHours sorts unsorted input', () => {
  const now = at(2026, 9, 26, 12);
  assert.deepEqual(nextHours([p(now + 7200, 2), p(now, 1)], now, 5).map(x => x.temp), [1, 2]);
});

test('nextHours with count 0 (or negative) returns nothing, even with matching points', () => {
  const now = at(2026, 9, 26, 12);
  assert.deepEqual(nextHours([p(now, 1), p(now + 3600, 2)], now, 0), []);
  assert.deepEqual(nextHours([p(now, 1)], now, -1), []);
});

test('dailyForecast groups by local day from today, min/max, icon nearest midday', () => {
  const now = new Date(2026, 8, 26, 15);
  const pts = [
    p(at(2026, 9, 25, 12), 99),
    p(at(2026, 9, 26, 9), 20, 'a'), p(at(2026, 9, 26, 13), 28, 'b'), p(at(2026, 9, 26, 21), 22, 'c'),
    p(at(2026, 9, 27, 6), 18, 'd'), p(at(2026, 9, 27, 12), 26, 'e'),
    p(at(2026, 9, 28, 12), 25, 'f'),
  ];
  const days = dailyForecast(pts, now, 2);
  assert.equal(days.length, 2);
  assert.deepEqual(days.map(x => [x.day.getDate(), x.min, x.max, x.icon]), [[26, 20, 28, 'b'], [27, 18, 26, 'e']]);
});

test('dailyForecast prefers a daytime, non-night icon over a closer-to-midday night-tagged one', () => {
  const now = new Date(2026, 8, 26, 9);
  // 11:00 is closer to midday but tagged as a night icon (e.g. an early, still-dark reading);
  // 15:00 is farther from midday but is the icon that actually describes the daytime.
  const pts = [p(at(2026, 9, 26, 11), 20, 'weather-clear-night-symbolic'), p(at(2026, 9, 26, 15), 25, 'weather-few-clouds-symbolic')];
  const days = dailyForecast(pts, now, 1);
  assert.equal(days[0]?.icon, 'weather-few-clouds-symbolic');
});

test('dailyForecast falls back to the closest-to-midday point when every point that day is night-tagged or outside 06:00-18:00', () => {
  const now = new Date(2026, 8, 26, 9);
  const pts = [p(at(2026, 9, 26, 22), 20, 'weather-clear-night-symbolic'), p(at(2026, 9, 26, 23), 19, 'weather-clear-night-symbolic')];
  const days = dailyForecast(pts, now, 1);
  assert.equal(days[0]?.icon, 'weather-clear-night-symbolic');
  assert.equal(days[0]?.min, 19);
  assert.equal(days[0]?.max, 20);
});

test('dailyForecast breaks an equal-distance-to-midday tie by the earlier point, regardless of input order', () => {
  const now = new Date(2026, 8, 27, 0);
  const eleven = p(at(2026, 9, 27, 11), 11, 'eleven');
  const thirteen = p(at(2026, 9, 27, 13), 13, 'thirteen');
  assert.equal(dailyForecast([eleven, thirteen], now, 1)[0]?.icon, 'eleven');
  assert.equal(dailyForecast([thirteen, eleven], now, 1)[0]?.icon, 'eleven');
});

test('formatTemp rounds and never prints negative zero', () => {
  assert.equal(formatTemp(23.6), '24°');
  assert.equal(formatTemp(-0.4), '0°');
  assert.equal(formatTemp(-3.5), '-3°');
});
