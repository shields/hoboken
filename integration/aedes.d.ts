// aedes ships its own types, but its `Aedes.on()` is declared solely with
// literal-event overloads (no `on(event: string, ...)` fallback). The
// `waitFor` helper in wled-roundtrip.ts subscribes with the event name passed
// as a `string`, which matches no literal overload. Augment the class with the
// generic EventEmitter fallback so that call type-checks; the packet and
// subscription types and the literal overloads all come from the package.

import "aedes";

declare module "aedes" {
  interface Aedes {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- base EventEmitter fallback
    on(event: string, listener: (...args: any[]) => void): this;
  }
}
