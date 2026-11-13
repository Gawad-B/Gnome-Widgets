import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

// Declarations and fragment code appended to the offscreen texture's pipeline as a snippet's
// `post` code (see vfunc_get_static_snippet below): by the point this runs, the actor has already been sampled
// and written to cogl_color_out, so all that is left is to fade it out past a rounded rectangle
// matching the actor's own size, using a signed-distance field for the edge.
//
// The offscreen texture is premultiplied and the stage blends with (ONE, ONE_MINUS_SRC_ALPHA), so
// coverage has to scale all four channels. Scaling only alpha would leave the color behind at
// full strength outside the curve, where it is then added on top of the wallpaper as a bright
// square wedge in each corner.
const DECLARATIONS = `
  uniform float width;
  uniform float height;
  uniform float radius;

  float rounded_box_sdf(vec2 p, vec2 half_size, float r) {
    vec2 q = abs(p) - half_size + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
`;

const CODE = `
  vec2 half_size = vec2(width, height) * 0.5;
  vec2 p = cogl_tex_coord_in[0].xy * vec2(width, height) - half_size;
  float distance = rounded_box_sdf(p, half_size, radius);
  float coverage = 1.0 - smoothstep(-0.5, 0.5, distance);
  cogl_color_out *= coverage;
`;

// Clutter.ShaderEffect.set_uniform_float, added in GNOME 51 alongside get_static_snippet; the
// @girs typings in use still describe GNOME 50's Clutter, which has neither.
interface UniformSetter {
  set_uniform_float(name: string, nComponents: number, value: number[]): void;
}

// Clips an actor's painted output to a rounded rectangle the size of its own allocation, with a
// roughly half-a-pixel anti-aliased edge on each side of the curve - close to how St itself
// anti-aliases a plain CSS border, so the two edges (this mask's, and the card's own border just
// outside it) read as the same sharpness rather than one visibly softer than the other. Built on
// Clutter.ShaderEffect with a static snippet, the same pattern the Shell's own vignette in
// ui/lightbox.js moved to when GNOME 51 dropped Shell.GLSLEffect.
export class RoundedMaskEffect extends Clutter.ShaderEffect {
  static {
    GObject.registerClass(this);
  }

  vfunc_get_static_snippet(): Cogl.Snippet {
    return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
  }

  // `width`/`height` are the size of the rounded rectangle in pixels (normally the effect's own
  // actor's size), `radius` its corner radius in pixels.
  setGeometry(width: number, height: number, radius: number): void {
    const effect = this as unknown as UniformSetter;
    effect.set_uniform_float('width', 1, [width]);
    effect.set_uniform_float('height', 1, [height]);
    effect.set_uniform_float('radius', 1, [radius]);
  }
}
