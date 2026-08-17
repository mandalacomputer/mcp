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

  constructor(cfg: SessionConfig) {
    this.api = new Api(cfg.apiKey, cfg.baseUrl ?? DEFAULT_BASE_URL);
    this.modelKey = cfg.modelKey;
    this.#current = cfg.computerId;
  }

  get current(): string | undefined {
    return this.#current;
  }

  get screen(): string | undefined {
    return this.#screen;
  }

  bind(id: string, resolution?: string): void {
    this.#current = id;
    this.#screen = resolution;
  }

  /** Forget the binding — after a delete, so the next call does not drive a ghost. */
  unbind(id: string): void {
    if (this.#current === id) {
      this.#current = undefined;
      this.#screen = undefined;
    }
  }

  /** Remember the screen without changing which computer is bound. */
  noteResolution(id: string, resolution?: string): void {
    if (id === this.#current && resolution) this.#screen = resolution;
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
    const id = explicit ?? this.#current;
    if (!id) {
      throw new MandalaError(
        'No computer selected. Call list_computers to see what is on this account, ' +
          'then use_computer to pick one — or pass computer_id on this call.',
      );
    }
    return id;
  }
}
