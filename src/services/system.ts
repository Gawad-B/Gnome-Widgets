import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
  cpuUsage, memUsage, netRate, parseCpuTimes, parseMemInfo, parseNetDev, pushSample,
  type CpuTimes, type NetTotals,
} from '../core/sysstat.ts';
import { Service, type Scheduler } from './service.ts';

export interface SystemValue {
  cpu: number;                                  // 0..1
  mem: { used: number; total: number; fraction: number };
  net: NetTotals;                               // bytes/s
  history: { cpu: number[]; mem: number[]; rx: number[]; tx: number[] };
}

const INTERVAL_MS = 2000;
const FIRST_SAMPLE_MS = 500;
const decoder = new TextDecoder();

// Reads one /proc file asynchronously. /proc files report size 0, so this uses
// load_contents_async (which reads to EOF), never a sync call.
function readProc(path: string, cancellable: Gio.Cancellable): Promise<string> {
  return new Promise((resolve, reject) => {
    Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
      try {
        const [, bytes] = file!.load_contents_finish(res);
        resolve(decoder.decode(bytes));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// CPU usage, memory and network throughput, sampled from /proc every INTERVAL_MS while
// subscribed. Keeps a 60-sample history of each series for the widgets' graphs.
export class SystemService extends Service<SystemValue> {
  private readonly _ticks: Scheduler;
  private _cancellable: Gio.Cancellable | null = null;
  private _tick: number | null = null;
  private _prevCpu: CpuTimes | null = null;
  private _prevNet: NetTotals | null = null;
  private _prevMonotonic = 0;
  private _inFlight = false;
  private _cpuHistory: number[] = [];
  private _memHistory: number[] = [];
  private _rxHistory: number[] = [];
  private _txHistory: number[] = [];

  constructor(scheduler: Scheduler) {
    super(scheduler);
    this._ticks = scheduler;
  }

  protected start(): void {
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    // The baseline sample publishes nothing (there's no previous sample to diff against yet);
    // the first real value follows shortly after it lands, so the two never race and the first
    // rate is measured against the baseline rather than overwritten by it.
    void this._baseline().then(ok => {
      if (ok && this.running && this._cancellable === cancellable && this._tick === null)
        this._arm(FIRST_SAMPLE_MS);
    });
  }

  protected stop(): void {
    if (this._tick !== null) {
      this._ticks.cancel(this._tick);
      this._tick = null;
    }
    this._cancellable?.cancel();
    this._cancellable = null;
    this._prevCpu = null;
    this._prevNet = null;
    this._prevMonotonic = 0;
    this._inFlight = false;
    this._cpuHistory = [];
    this._memHistory = [];
    this._rxHistory = [];
    this._txHistory = [];
  }

  private _arm(delayMs: number): void {
    this._tick = this._ticks.schedule(delayMs, () => {
      this._tick = null;
      void this._sample();
    });
  }

  private async _baseline(): Promise<boolean> {
    const cancellable = this._cancellable;
    if (!cancellable)
      return false;
    try {
      const [stat, net] = await Promise.all([
        readProc('/proc/stat', cancellable),
        readProc('/proc/net/dev', cancellable),
      ]);
      if (!this.running || this._cancellable !== cancellable)
        return false;
      const cpu = parseCpuTimes(stat);
      if (cpu)
        this._prevCpu = cpu;
      this._prevNet = parseNetDev(net);
      this._prevMonotonic = GLib.get_monotonic_time();
      return true;
    } catch (e) {
      if (!this.running || this._cancellable !== cancellable)
        return false;
      if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return false;
      this.fail(e);
      return false;
    }
  }

  private async _sample(): Promise<void> {
    const cancellable = this._cancellable;
    // Never overlap reads: if a read is still in flight when the timer fires, skip this tick
    // entirely (the next one re-arms on schedule regardless).
    if (!cancellable || this._inFlight) {
      if (this.running)
        this._arm(INTERVAL_MS);
      return;
    }
    this._inFlight = true;
    try {
      const [statText, memText, netText] = await Promise.all([
        readProc('/proc/stat', cancellable),
        readProc('/proc/meminfo', cancellable),
        readProc('/proc/net/dev', cancellable),
      ]);
      if (!this.running || this._cancellable !== cancellable)
        return;
      this._inFlight = false;
      const now = GLib.get_monotonic_time();
      const cpuTimes = parseCpuTimes(statText);
      const mem = parseMemInfo(memText);
      const net = parseNetDev(netText);
      if (!cpuTimes || !mem) {
        this.fail(new Error('unreadable /proc data'));
        return;
      }
      const cpu = this._prevCpu ? cpuUsage(this._prevCpu, cpuTimes) : 0;
      const seconds = this._prevMonotonic > 0 ? (now - this._prevMonotonic) / 1_000_000 : 0;
      const rate = this._prevNet ? netRate(this._prevNet, net, seconds) : { rx: 0, tx: 0 };
      this._prevCpu = cpuTimes;
      this._prevNet = net;
      this._prevMonotonic = now;

      this._cpuHistory = pushSample(this._cpuHistory, cpu);
      this._memHistory = pushSample(this._memHistory, memUsage(mem));
      this._rxHistory = pushSample(this._rxHistory, rate.rx);
      this._txHistory = pushSample(this._txHistory, rate.tx);

      this.publish({
        cpu,
        mem: { used: mem.total - mem.available, total: mem.total, fraction: memUsage(mem) },
        net: rate,
        history: {
          cpu: this._cpuHistory, mem: this._memHistory, rx: this._rxHistory, tx: this._txHistory,
        },
      });
    } catch (e) {
      // A read from an earlier start() (its cancellable already replaced) must not touch this
      // generation's state.
      if (!this.running || this._cancellable !== cancellable)
        return;
      this._inFlight = false;
      if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return;
      // fail() owns the retry (with backoff); re-arming here too would keep reading every
      // INTERVAL_MS regardless.
      this.fail(e);
      return;
    }
    if (this.running)
      this._arm(INTERVAL_MS);
  }
}
