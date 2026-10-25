// Kv in Valkey: SET [PX] [NX], GET, GETDEL and DEL under a key prefix (default "kv:"). Expiry is server-side,
// so it follows the server's clock, not an injected one.
import type { Kv, KvSetOptions } from "./types"
import { ValkeyConnection, type ValkeySource } from "./valkey-client"

export interface ValkeyKvOptions {
  /** Prepended to every key (default "kv:"). */
  readonly prefix?: string
}

export class ValkeyKv implements Kv {
  private readonly valkey: ValkeyConnection
  private readonly prefix: string

  constructor(source: ValkeySource, options: ValkeyKvOptions = {}) {
    this.valkey = new ValkeyConnection(source)
    this.prefix = options.prefix ?? "kv:"
  }

  async set(key: string, value: string, options: KvSetOptions = {}): Promise<boolean> {
    const { px, nx } = options
    if (px !== undefined && !(Number.isInteger(px) && px > 0)) throw new Error("Kv.set: px must be a positive whole number of milliseconds")
    const args = [this.prefix + key, value]
    if (px !== undefined) args.push("PX", String(px))
    if (nx) args.push("NX")
    return (await this.valkey.send("SET", args)) === "OK"
  }

  async get(key: string): Promise<string | undefined> {
    return text(await this.valkey.send("GET", [this.prefix + key]))
  }

  async getdel(key: string): Promise<string | undefined> {
    return text(await this.valkey.send("GETDEL", [this.prefix + key]))
  }

  async del(key: string): Promise<boolean> {
    return Number(await this.valkey.send("DEL", [this.prefix + key])) > 0
  }

  /** Closes the connection when it was opened from a url. */
  async close(): Promise<void> {
    this.valkey.close()
  }
}

function text(reply: unknown): string | undefined {
  return reply === null || reply === undefined ? undefined : String(reply)
}
