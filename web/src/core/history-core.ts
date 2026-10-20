// Progressive session history (no DOM): the newest timeline page first, older pages on demand (the transcript's
// top sentinel asks), with the state the view shows above the conversation ("Loading earlier…", "Beginning of
// conversation", an error with Retry). Pages come from GET …/timeline?limit=N&order=desc|before=<older>.
import type { Timeline, TimelineInput } from "./timeline-core"

export interface PageQuery {
  limit: number
  order?: "desc"
  before?: string
  cursor?: string
}
export interface Page {
  items?: readonly unknown[]
  /** Newest-first mode: the cursor of the page before these rows. */
  older?: string
  /** Forward mode (spokes before newest-first paging): the cursor of the next newer page. */
  cursor?: string
}
export type PageFetch = (query: PageQuery) => Promise<Page>
/** idle: more older rows may be loaded; done: the beginning is shown. */
export type HistoryState = "idle" | "loading" | "done" | "error"

/** Forward paging for spokes that do not know newest-first pages (as consoles did before). */
const LEGACY_LIMIT = 200
const LEGACY_PAGES = 10

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : undefined)

export class HistoryPager {
  state: HistoryState = "idle"
  error?: string
  private cursor?: string
  /** The last older page failed because its cursor is unknown (history rewritten): Retry starts over. */
  private invalid = false
  /** Bumped by every newest-page load: answers of older loads started before it are dropped. */
  private generation = 0
  private loading?: Promise<void>

  constructor(
    private readonly timeline: Timeline,
    private readonly fetch: PageFetch,
    private readonly options: { limit?: number; onChange?: () => void } = {},
  ) {}

  get hasOlder(): boolean {
    return this.cursor !== undefined
  }

  private get limit(): number {
    return this.options.limit ?? 80
  }

  private changed(): void {
    this.options.onChange?.()
  }

  /** Loads the newest page (one request); throws when it fails. */
  async first(): Promise<void> {
    const generation = this.begin()
    const page = await this.fetch({ limit: this.limit, order: "desc" })
    if (generation !== this.generation) return
    await this.show(page, generation)
  }

  /**
   * The newest page again (after missed events): merged when it overlaps the rows loaded so far, else (a gap)
   * the loaded history is dropped and paging starts over from it.
   */
  async resync(): Promise<void> {
    const generation = this.begin()
    const page = await this.fetch({ limit: this.limit, order: "desc" })
    if (generation !== this.generation) return
    const items = (page.items ?? []) as readonly TimelineInput[]
    const overlaps = page.older === undefined || items.some((item) => this.timeline.fromHistory(item?.key as string))
    if (page.cursor === undefined && overlaps) {
      this.timeline.load(items)
      if (this.state === "loading") this.state = this.cursor === undefined ? "done" : "idle"
      this.changed()
      return
    }
    this.timeline.forgetHistory()
    await this.show(page, generation)
  }

  /** The page before the rows loaded so far; one at a time, and not after an error (see retry). */
  older(): Promise<void> {
    if (this.loading) return this.loading
    if (this.state !== "idle" || this.cursor === undefined) return Promise.resolve()
    const generation = this.generation
    const before = this.cursor
    this.state = "loading"
    this.changed()
    const run = (async () => {
      try {
        const page = await this.fetch({ limit: this.limit, before })
        if (generation !== this.generation) return
        this.timeline.load(page.items as readonly TimelineInput[] | undefined, { older: true })
        this.cursor = page.older
        this.state = page.older === undefined ? "done" : "idle"
        this.error = undefined
      } catch (e) {
        if (generation !== this.generation) return
        this.state = "error"
        this.error = messageOf(e)
        this.invalid = statusOf(e) === 400
      } finally {
        if (generation === this.generation) {
          this.loading = undefined
          this.changed()
        }
      }
    })()
    this.loading = run
    return run
  }

  /** After an error: the same older page again, or (its cursor unknown) the newest page from scratch. */
  async retry(): Promise<void> {
    if (this.state !== "error") return
    if (this.invalid) {
      const generation = this.begin()
      this.timeline.forgetHistory()
      try {
        const page = await this.fetch({ limit: this.limit, order: "desc" })
        if (generation === this.generation) await this.show(page, generation)
      } catch (e) {
        if (generation !== this.generation) return
        this.state = "error"
        this.error = messageOf(e)
        this.invalid = true
        this.changed()
      }
      return
    }
    this.state = "idle"
    this.error = undefined
    return this.older()
  }

  private begin(): number {
    this.loading = undefined
    return ++this.generation
  }

  /** Shows a newest page; a forward-mode answer (older spoke) loads the rest of the history the old way. */
  private async show(page: Page, generation: number): Promise<void> {
    this.timeline.load(page.items as readonly TimelineInput[] | undefined)
    this.error = undefined
    this.invalid = false
    if (page.cursor !== undefined && page.older === undefined) {
      let cursor: string | undefined = page.cursor
      for (let pages = 1; cursor !== undefined && pages < LEGACY_PAGES; pages++) {
        const next: Page = await this.fetch({ limit: LEGACY_LIMIT, cursor })
        if (generation !== this.generation) return
        this.timeline.load(next.items as readonly TimelineInput[] | undefined)
        cursor = next.cursor
      }
      this.cursor = undefined
      this.state = "done"
    } else {
      this.cursor = page.older
      this.state = page.older === undefined ? "done" : "idle"
    }
    this.changed()
  }
}
