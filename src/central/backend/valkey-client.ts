// A lazily opened Valkey connection for the Valkey backends (design §9; decision vkxkqiuf: Bun.RedisClient,
// no new dependency). The hub builds its backends synchronously (startCentral), so nothing connects, or even
// parses the url, until the first command. Bun.RedisClient accepts redis://, rediss://, valkey:// and
// valkeys:// urls; it reconnects on its own and queues commands while offline.

/** The part of Bun.RedisClient the backends use (a shared client, or a test double). */
export interface ValkeyClient {
  send(command: string, args: string[]): Promise<unknown>
  close(): void
}

/** A url (the connection opens and owns its own client) or a client shared with other backends. */
export type ValkeySource = string | ValkeyClient

export class ValkeyConnection {
  private client?: ValkeyClient
  private readonly url?: string

  constructor(source: ValkeySource) {
    if (typeof source === "string") this.url = source
    else this.client = source
  }

  /** Sends a command, opening the url's client on first use. */
  async send(command: string, args: string[]): Promise<unknown> {
    this.client ??= new Bun.RedisClient(this.url!)
    return this.client.send(command, args)
  }

  /** Closes the client opened from a url; a shared client is left to its owner. */
  close(): void {
    if (this.url === undefined || !this.client) return
    this.client.close()
    this.client = undefined
  }
}
