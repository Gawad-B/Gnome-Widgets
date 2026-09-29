// Parsing and formatting for /proc-derived system stats. No gi:// imports: this runs under
// Node in tests, and the Shell-facing service in src/services/system.ts is the only caller
// that reads the actual files.

export interface CpuTimes { total: number; idle: number }
export interface MemInfo { total: number; available: number }   // bytes
export interface NetTotals { rx: number; tx: number }            // bytes

export const HISTORY = 60;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// The first line of /proc/stat: "cpu  user nice system idle iowait irq softirq steal ...".
// Fields beyond steal (guest, guest_nice) exist on some kernels but aren't counted here.
export function parseCpuTimes(stat: string): CpuTimes | null {
  const line = stat.split('\n', 1)[0] ?? '';
  if (!line.startsWith('cpu '))
    return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 8 || fields.some(n => Number.isNaN(n)))
    return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields as [
    number, number, number, number, number, number, number, number,
  ];
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait };
}

export function cpuUsage(prev: CpuTimes, next: CpuTimes): number {
  const dt = next.total - prev.total;
  if (dt <= 0)
    return 0;
  return clamp01((dt - (next.idle - prev.idle)) / dt);
}

// /proc/meminfo: "Key:     value kB". Returns null unless both MemTotal and MemAvailable are
// present, since a kernel too old to report MemAvailable would otherwise silently read as 0.
export function parseMemInfo(text: string): MemInfo | null {
  let total: number | null = null;
  let available: number | null = null;
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (!match)
      continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (key === 'MemTotal')
      total = Number(value) * 1024;
    else if (key === 'MemAvailable')
      available = Number(value) * 1024;
  }
  return total !== null && available !== null ? { total, available } : null;
}

export function memUsage(m: MemInfo): number {
  if (m.total <= 0)
    return 0;
  return clamp01((m.total - m.available) / m.total);
}

// /proc/net/dev: two header lines, then "name: rx-bytes ... (7 more) tx-bytes ...". Loopback and
// virtual bridges/tunnels are excluded so the total reflects real network traffic: container
// bridges and VPN tunnels carry bytes that also cross the physical interface, so counting them
// too would roughly double the rate.
const SKIP_PREFIXES = ['veth', 'docker', 'br-', 'virbr', 'vnet', 'podman', 'cni-', 'tun', 'tap', 'wg', 'tailscale', 'zt'];

export function parseNetDev(text: string): NetTotals {
  let rx = 0;
  let tx = 0;
  const lines = text.split('\n').slice(2);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0)
      continue;
    const name = line.slice(0, colon).trim();
    if (!name || name === 'lo' || SKIP_PREFIXES.some(p => name.startsWith(p)))
      continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (Number.isNaN(rxBytes) || Number.isNaN(txBytes))
      continue;
    rx += rxBytes;
    tx += txBytes;
  }
  return { rx, tx };
}

// Bytes per second between two totals, `seconds` apart. A counter reset (next < prev, e.g. an
// interface going down and back up) reads as 0 rather than a huge negative rate.
export function netRate(prev: NetTotals, next: NetTotals, seconds: number): NetTotals {
  if (seconds <= 0)
    return { rx: 0, tx: 0 };
  return {
    rx: Math.max(0, next.rx - prev.rx) / seconds,
    tx: Math.max(0, next.tx - prev.tx) / seconds,
  };
}

export function pushSample(history: readonly number[], value: number, cap: number = HISTORY): number[] {
  const next = [...history, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

// Shared stepping for formatBytes/formatRate: steps at 1024, B/KB as integers, MB/GB with one
// decimal place.
function formatBinary(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit < 2 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

export function formatBytes(n: number): string {
  return formatBinary(n);
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBinary(bytesPerSecond)}/s`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}
