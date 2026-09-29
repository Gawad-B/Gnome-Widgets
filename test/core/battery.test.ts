import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeState, formatDuration, peripheralIcon, peripheralLabel, pickPeripherals,
  type PeripheralInfo,
} from '../../src/core/battery.ts';

const dev = (id: string, kind: number, name: string, percent = 50, state: PeripheralInfo['state'] = 'discharging'): PeripheralInfo =>
  ({ id, kind, name, percent, state });

test('chargeState maps the UPower device state enum', () => {
  assert.equal(chargeState(1), 'charging');
  assert.equal(chargeState(2), 'discharging');
  assert.equal(chargeState(3), 'empty');
  assert.equal(chargeState(4), 'full');
  assert.equal(chargeState(5), 'pending');
  assert.equal(chargeState(6), 'pending');
  assert.equal(chargeState(0), 'unknown');
  assert.equal(chargeState(99), 'unknown');
});

test('peripheralLabel names the kinds this extension shows, and hides the rest', () => {
  assert.equal(peripheralLabel(5), 'Mouse');
  assert.equal(peripheralLabel(6), 'Keyboard');
  assert.equal(peripheralLabel(12), 'Controller');
  assert.equal(peripheralLabel(13), 'Pen');
  assert.equal(peripheralLabel(14), 'Touchpad');
  assert.equal(peripheralLabel(17), 'Headset');
  assert.equal(peripheralLabel(19), 'Headphones');
  assert.equal(peripheralLabel(21), 'Audio device');
  assert.equal(peripheralLabel(2), null);   // battery
  assert.equal(peripheralLabel(1), null);   // line power
});

test('peripheralIcon returns a symbolic icon name, with a fallback', () => {
  assert.equal(peripheralIcon(5), 'input-mouse-symbolic');
  assert.equal(peripheralIcon(6), 'input-keyboard-symbolic');
  assert.equal(peripheralIcon(12), 'input-gaming-symbolic');
  assert.equal(peripheralIcon(17), 'audio-headset-symbolic');
  assert.equal(peripheralIcon(19), 'audio-headphones-symbolic');
  assert.equal(peripheralIcon(14), 'input-touchpad-symbolic');
  assert.equal(peripheralIcon(13), 'input-tablet-symbolic');
  assert.equal(peripheralIcon(999), 'battery-symbolic');
});

test('pickPeripherals drops unknown kinds, orders by kind then name, and caps at max', () => {
  const devices = [
    dev('a', 6, 'Keyboard B'),
    dev('b', 999, 'Unknown thing'),   // dropped: no peripheralLabel
    dev('c', 5, 'Mouse Z'),
    dev('d', 19, 'Headphones'),
    dev('e', 5, 'Mouse A'),
    dev('f', 12, 'Controller'),
    dev('g', 13, 'Pen'),
    dev('h', 14, 'Touchpad'),
  ];
  const ordered = pickPeripherals(devices, 10);
  assert.deepEqual(ordered.map(p => p.id), ['d', 'e', 'c', 'a', 'f', 'g', 'h']);
  assert.equal(pickPeripherals(devices, 2).length, 2);
  assert.equal(pickPeripherals(devices).length, 5);   // default max is 5
});

test('pickPeripherals passes each device\'s charge state through unchanged', () => {
  const devices = [dev('a', 5, 'Mouse', 40, 'charging'), dev('b', 6, 'Keyboard', 90, 'discharging')];
  const ordered = pickPeripherals(devices, 10);
  assert.deepEqual(ordered.map(p => p.state), ['charging', 'discharging']);
});

test('formatDuration', () => {
  assert.equal(formatDuration(8100), '2 h 15 min');
  assert.equal(formatDuration(2700), '45 min');
  assert.equal(formatDuration(3600), '1 h');
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(-5), '');
});
