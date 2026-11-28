// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  type Accessory,
  Characteristic,
  encode,
  Service,
  uuid,
  writeFloat32LE,
  writeUInt16,
  writeUInt32,
  writeVariableUIntLE,
} from "@homebridge/hap-nodejs";

const HAP_EPOCH = Date.UTC(2001, 0, 1);

// publish assigns instance ids; a test that does not publish assigns them.
export function assignInstanceIds(accessory: Accessory): void {
  let next = 1;
  for (const service of accessory.services) {
    service.iid ??= next++;
    for (const characteristic of service.characteristics)
      characteristic.iid ??= next++;
  }
}

// An entry's duration is the hold at the entry before it.
const entry = ([temperature, offset, hold, factor = -0.5]: CurveEntry) =>
  encode(
    1,
    writeFloat32LE(factor),
    2,
    writeFloat32LE(temperature),
    3,
    writeVariableUIntLE(offset),
    ...(hold === undefined ? [] : [4, writeVariableUIntLE(hold)]),
  );

// Mireds, the time from the entry before, the hold at the entry before, and
// the change in mireds for each percent of brightness.
export type CurveEntry = [number, number, (number | undefined)?, number?];

const HOUR = 3_600_000;

// A day's schedule like the hub's, which ends where it starts: a hold of an
// hour at 400 mireds less half the brightness, 300 after five hours, 250 after
// six more, held for two, 330 after six, and 400 again after four.
export const DAILY_CURVE: CurveEntry[] = [
  [400, 0],
  [300, 5 * HOUR, HOUR, -0.3],
  [250, 6 * HOUR, undefined, -0.2],
  [330, 6 * HOUR, 2 * HOUR, -0.4],
  [400, 4 * HOUR],
];

// The controller context in which the hub marks its own schedules.
export const HUB_CONTEXT = Buffer.from("0102030405060708", "hex");

// The write that a home hub makes to CharacteristicValueTransitionControl to
// start Adaptive Lighting: 400 mireds at the start of the schedule less half
// the brightness (10 to 100), then 300 mireds and 250 mireds an hour apart,
// unless another curve is given.
export function hubStartsAdaptiveLighting(
  accessory: Accessory,
  {
    startMs = Date.now(),
    intervalMs = 60000,
    spanMs = 3_600_000,
    notifyMs = 1000,
    entries = [
      [400, 0],
      [300, spanMs],
      [250, spanMs],
    ] as CurveEntry[],
    context = undefined as Buffer | undefined,
    transitionId = uuid.generate("transition"),
  } = {},
): Promise<unknown> {
  const service = accessory.getService(Service.Lightbulb)!;
  const temperature = service.getCharacteristic(
    Characteristic.ColorTemperature,
  );
  const brightness = service.getCharacteristic(Characteristic.Brightness);
  const start = Buffer.alloc(8);
  start.writeBigUInt64LE(BigInt(startMs - HAP_EPOCH));
  const curve = encode(
    1,
    entries.map((e) => entry(e)),
    2,
    writeVariableUIntLE(brightness.iid!),
    3,
    encode(1, writeUInt32(10), 2, writeUInt32(100)),
  );
  const configuration = encode(
    1,
    writeVariableUIntLE(temperature.iid!),
    2,
    encode(
      1,
      uuid.write(transitionId),
      2,
      start,
      ...(context ? [3, context] : []),
    ),
    3,
    Buffer.from([1]),
    5,
    curve,
    6,
    writeUInt16(intervalMs),
    8,
    writeUInt32(notifyMs),
  );
  return service
    .getCharacteristic(Characteristic.CharacteristicValueTransitionControl)
    .handleSetRequest(encode(2, encode(1, configuration)).toString("base64"));
}

// The hub's write that switches Adaptive Lighting off, as the Home app's
// switch does: the characteristic's instance id alone.
export function hubStopsAdaptiveLighting(
  accessory: Accessory,
): Promise<unknown> {
  const service = accessory.getService(Service.Lightbulb)!;
  const temperature = service.getCharacteristic(
    Characteristic.ColorTemperature,
  );
  return service
    .getCharacteristic(Characteristic.CharacteristicValueTransitionControl)
    .handleSetRequest(
      encode(
        2,
        encode(1, encode(1, writeVariableUIntLE(temperature.iid!))),
      ).toString("base64"),
    );
}
