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
