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

const entry = (factor: number, temperature: number, offset: number) =>
  encode(
    1,
    writeFloat32LE(factor),
    2,
    writeFloat32LE(temperature),
    3,
    writeVariableUIntLE(offset),
  );

// The write that a home hub makes to CharacteristicValueTransitionControl to
// start Adaptive Lighting: 400 mireds at the start of the schedule less half
// the brightness (10 to 100), then 300 mireds and 250 mireds an hour apart.
export function hubStartsAdaptiveLighting(
  accessory: Accessory,
  { startMs = Date.now(), intervalMs = 60000, spanMs = 3_600_000 } = {},
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
    [entry(-0.5, 400, 0), entry(-0.5, 300, spanMs), entry(-0.5, 250, spanMs)],
    2,
    writeVariableUIntLE(brightness.iid!),
    3,
    encode(1, writeUInt32(10), 2, writeUInt32(100)),
  );
  const configuration = encode(
    1,
    writeVariableUIntLE(temperature.iid!),
    2,
    encode(1, uuid.write(uuid.generate("transition")), 2, start),
    3,
    Buffer.from([1]),
    5,
    curve,
    6,
    writeUInt16(intervalMs),
    8,
    writeUInt32(1000),
  );
  return service
    .getCharacteristic(Characteristic.CharacteristicValueTransitionControl)
    .handleSetRequest(encode(2, encode(1, configuration)).toString("base64"));
}
