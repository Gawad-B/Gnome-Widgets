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

export function cardStyle(mode: ColorMode, translucency: number): CardStyle {
  const t = Math.min(Math.max(translucency, 0), 100) / 100;
  const solid = 1 - t;
  const parts = [
    `background-color: ${rgba(SURFACE[mode], 0.85 * solid)};`,
    `border: 1px solid ${rgba(EDGE[mode], 0.12 * solid)};`,
    `box-shadow: 0 2px 12px 0 ${rgba(BLACK, 0.25 * solid)};`,
  ];
  const shadowAlpha = t <= 0.5 ? 0 : ((t - 0.5) / 0.5) * 0.6;
  if (shadowAlpha > 0) {
    const shadow = `0 1px 3px ${rgba(CONTENT_SHADOW[mode], shadowAlpha)}`;
    parts.push(`text-shadow: ${shadow};`, `icon-shadow: ${shadow};`);
  }
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
