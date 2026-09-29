import type { WidgetDefinition } from './base.ts';
import { batteryWidget } from './battery/battery.ts';
import { calendarWidget } from './calendar/calendar.ts';
import { clockWidget } from './clock/clock.ts';
import { mediaWidget } from './media/media.ts';
import { remindersWidget } from './reminders/reminders.ts';
import { systemWidget } from './system/system.ts';
import { weatherWidget } from './weather/weather.ts';

// Every widget type, in gallery order.
export const REGISTRY: ReadonlyMap<string, WidgetDefinition> = new Map(
  [clockWidget, calendarWidget, weatherWidget, systemWidget, batteryWidget, mediaWidget, remindersWidget]
    .map(def => [def.type, def]),
);
