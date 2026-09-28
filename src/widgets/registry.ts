import type { WidgetDefinition } from './base.ts';
import { calendarWidget } from './calendar/calendar.ts';
import { clockWidget } from './clock/clock.ts';
import { weatherWidget } from './weather/weather.ts';

// Every widget type, in gallery order.
export const REGISTRY: ReadonlyMap<string, WidgetDefinition> =
  new Map([clockWidget, calendarWidget, weatherWidget].map(def => [def.type, def]));
