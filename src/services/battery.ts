import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
  chargeState, peripheralLabel, pickPeripherals, type ChargeState, type PeripheralInfo,
} from '../core/battery.ts';
import { Service } from './service.ts';

export interface BatteryValue {
  laptop: { percent: number; state: ChargeState; secondsLeft: number } | null;  // null: no system battery
  peripherals: PeripheralInfo[];                                              // up to 5
}

const UPOWER_NAME = 'org.freedesktop.UPower';
const MANAGER_PATH = '/org/freedesktop/UPower';
const MANAGER_IFACE = 'org.freedesktop.UPower';
const DEVICE_IFACE = 'org.freedesktop.UPower.Device';
const DISPLAY_DEVICE_PATH = `${MANAGER_PATH}/devices/DisplayDevice`;
const BATTERY_KIND = 2;

function isCancelled(e: unknown): boolean {
  return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function newProxy(path: string, iface: string, cancellable: Gio.Cancellable): Promise<Gio.DBusProxy> {
  return new Promise((resolve, reject) => {
    Gio.DBusProxy.new_for_bus(
      Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, UPOWER_NAME, path, iface, cancellable,
      (_source, res) => {
        try {
          resolve(Gio.DBusProxy.new_for_bus_finish(res!));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

// proxy.call()'s Promise-returning overload isn't actually available at runtime for this method
// (GJS still requires the callback argument), so this wraps the callback form explicitly, the
// same way newProxy() and readProc() (services/system.ts) do for their own async GI calls.
function dbusCall(
  proxy: Gio.DBusProxy, method: string, params: GLib.Variant | null, cancellable: Gio.Cancellable,
): Promise<GLib.Variant> {
  return new Promise((resolve, reject) => {
    proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, cancellable, (source, res) => {
      try {
        resolve(source!.call_finish(res!));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const propBool = (proxy: Gio.DBusProxy, name: string): boolean =>
  (proxy.get_cached_property(name)?.unpack() as boolean | undefined) ?? false;
const propNumber = (proxy: Gio.DBusProxy, name: string): number =>
  (proxy.get_cached_property(name)?.unpack() as number | undefined) ?? 0;
const propString = (proxy: Gio.DBusProxy, name: string): string =>
  (proxy.get_cached_property(name)?.unpack() as string | undefined) ?? '';

// The laptop's own battery (UPower's DisplayDevice, a synthetic aggregate UPower maintains
// itself) plus any Bluetooth/USB peripherals with their own reported charge, read over the
// system D-Bus the same way the Shell's own power indicator does.
export class BatteryService extends Service<BatteryValue> {
  private _cancellable: Gio.Cancellable | null = null;
  private _manager: Gio.DBusProxy | null = null;
  private _display: Gio.DBusProxy | null = null;
  private readonly _peripherals = new Map<string, Gio.DBusProxy>();

  protected start(): void {
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    void this._connect(cancellable);
  }

  protected stop(): void {
    this._cancellable?.cancel();
    this._cancellable = null;
    this._manager?.disconnectObject(this);
    this._display?.disconnectObject(this);
    for (const proxy of this._peripherals.values())
      proxy.disconnectObject(this);
    this._manager = null;
    this._display = null;
    this._peripherals.clear();
  }

  private async _connect(cancellable: Gio.Cancellable): Promise<void> {
    try {
      const [manager, display] = await Promise.all([
        newProxy(MANAGER_PATH, MANAGER_IFACE, cancellable),
        newProxy(DISPLAY_DEVICE_PATH, DEVICE_IFACE, cancellable),
      ]);
      if (!this.running || this._cancellable !== cancellable)
        return;
      if (manager.g_name_owner === null) {
        this.fail(new Error('UPower is unavailable'));
        return;
      }
      this._manager = manager;
      this._display = display;
      manager.connectObject('g-signal', (_p: Gio.DBusProxy, _sender: string, signal: string, params: GLib.Variant) => {
        if (signal === 'DeviceAdded') {
          const [path] = params.deepUnpack<[string]>();
          void this._addPeripheral(path, cancellable);
        } else if (signal === 'DeviceRemoved') {
          const [path] = params.deepUnpack<[string]>();
          this._removePeripheral(path);
        }
      }, this);
      display.connectObject('g-properties-changed', () => this._emit(), this);
      // The DisplayDevice proxy is ready: publish now (with whatever peripherals have resolved
      // so far, none yet) rather than waiting for EnumerateDevices to finish.
      this._emit();

      const result = await dbusCall(manager, 'EnumerateDevices', null, cancellable);
      if (!this.running || this._cancellable !== cancellable)
        return;
      const [paths] = result.deepUnpack<[string[]]>();
      await Promise.all(paths.map(path => this._addPeripheral(path, cancellable)));
    } catch (e) {
      if (!this.running || this._cancellable !== cancellable || isCancelled(e))
        return;
      // Disconnect first: a later g-properties-changed on the display proxy would otherwise
      // publish a fresh value, which cancels fail()'s own retry and leaves peripherals missing.
      this._manager?.disconnectObject(this);
      this._display?.disconnectObject(this);
      for (const proxy of this._peripherals.values())
        proxy.disconnectObject(this);
      this._manager = null;
      this._display = null;
      this._peripherals.clear();
      this.fail(e);
    }
  }

  private async _addPeripheral(path: string, cancellable: Gio.Cancellable): Promise<void> {
    if (this._peripherals.has(path))
      return;
    try {
      const proxy = await newProxy(path, DEVICE_IFACE, cancellable);
      if (!this.running || this._cancellable !== cancellable || this._peripherals.has(path)) {
        proxy.disconnectObject(this);
        return;
      }
      const kind = propNumber(proxy, 'Type');
      if (peripheralLabel(kind) === null)
        return;
      proxy.connectObject('g-properties-changed', () => this._emit(), this);
      this._peripherals.set(path, proxy);
      this._emit();
    } catch (e) {
      // A single peripheral failing to proxy (it can vanish between EnumerateDevices and this
      // call) never fails the whole service — only the DisplayDevice/manager proxies do.
      if (!this.running || this._cancellable !== cancellable || isCancelled(e))
        return;
    }
  }

  private _removePeripheral(path: string): void {
    const proxy = this._peripherals.get(path);
    if (!proxy)
      return;
    proxy.disconnectObject(this);
    this._peripherals.delete(path);
    this._emit();
  }

  private _emit(): void {
    const display = this._display;
    if (!display)
      return;
    const isPresent = propBool(display, 'IsPresent');
    const type = propNumber(display, 'Type');
    let laptop: BatteryValue['laptop'] = null;
    if (isPresent && type === BATTERY_KIND) {
      const state = chargeState(propNumber(display, 'State'));
      laptop = {
        percent: propNumber(display, 'Percentage'),
        state,
        secondsLeft: propNumber(display, state === 'charging' ? 'TimeToFull' : 'TimeToEmpty'),
      };
    }

    const devices: PeripheralInfo[] = [];
    for (const [path, proxy] of this._peripherals) {
      if (!propBool(proxy, 'IsPresent'))
        continue;
      const percent = propNumber(proxy, 'Percentage');
      const state = chargeState(propNumber(proxy, 'State'));
      if (percent === 0 && state === 'unknown')
        continue;
      const kind = propNumber(proxy, 'Type');
      const name = propString(proxy, 'Model') || (peripheralLabel(kind) ?? '');
      devices.push({ id: path, kind, name, percent, state });
    }

    this.publish({ laptop, peripherals: pickPeripherals(devices) });
  }
}
