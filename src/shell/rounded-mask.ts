import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// Declarations and fragment code appended to the actor's own pipeline (see
// Shell.GLSLEffect.add_glsl_snippet): by the point this runs, the actor has already been sampled
// and written to cogl_color_out, so all that is left is to fade its alpha out past a rounded
// rectangle matching the actor's own size, using a signed-distance field for the edge.
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
  cogl_color_out.a *= coverage;
`;

// Clips an actor's painted output to a rounded rectangle the size of its own allocation, with a
// roughly half-a-pixel anti-aliased edge on each side of the curve - close to how St itself
// anti-aliases a plain CSS border, so the two edges (this mask's, and the card's own border just
// outside it) read as the same sharpness rather than one visibly softer than the other. Built on
// Shell.GLSLEffect rather than a plain Clutter.ShaderEffect: a full shader replacement through
// Clutter.ShaderEffect never picked up its uniforms in this Shell version, while GLSLEffect's
// snippet-on-the-existing-pipeline approach — the same one behind the Shell's own vignette in
// ui/lightbox.js — worked immediately.
export class RoundedMaskEffect extends Shell.GLSLEffect {
  static {
    GObject.registerClass(this);
  }

  private _widthLocation = -1;
  private _heightLocation = -1;
  private _radiusLocation = -1;

  vfunc_build_pipeline(): void {
    this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
  }

  // `width`/`height` are the size of the rounded rectangle in pixels (normally the effect's own
  // actor's size), `radius` its corner radius in pixels.
  setGeometry(width: number, height: number, radius: number): void {
    if (this._widthLocation < 0) {
      this._widthLocation = this.get_uniform_location('width');
      this._heightLocation = this.get_uniform_location('height');
      this._radiusLocation = this.get_uniform_location('radius');
    }
    this.set_uniform_float(this._widthLocation, 1, [width]);
    this.set_uniform_float(this._heightLocation, 1, [height]);
    this.set_uniform_float(this._radiusLocation, 1, [radius]);
  }
}
