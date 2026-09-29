import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuUsage, formatBytes, formatPercent, formatRate, memUsage, netRate, parseCpuTimes,
  parseMemInfo, parseNetDev, pushSample, HISTORY,
} from '../../src/core/sysstat.ts';

const STAT_A = 'cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\nintr 1 2 3\n';
const STAT_B = 'cpu  160 0 70 900 70 0 0 0 0 0\ncpu0 80 0 35 450 35 0 0 0 0 0\n';

test('parseCpuTimes sums user..steal as total and idle+iowait as idle', () => {
  assert.deepEqual(parseCpuTimes(STAT_A), { total: 1000, idle: 850 });
  assert.equal(parseCpuTimes('garbage'), null);
});

test('cpuUsage is the busy share of the delta, clamped to [0,1]', () => {
  const a = parseCpuTimes(STAT_A)!;
  const b = parseCpuTimes(STAT_B)!;          // total +200, idle +120 → busy 80/200
  assert.equal(cpuUsage(a, b), 0.4);
  assert.equal(cpuUsage(a, a), 0);           // no elapsed ticks
  assert.equal(cpuUsage(b, a), 0);           // counters went backwards
});

const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:    6000000 kB\nBuffers:          100 kB\n';

test('parseMemInfo reads MemTotal and MemAvailable in bytes', () => {
  assert.deepEqual(parseMemInfo(MEMINFO), { total: 16000000 * 1024, available: 6000000 * 1024 });
  assert.equal(memUsage(parseMemInfo(MEMINFO)!), 0.625);
  assert.equal(parseMemInfo('MemTotal: 1 kB\n'), null);
});

const NETDEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
wlp1s0: 1000 20 0 0 0 0 0 0 300 5 0 0 0 0 0 0
  eth0: 200 2 0 0 0 0 0 0 100 1 0 0 0 0 0 0
veth12ab: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
docker0: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
`;

test('parseNetDev sums real interfaces, skipping loopback and virtual bridges', () => {
  assert.deepEqual(parseNetDev(NETDEV), { rx: 1200, tx: 400 });
});

test('netRate is bytes per second, and a counter reset reads as 0', () => {
  assert.deepEqual(netRate({ rx: 1000, tx: 100 }, { rx: 3000, tx: 500 }, 2), { rx: 1000, tx: 200 });
  assert.deepEqual(netRate({ rx: 3000, tx: 500 }, { rx: 10, tx: 10 }, 2), { rx: 0, tx: 0 });
  assert.deepEqual(netRate({ rx: 0, tx: 0 }, { rx: 10, tx: 10 }, 0), { rx: 0, tx: 0 });
});

test('pushSample keeps the newest HISTORY samples', () => {
  let h: number[] = [];
  for (let i = 0; i < HISTORY + 5; i++)
    h = pushSample(h, i);
  assert.equal(h.length, HISTORY);
  assert.equal(h[0], 5);
  assert.equal(h[HISTORY - 1], HISTORY + 4);
});

test('formatting uses binary units', () => {
  assert.equal(formatPercent(0.374), '37%');
  assert.equal(formatPercent(1.2), '100%');
  assert.equal(formatRate(0), '0 B/s');
  assert.equal(formatRate(900), '900 B/s');
  assert.equal(formatRate(12_300), '12 KB/s');      // 12300 / 1024 = 12.01
  assert.equal(formatRate(3_400_000), '3.2 MB/s');  // 3400000 / 1024² = 3.24
  assert.equal(formatBytes(8_375_000_000), '7.8 GB');
});

test('guest time is not double-counted: user and nice already include it', () => {
  // Fields 9-10 (guest, guest_nice) are nonzero; only fields 1-8 may be summed.
  assert.deepEqual(parseCpuTimes('cpu  100 0 50 800 50 0 0 0 300 20\n'), { total: 1000, idle: 850 });
});

test('parseNetDev handles a missing space after the colon and counters past 2^32', () => {
  const text = 'h1\nh2\nwlp1s0:4294967296 1 0 0 0 0 0 0 8589934592 1 0 0 0 0 0 0\n';
  assert.deepEqual(parseNetDev(text), { rx: 4294967296, tx: 8589934592 });
});

test('parseNetDev skips VPN tunnels and podman bridges', () => {
  const text = 'h1\nh2\n wg0: 50 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\ntun0: 50 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\n'
    + 'podman0: 50 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\n eth0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n';
  assert.deepEqual(parseNetDev(text), { rx: 10, tx: 20 });
});

test('parseMemInfo returns null when MemAvailable is missing among other lines', () => {
  assert.equal(parseMemInfo('MemTotal: 16000000 kB\nMemFree: 2000000 kB\nBuffers: 100 kB\n'), null);
});
