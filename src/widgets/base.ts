import type St from 'gi://St';
import type { SizeName } from '../core/grid.ts';
import type { ServiceHub } from '../services/hub.ts';
import type { WidgetScope } from './scope.ts';

export type WidgetConfig = Record<string, unknown>;

// Declarative per-widget settings, rendered by the widget's right-click menu. 'action' is a
// plain menu item with no stored state, running WidgetDefinition.runAction when clicked.
export type WidgetOption =
  | { kind: 'toggle'; key: string; label: string }
  | { kind: 'choice'; key: string; label: string; choices: ReadonlyArray<{ value: string; label: string }> }
  | { kind: 'action'; key: string; label: string };

export interface WidgetContext {
  readonly size: SizeName;
  // defaultConfig merged with the saved config.
  readonly config: WidgetConfig;
  readonly hub: ServiceHub;
  // Contains a widget's failures: a service listener registered through
  // scope.watch() that throws replaces the card's content with an error label instead of
  // taking the layer, or the shared service's other subscribers, down with it.
  readonly scope: WidgetScope;
}

export interface WidgetDefinition {
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly sizes: readonly SizeName[];
  readonly defaultSize: SizeName;
  readonly defaultConfig: WidgetConfig;
  readonly options: readonly WidgetOption[];
  // Opts out of desk-card-content's own 16px padding (DeskCard gives the content wrapper
  // desk-card-content-bleed instead, padding: 0), for a widget that needs to draw all the way
  // to the card's own edge (e.g. a ring traced concentric with the card's rounded corner). Only
  // affects the content wrapper; a bleeding widget is responsible for padding its own non-edge
  // layouts itself, since every size/config of a given widget type shares one WidgetDefinition.
  readonly bleed?: boolean;
  create(ctx: WidgetContext): DeskWidget;
  // Runs an 'action' option's menu item. Never called for any other option kind.
  runAction?(key: string, hub: ServiceHub): void;
}

// A widget's content. A size or config change rebuilds the widget from scratch, so an
// implementation only renders for the context it was created with. Cleanup (service
// subscriptions, timers) goes through ctx.scope, not this class, so it runs even when the
// widget's own constructor never finishes.
export abstract class DeskWidget {
  readonly actor: St.Widget;

  constructor(actor: St.Widget) {
    this.actor = actor;
  }

  destroy(): void {
    this.actor.destroy();
  }
}
