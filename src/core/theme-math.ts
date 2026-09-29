// Card surface styling from the translucency slider. Pure: returns CSS strings.

export type ColorMode = 'light' | 'dark';

export interface CardStyle {
  css: string;
  // Rings and graphs switch from filled tracks to outlines once the card is mostly clear.
  outlineTracks: boolean;
}

type Rgb = readonly [number, number, number];

const SURFACE: Record<ColorMode, Rgb> = { dark: [30, 30, 30], light: [250, 250, 250] };
const EDGE: Record<ColorMode, Rgb> = { dark: [255, 255, 255], light: [0, 0, 0] };
// Content shadow contrasts with the text: dark shadow under white text, light glow under dark text.
const CONTENT_SHADOW: Record<ColorMode, Rgb> = { dark: [0, 0, 0], light: [255, 255, 255] };
const BLACK: Rgb = [0, 0, 0];

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r}, ${g}, ${b}, ${round3(alpha)})`;

// Text/icon shadow lines, shared by the plain and glass surfaces: empty below 50% translucency,
// rising linearly to a fixed peak at full translucency.
function contentShadowCss(mode: ColorMode, t: number): string[] {
  const shadowAlpha = t <= 0.5 ? 0 : ((t - 0.5) / 0.5) * 0.6;
  if (shadowAlpha <= 0)
    return [];
  const shadow = `0 1px 3px ${rgba(CONTENT_SHADOW[mode], shadowAlpha)}`;
  return [`text-shadow: ${shadow};`, `icon-shadow: ${shadow};`];
}

export function cardStyle(mode: ColorMode, translucency: number): CardStyle {
  const t = Math.min(Math.max(translucency, 0), 100) / 100;
  const solid = 1 - t;
  const parts = [
    `background-color: ${rgba(SURFACE[mode], 0.85 * solid)};`,
    `border: 1px solid ${rgba(EDGE[mode], 0.12 * solid)};`,
    `box-shadow: 0 2px 12px 0 ${rgba(BLACK, 0.25 * solid)};`,
    ...contentShadowCss(mode, t),
  ];
  return { css: parts.join(' '), outlineTracks: t >= 0.5 };
}

export interface DimLook {
  opacity: number; // 0..255
  desaturate: boolean;
}

// Dimmed widgets fade to 65%; below 50% translucency they also lose their color.
export function dimLook(translucency: number): DimLook {
  return { opacity: 166, desaturate: translucency < 50 };
}

// Glass backdrop blur radius, in pixels; `t` is translucency as a 0..1 fraction. Grows with
// translucency so a clearer glass card blurs the wallpaper behind it more, not less.
export function glassBlurRadius(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return Math.round(8 + 32 * clamped);
}

// Alpha for the glass card surface; `t` is translucency as a 0..1 fraction. Reads lighter than
// the plain card surface at every translucency (compare cardStyle's 0.85 * (1 - t)) so more of
// the blurred backdrop shows through, and never bottoms out at fully invisible the way the plain
// card does, so the glass keeps a whisper of its own material even at full translucency.
export function glassSurfaceAlpha(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1);
  return round3(0.10 + 0.25 * (1 - clamped));
}

// The glass card's own inline style: background tint and content shadow only, using the same
// translucency mapping as cardStyle. Only actually visible on a card with no live backdrop (the
// gallery's preview tiles): once a GlassBackdrop actor sits over the card, it's an opaque child
// painted after the card's own background, and hides this tint completely - which is why
// GlassBackdrop carries its own copy (glassTintColor below) for a card that has one. The border
// comes from the static .desk-card-glass stylesheet rule instead of from here, because an inline
// border would always beat a stylesheet rule targeting the same card and leave the rule inert.
export function glassCardCss(mode: ColorMode, translucency: number): string {
  const t = Math.min(Math.max(translucency, 0), 100) / 100;
  const parts = [
    `background-color: ${rgba(SURFACE[mode], glassSurfaceAlpha(t))};`,
    ...contentShadowCss(mode, t),
  ];
  return parts.join(' ');
}

// The same tint, as a bare color for GlassBackdrop's own tint overlay (see glassCardCss's
// comment for why the card's own inline background-color doesn't reach the screen once a
// backdrop is present).
export function glassTintColor(mode: ColorMode, t: number): string {
  return rgba(SURFACE[mode], glassSurfaceAlpha(t));
}

// The glass card's top-edge catch-light, painted by GlassBackdrop's tint overlay for the same
// reason glassTintColor is: a plain white regardless of mode (real glass reflects the light
// source's color, not the surface behind it). Light mode needs a higher alpha than dark to read
// at all - a white highlight has far less contrast against an already-light card surface.
const GLASS_HIGHLIGHT: Rgb = [255, 255, 255];
export function glassHighlight(mode: ColorMode): string {
  return rgba(GLASS_HIGHLIGHT, mode === 'dark' ? 0.35 : 0.6);
}
