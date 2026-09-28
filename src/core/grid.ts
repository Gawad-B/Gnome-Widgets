// Grid math for the desktop layout: sizes, collisions, snapping and placement.
// Pure TypeScript (no GNOME imports) so it is unit-tested under Node.

export type SizeName = 'S' | 'M' | 'L' | 'XL';

export const SIZES: Readonly<Record<SizeName, { w: number; h: number }>> = {
  S: { w: 1, h: 1 },
  M: { w: 2, h: 1 },
  L: { w: 2, h: 2 },
  XL: { w: 4, h: 2 },
};

export const MARGIN = 32;
export const CELL = 150;

export interface Cell { col: number; row: number }
export interface Placement extends Cell { id: string; size: SizeName }
export interface GridSize { cols: number; rows: number }
export interface Geometry extends GridSize { cell: number; gap: number; margin: number }
export interface Point { x: number; y: number }

export function isSizeName(v: unknown): v is SizeName {
  return typeof v === 'string' && Object.hasOwn(SIZES, v);
}

// Grid for an area of width×height logical pixels; cells start at (MARGIN, MARGIN).
export function computeGeometry(width: number, height: number, gap: number): Geometry {
  const fit = (length: number) => Math.max(0, Math.floor((length - 2 * MARGIN + gap) / (CELL + gap)));
  return { cols: fit(width), rows: fit(height), cell: CELL, gap, margin: MARGIN };
}

export function cellToPoint(geo: Geometry, cell: Cell): Point {
  const pitch = geo.cell + geo.gap;
  return { x: geo.margin + cell.col * pitch, y: geo.margin + cell.row * pitch };
}

export function spanPixels(geo: Geometry, size: SizeName): { width: number; height: number } {
  const { w, h } = SIZES[size];
  return { width: w * geo.cell + (w - 1) * geo.gap, height: h * geo.cell + (h - 1) * geo.gap };
}

export function fitsInGrid(grid: GridSize, size: SizeName, cell: Cell): boolean {
  const { w, h } = SIZES[size];
  return cell.col >= 0 && cell.row >= 0 && cell.col + w <= grid.cols && cell.row + h <= grid.rows;
}

export function collides(a: Placement, b: Placement): boolean {
  const sa = SIZES[a.size];
  const sb = SIZES[b.size];
  return a.col < b.col + sb.w && b.col < a.col + sa.w && a.row < b.row + sb.h && b.row < a.row + sa.h;
}

// True when `size` at `cell` is inside the grid and overlaps no placement other than `ignoreId`.
export function isFree(
  grid: GridSize, placements: readonly Placement[], size: SizeName, cell: Cell, ignoreId?: string,
): boolean {
  if (!fitsInGrid(grid, size, cell))
    return false;
  const probe: Placement = { id: '', size, col: cell.col, row: cell.row };
  return placements.every(other => other.id === ignoreId || !collides(probe, other));
}

// Nearest cell for a card whose top-left corner is at `point`, clamped so the card stays inside.
export function snap(geo: Geometry, size: SizeName, point: Point): Cell {
  const { w, h } = SIZES[size];
  const pitch = geo.cell + geo.gap;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(max, 0));
  return {
    col: clamp(Math.round((point.x - geo.margin) / pitch), geo.cols - w),
    row: clamp(Math.round((point.y - geo.margin) / pitch), geo.rows - h),
  };
}

// First free cell in row-major order, or null when the size fits nowhere.
export function autoPlace(grid: GridSize, placements: readonly Placement[], size: SizeName): Cell | null {
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (isFree(grid, placements, size, { col, row }))
        return { col, row };
    }
  }
  return null;
}

// Free cell closest to `from` by Manhattan distance (ties go to the first in row-major order).
export function nearestFree(
  grid: GridSize, placements: readonly Placement[], size: SizeName, from: Cell, ignoreId?: string,
): Cell | null {
  let best: Cell | null = null;
  let bestDistance = Infinity;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const distance = Math.abs(col - from.col) + Math.abs(row - from.row);
      if (distance < bestDistance && isFree(grid, placements, size, { col, row }, ignoreId)) {
        best = { col, row };
        bestDistance = distance;
      }
    }
  }
  return best;
}

// Fits placements into a (possibly smaller) grid. Entries that are inside and don't overlap an
// earlier entry keep their cell; the others are auto-placed in order; those with no room are hidden.
export function clampToGrid(
  grid: GridSize, placements: readonly Placement[],
): { placed: Placement[]; hidden: string[] } {
  const placed: Placement[] = [];
  const pending: Placement[] = [];
  for (const entry of placements)
    (isFree(grid, placed, entry.size, entry) ? placed : pending).push(entry);

  const hidden: string[] = [];
  for (const entry of pending) {
    const cell = autoPlace(grid, placed, entry.size);
    if (cell)
      placed.push({ ...entry, ...cell });
    else
      hidden.push(entry.id);
  }
  return { placed, hidden };
}

// Where widget `id` goes when resized: same top-left if it fits, else the nearest free cell.
export function resizeTarget(
  grid: GridSize, placements: readonly Placement[], id: string, size: SizeName,
): Cell | null {
  const current = placements.find(entry => entry.id === id);
  if (!current)
    return null;
  if (isFree(grid, placements, size, current, id))
    return { col: current.col, row: current.row };
  return nearestFree(grid, placements, size, current, id);
}
