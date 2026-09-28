// When the widget layer should be dimmed.

export type DimMode = 'automatic' | 'always' | 'never';

const DIM_MODES: ReadonlySet<string> = new Set(['automatic', 'always', 'never']);

export function isDimMode(v: string): v is DimMode {
  return DIM_MODES.has(v);
}

export function shouldDim(mode: DimMode, covered: boolean, editing: boolean): boolean {
  if (editing)
    return false;
  return mode === 'always' || (mode === 'automatic' && covered);
}
