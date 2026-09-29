// UPower enum mapping and formatting for battery data. No gi:// imports: this runs under Node
// in tests, and the Shell-facing service in src/services/battery.ts is the only caller that
// talks to the real D-Bus proxies.

export type ChargeState = 'charging' | 'discharging' | 'full' | 'empty' | 'pending' | 'unknown';

// UPower's Device.State: 1 charging, 2 discharging, 3 empty, 4 full, 5 pending-charge,
// 6 pending-discharge. Everything else (including 0, unknown) reads as 'unknown'.
export function chargeState(upowerState: number): ChargeState {
  switch (upowerState) {
  case 1: return 'charging';
  case 2: return 'discharging';
  case 3: return 'empty';
  case 4: return 'full';
  case 5:
  case 6: return 'pending';
  default: return 'unknown';
  }
}

export interface PeripheralInfo { id: string; kind: number; name: string; percent: number; state: ChargeState }

// UPower's Device.Type values this extension shows as a peripheral. Type 1 (line power) and
// Type 2 (battery, the laptop itself) are never peripherals.
const PERIPHERAL_LABELS: ReadonlyMap<number, string> = new Map([
  [5, 'Mouse'],
  [6, 'Keyboard'],
  [12, 'Controller'],
  [13, 'Pen'],
  [14, 'Touchpad'],
  [17, 'Headset'],
  [19, 'Headphones'],
  [21, 'Audio device'],
]);

export function peripheralLabel(kind: number): string | null {
  return PERIPHERAL_LABELS.get(kind) ?? null;
}

const PERIPHERAL_ICONS: ReadonlyMap<number, string> = new Map([
  [5, 'input-mouse-symbolic'],
  [6, 'input-keyboard-symbolic'],
  [12, 'input-gaming-symbolic'],
  [13, 'input-tablet-symbolic'],
  [14, 'input-touchpad-symbolic'],
  [17, 'audio-headset-symbolic'],
  [19, 'audio-headphones-symbolic'],
  [21, 'audio-headphones-symbolic'],
]);

export function peripheralIcon(kind: number): string {
  return PERIPHERAL_ICONS.get(kind) ?? 'battery-symbolic';
}

// Sort order for the peripheral rows: headphones/headset first, then mouse, keyboard,
// controller, and finally anything else, each group alphabetized by name.
const KIND_ORDER: ReadonlyMap<number, number> = new Map([
  [17, 0], [19, 0], [21, 0],  // headset, headphones, audio device
  [5, 1],                     // mouse
  [6, 2],                     // keyboard
  [12, 3],                    // controller
]);

const kindRank = (kind: number): number => KIND_ORDER.get(kind) ?? 4;

export function pickPeripherals(devices: readonly PeripheralInfo[], max = 5): PeripheralInfo[] {
  return devices
    .filter(d => peripheralLabel(d.kind) !== null)
    .slice()
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name))
    .slice(0, max);
}

// "2 h 15 min", "45 min", "1 h", or "" for a non-positive duration.
export function formatDuration(seconds: number): string {
  if (seconds <= 0)
    return '';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0)
    return `${minutes} min`;
  if (minutes <= 0)
    return `${hours} h`;
  return `${hours} h ${minutes} min`;
}
