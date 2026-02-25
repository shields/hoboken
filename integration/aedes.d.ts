// Type declarations for aedes v1.
// The package's own .d.ts files use bare re-exports from ./types/* which
// lack .js counterparts, breaking NodeNext module resolution.

/* eslint-disable unicorn/prefer-event-target -- mirrors aedes internal API */

declare module "aedes" {
  import { EventEmitter } from "node:events";
  import { type Duplex } from "node:stream";
  import { type IncomingMessage } from "node:http";

  interface AedesPublishPacket {
    topic: string;
    payload: Buffer;
    cmd: "publish";
    qos?: 0 | 1 | 2;
    retain?: boolean;
    dup?: boolean;
  }

  interface Subscription {
    topic: string;
  }

  interface Client {
    id: string;
  }

  type Connection = Duplex;

  class Aedes extends EventEmitter {
    handle: (stream: Connection, request?: IncomingMessage) => Client;
    on(event: "publish", listener: (packet: AedesPublishPacket, client: Client | null) => void): this;
    on(event: "subscribe", listener: (subscriptions: Subscription[], client: Client) => void): this;
    on(event: "closed", listener: () => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- base EventEmitter fallback
    on(event: string, listener: (...args: any[]) => void): this;
    publish(packet: AedesPublishPacket, callback?: (error?: Error | null) => void): void;
    close(callback?: () => void): void;
    static createBroker(): Promise<Aedes>;
  }

  export { Aedes, AedesPublishPacket, Client, Subscription };
}
