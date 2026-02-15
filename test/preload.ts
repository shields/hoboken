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

import crypto from "node:crypto";

// Bun doesn't support chacha20-poly1305 (https://github.com/oven-sh/bun/issues/8072),
// but hap-nodejs asserts its presence on import. Patch getCiphers to include it
// so tests can instantiate HAP objects.
const origGetCiphers = crypto.getCiphers.bind(crypto);
crypto.getCiphers = () => {
  const ciphers = origGetCiphers();
  if (!ciphers.includes("chacha20-poly1305")) {
    ciphers.push("chacha20-poly1305");
  }
  return ciphers;
};
