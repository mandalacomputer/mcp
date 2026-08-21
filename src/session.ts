import { Api, DEFAULT_BASE_URL } from './api.js';
import { MandalaError } from './errors.js';

export type SessionConfig = {
  apiKey: string;
  baseUrl?: string;
  /** A computer bound at startup, so a single-machine setup never calls use_computer. */
  computerId?: string;
  /**
   * The caller's Anthropic key, for the one route that runs a model.
   *
   * Absent is the ordinary case and is not an error: the `run_agent` tool is
   * simply not registered, rather than being offered and then failing on use.
   * A tool a model can see is a tool it will try.
   */
  modelKey?: string;
};

/**
 * One MCP session's state: whose account, and which computer.
 *
 * Per-session and not per-process, which matters for the HTTP transport. There,
 * every caller arrives with their own `com_…` key and gets their own Session;
 * a module-level client would mean the second caller to connect drove the
 * first one's computers with the first one's key.
 */
export class Session {
  readonly api: Api;
  readonly modelKey?: string;
  #current?: string;
  /** WIDTHxHEIGHT of the bound computer, remembered from the last read of it. */
  #screen?: string;
  /** Successful deletes invalidate selections of the same id already in flight. */
  readonly #selectionVersions = new Map<string, number>();

  constructor(cfg: SessionConfig) {
    this.api = new Api(cfg.apiKey, cfg.baseUrl ?? DEFAULT_BASE_URL);
    this.modelKey = cfg.modelKey;
    this.#current = id(cfg.computerId);
  }

  get current(): string | undefined {
    return this.#current;
  }

  get screen(): string | undefined {
    return this.#screen;
  }

  bind(computerId: string, resolution?: string): void {
    this.#current = id(computerId);
    this.#screen = resolution;
  }

  /** Snapshot the delete generation before use_computer starts its confirming read. */
  selectionVersion(computerId: string): number {
    return this.#selectionVersions.get(id(computerId) ?? '') ?? 0;
  }

  /** Bind only if no concurrent delete completed while the id was being checked. */
  bindIfCurrent(computerId: string, resolution: string | undefined, version: number): boolean {
    const normalized = id(computerId);
    if (!normalized || this.selectionVersion(normalized) !== version) return false;
    this.bind(normalized, resolution);
    return true;
  }

  /** Forget the binding — after a delete, so the next call does not drive a ghost. */
  unbind(computerId: string): void {
    const normalized = id(computerId);
    if (!normalized) return;
    // Increment even when another computer is selected: an earlier
    // use_computer for this id may still be waiting on its GET response.
    this.#selectionVersions.set(normalized, this.selectionVersion(normalized) + 1);
    if (this.#current !== undefined && this.#current === normalized) {
      this.#current = undefined;
      this.#screen = undefined;
    }
  }

  /** Remember the screen without changing which computer is bound. */
  noteResolution(computerId: string, resolution?: string): void {
    if (id(computerId) === this.#current && resolution) this.#screen = resolution;
  }

  /**
   * Which computer a call is about.
   *
   * An explicit id always wins, so a session binding never silently redirects a
   * call that named its target. Without one, the binding answers; without a
   * binding, this refuses and says how to make one — a model that gets "no
   * computer selected" and a next step recovers in one turn, where a bare
   * "missing computer_id" sends it hunting through the tool list.
   */
  resolve(explicit?: string): string {
    const chosen = id(explicit) ?? this.#current;
    if (!chosen) {
      throw new MandalaError(
        'No computer selected. Call list_computers to see what is on this account, ' +
          'then use_computer to pick one — or pass computer_id on this call.',
      );
    }
    return chosen;
  }
}

/**
 * A computer id as this session compares it: trimmed, and absent when that
 * leaves nothing.
 *
 * Every id here ends up in a URL through `paths.segment`, which trims before it
 * encodes — so `" vm-1"` and `"vm-1"` have always named the same machine to the
 * platform while being two different strings to `===`. Every consequence of
 * that gap was silent and pointed the wrong way:
 *
 * - `delete_computer(" vm-1")` destroyed vm-1 and then failed to unbind it,
 *   leaving the session driving a machine that no longer exists — the exact
 *   ghost `unbind` was written to prevent.
 * - `noteResolution(" vm-1", …)` dropped the screen size, so the next click was
 *   scaled against a resolution from some other computer, or none.
 * - A `MANDALA_COMPUTER_ID` with the trailing newline a `.env` file or a
 *   `docker run --env-file` leaves on it was stored as-is, so a session started
 *   that way could never be unbound by any id a model could type.
 *
 * Normalising at this boundary rather than at each call site is the point: the
 * comparisons are the thing that was wrong, and there are four of them.
 */
function id(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
