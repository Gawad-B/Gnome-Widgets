// The persisted widget layout: parsing with validation and migration, serialization, ids.
// Pure TypeScript (no GNOME imports) so it is unit-tested under Node.
import { isSizeName, type SizeName } from './grid.ts';

export const LAYOUT_VERSION = 1;

export interface WidgetEntry {
  id: string;
  type: string;
  size: SizeName;
  col: number;
  row: number;
  config: Record<string, unknown>;
}

export interface Layout {
  version: typeof LAYOUT_VERSION;
  widgets: WidgetEntry[];
}

export type ParseResult =
  | { ok: true; layout: Layout }
  | { ok: false; reason: 'empty' | 'invalid'; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCellIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

const invalid = (error: string): ParseResult => ({ ok: false, reason: 'invalid', error });

// Version 0 (pre-release builds) stored the bare widget array.
function migrate(data: unknown): unknown {
  return Array.isArray(data) ? { version: 1, widgets: data } : data;
}

function parseEntry(value: unknown, index: number): WidgetEntry | string {
  const at = `widgets[${index}]`;
  if (!isRecord(value))
    return `${at} is not an object`;
  const { id, type, size, col, row } = value;
  const config = value.config ?? {};
  if (typeof id !== 'string' || id === '')
    return `${at}.id must be a non-empty string`;
  if (typeof type !== 'string' || type === '')
    return `${at}.type must be a non-empty string`;
  if (!isSizeName(size))
    return `${at}.size must be one of S, M, L, XL`;
  if (!isCellIndex(col) || !isCellIndex(row))
    return `${at}.col and .row must be non-negative integers`;
  if (!isRecord(config))
    return `${at}.config must be an object`;
  return { id, type, size, col, row, config: { ...config } };
}

export function parseLayout(raw: string): ParseResult {
  if (raw.trim() === '')
    return { ok: false, reason: 'empty', error: 'layout is empty' };

  let data: unknown;
  try {
    data = migrate(JSON.parse(raw));
  } catch (e) {
    return invalid(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(data) || data.version !== LAYOUT_VERSION || !Array.isArray(data.widgets))
    return invalid(`expected {"version": ${LAYOUT_VERSION}, "widgets": [...]}`);

  const widgets: WidgetEntry[] = [];
  const ids = new Set<string>();
  for (const [index, value] of data.widgets.entries()) {
    const entry = parseEntry(value, index);
    if (typeof entry === 'string')
      return invalid(entry);
    if (ids.has(entry.id))
      return invalid(`duplicate widget id ${entry.id}`);
    ids.add(entry.id);
    widgets.push(entry);
  }
  return { ok: true, layout: { version: LAYOUT_VERSION, widgets } };
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout);
}

export function newId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = Math.floor(random() * 0x1000000).toString(16).padStart(6, '0');
    if (!taken.has(id))
      return id;
  }
}

const DEFAULT_WIDGETS: ReadonlyArray<Omit<WidgetEntry, 'id' | 'config'>> = [
  { type: 'clock', size: 'S', col: 0, row: 0 },
  { type: 'weather', size: 'M', col: 1, row: 0 },
];

// First-run layout, limited to widget types the registry knows.
export function defaultLayout(known: ReadonlySet<string>, random: () => number = Math.random): Layout {
  const ids = new Set<string>();
  const widgets: WidgetEntry[] = [];
  for (const widget of DEFAULT_WIDGETS) {
    if (!known.has(widget.type))
      continue;
    const id = newId(ids, random);
    ids.add(id);
    widgets.push({ id, ...widget, config: {} });
  }
  return { version: LAYOUT_VERSION, widgets };
}

// Entries whose type is not registered stay in the layout but are not rendered or placed.
export function splitKnown(
  layout: Layout, known: ReadonlySet<string>,
): { known: WidgetEntry[]; unknown: WidgetEntry[] } {
  return {
    known: layout.widgets.filter(w => known.has(w.type)),
    unknown: layout.widgets.filter(w => !known.has(w.type)),
  };
}
