# Desk Widgets

macOS-style desktop widgets for GNOME Shell. Clocks, a calendar, the weather, system stats,
battery levels, now-playing media and a reminders list sit on your desktop, below your windows, on
a snapping grid. Each widget comes in several sizes and matches your light or dark theme.

![GNOME Shell 50–51](https://img.shields.io/badge/GNOME%20Shell-50%E2%80%9351-4A86CF)
![Wayland](https://img.shields.io/badge/session-Wayland-555)
![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)

## Features

- **Widgets on the desktop:** they sit on the wallpaper, below every window, on the primary
  monitor, and stay put across workspace switches.
- **Snapping grid:** widgets come in Small, Medium and Large. Drag them into place, and they snap
  to the grid and never overlap.
- **Widget gallery:** browse and add widgets from a panel inside the Shell, by clicking or dragging.
- **Light and dark:** follows the system colour scheme, or can be forced to either one.
- **Translucency:** one slider takes the cards from solid to fully clear.
- **Glass:** optional frosted cards that blur the wallpaper behind them.
- **Auto-dim:** widgets fade while a window has focus, so they don't compete with your work.

## Widgets

### Clock
An analog or digital face. Turning on **Seconds** adds a second hand to the analog face. On a
digital face it draws a ring of 60 ticks around the card's edge, with a softly fading trail that
follows the current second.

| Size | Shows |
|---|---|
| Small | The face alone, or digital time with the date |
| Medium | Digital time and the full date |
| Large | A large face and the date |

### Calendar
Your GNOME calendars (Evolution Data Server and Online Accounts), from the same source as the top
bar.

| Size | Shows | Navigation |
|---|---|---|
| Small | Today's date and the next event | Scroll to step through days |
| Medium | The date and up to four events | ‹ › or scroll to step through days |
| Large | A month grid with event dots, plus the selected day's events | ‹ › or scroll to change months; click a day to select it |

When you move off today, a **Today** button appears. The widget returns to today on its own after
two minutes, and at midnight. Clicking any empty part of the widget opens a larger calendar
popup, with month browsing, the selected day's events and an **Open Calendar** shortcut to GNOME
Calendar. Contact birthdays can be hidden.

### Weather
Current conditions, an hourly forecast (Medium) and a five-day forecast with temperature range
bars (Large). It uses the locations and temperature units you set in GNOME Weather, and clicking the
widget opens GNOME Weather.

### System
CPU, memory and network at a glance.

| Size | Shows |
|---|---|
| Small | A CPU ring and percentage |
| Medium | CPU and memory with bars, plus a network row (which can be hidden) |
| Large | The same rows, each with a two-minute history graph |

The data comes from the kernel's own `/proc` counters. VPN tunnels and container bridges are
excluded from the network total, so the same traffic isn't counted twice.

### Battery
Your laptop's charge, plus any Bluetooth or USB peripherals that report their own.

| Size | Shows |
|---|---|
| Small | A 2x2 grid of rings, one per device (the laptop first, then up to three peripherals), each showing its icon. A ring turns green while charging or full, amber at 20% and red at 10% |
| Medium | The same rings in a row, each with its percentage underneath |
| Large | A list of up to six rows (the laptop plus up to five peripherals), each with an icon, name, percentage and a battery-level glyph that reflects the charge and whether it's charging |

The data comes from UPower.

### Media
Shows and controls whatever's currently playing on any MPRIS player — Spotify, Firefox, Chromium,
Rhythmbox, and anything else that speaks the standard MPRIS protocol.

| Size | Shows |
|---|---|
| Small | Album art (or the app's icon), with an overlaid play/pause button |
| Medium | Art, title and artist, plus previous, play/pause and next controls |
| Large | The same, plus a progress bar with the elapsed and remaining time |

Album art is cached in `~/.cache/desk-widgets/art`.

### Reminders
A simple to-do list.

| Size | Shows |
|---|---|
| Small | The open count and the next task |
| Medium | Up to three tasks, each with a checkbox |
| Large | Up to eight tasks |

On Medium and Large, click ＋ and type a task: Enter adds it and keeps the field open for the
next one; Esc, an empty Enter or a click elsewhere closes it. Completed tasks can be
cleared from the widget's right-click menu. Tasks are stored in
`~/.local/share/desk-widgets/tasks.json`, a plain JSON file you can edit by hand.

## Requirements

- GNOME Shell 50 or 51, on a Wayland session
- To build: Node.js 22 or newer, npm and `make`
- UPower, for the Battery widget's charge data (standard on GNOME)
- Optional: GNOME Weather, for the Weather widget; GNOME Calendar, for the **Open Calendar**
  shortcut

## Installation

Desk Widgets isn't on extensions.gnome.org. Install it from source:

```bash
git clone https://github.com/Gawad-B/Gnome-Widgets.git
cd Gnome-Widgets
npm ci
make install
```

On Wayland, GNOME Shell loads new extensions only when a session starts. Log out and back in,
then enable the extension:

```bash
gnome-extensions enable desk-widgets@gawad-b.github.io
```

To remove it:

```bash
gnome-extensions disable desk-widgets@gawad-b.github.io
make uninstall
```

## Usage

- **Add, move and remove widgets:** right-click the desktop and choose **Edit Widgets…**, or press
  <kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>W</kbd>. In edit mode you can drag widgets around the grid
  and add new ones from the gallery at the bottom of the screen.
- **Per-widget options:** right-click a widget to change its size, face or other options, or to
  remove it.
- **Preferences:** open them from the Extensions app, or run:

  ```bash
  gnome-extensions prefs desk-widgets@gawad-b.github.io
  ```

| Setting | Options |
|---|---|
| Style | Follow System, Light, Dark |
| Translucency | Solid to fully clear |
| Glass effect | On, Off — blurs the wallpaper behind each card instead of a plain translucent surface |
| Dim widgets | Automatically (while a window is focused), Always, Never |
| Grid spacing | 8–32 px |
| Edit mode shortcut | Any accelerator (default <kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>W</kbd>) |
| Reset Layout | Restores the default widgets |
| Open tasks file location | Opens the folder holding `tasks.json` |

## Development

```bash
npm ci
make build        # bundle into dist/
make test         # unit tests (Node's built-in test runner)
npm run typecheck
make package      # zip into packages/
```

`tools/devshell.sh` runs an isolated, nested GNOME Shell with its own session bus, dconf and XDG
directories. You can test the extension there without touching your real session:

```bash
tools/devshell.sh start        # headless shell with the extension enabled
tools/devshell.sh status       # extension state
tools/devshell.sh shot out.png # screenshot of the desktop
tools/devshell.sh stop
make run                       # visible nested shell (needs mutter-devkit)
make logs                      # the nested shell's log
```

Don't lock the nested shell. It takes real input like any GNOME Shell, and it can't be unlocked
from outside.

To follow the extension's log in your real session:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Project layout

```
src/
  core/       pure logic (grid, layout, dates, forecast, system stats, battery, tasks, media timing, ring geometry), unit-tested under Node
  services/   shared, reference-counted data sources (clock, calendar, weather, system, battery, media, tasks)
  shell/      GNOME Shell integration (desktop layer, edit mode, gallery, menus, popups)
  widgets/    the widgets themselves
  extension.ts, prefs.ts
schemas/      GSettings schema
test/         unit tests
tools/        development tooling (nested dev shell)
```

Written in TypeScript and bundled with esbuild. Type definitions come from
[`@girs`](https://github.com/gjsify/types).

## License

[GPL-2.0-or-later](LICENSE)
