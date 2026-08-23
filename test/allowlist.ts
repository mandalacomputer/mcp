/**
 * A mirror of `V1_ROUTES` in the platform's `web/lib/surface.ts`.
 *
 * The platform allowlists routes server-side and 404s everything else. That
 * check lives there; this one exists because a server calling a route the
 * platform does not expose fails in a user's hands rather than here.
 *
 * Kept in step by hand, and checked by `npm run check:surface`, which parses
 * the real table out of the platform repo when it happens to be checked out
 * alongside this one. That script is the reason this file is data rather than
 * prose: a comment saying "keep this in step" is not a thing that fails.
 */
export type Route = { method: string; pattern: string };

const r = (method: string, pattern: string): Route => ({ method, pattern });

export const V1_ROUTES: Route[] = [
  r('GET', 'templates'),
  r('GET', 'sizes'),

  r('GET', 'computers'),
  r('POST', 'computers'),
  r('GET', 'computers/:id'),
  r('PATCH', 'computers/:id'),
  r('DELETE', 'computers/:id'),
  r('POST', 'computers/:id/start'),
  r('POST', 'computers/:id/stop'),
  r('POST', 'computers/:id/suspend'),
  r('POST', 'computers/:id/restart'),
  r('POST', 'computers/:id/clone'),

  // Taking up the offer a refused resize makes, and reading how it went
  // (OPL-3766). A collection rather than `computers/:id/move`, which is the
  // platform's decision and worth knowing when mirroring it: a per-computer read
  // could not tell a computer with no move from an id that does not exist.
  r('POST', 'computers/:id/move'),
  r('GET', 'moves'),

  // Computer use.
  r('GET', 'computers/:id/screenshot'),
  r('POST', 'computers/:id/input'),
  r('POST', 'computers/:id/exec'),
  r('GET', 'computers/:id/exec/:pid'),
  r('DELETE', 'computers/:id/exec/:pid'),
  r('GET', 'computers/:id/windows'),
  r('POST', 'computers/:id/windows/:window'),

  // The platform's own agent loop, and the same engine behind an
  // OpenAI-shaped door.
  r('POST', 'computers/:id/agent'),
  r('POST', 'chat/completions'),

  // Files in and out of the guest.
  r('PUT', 'computers/:id/files'),
  r('GET', 'computers/:id/files'),

  // Snapshots.
  r('GET', 'snapshots'),
  // What a computer holds — a count, a byte total, and the fingerprint that
  // names the set. Not a listing; that is GET /snapshots. Added to this table
  // in OPL-3636, having been on the dashboard's and the admin's and not this
  // one, which is the silent 404 the platform's own table warns about.
  r('GET', 'computers/:id/snapshots'),
  r('POST', 'computers/:id/snapshots'),
  r('POST', 'snapshots/:id/restore'),
  r('POST', 'snapshots/:id/clone'),
  r('DELETE', 'snapshots/:id'),
  r('GET', 'computers/:id/schedule'),
  r('PUT', 'computers/:id/schedule'),
  r('DELETE', 'computers/:id/schedule'),

  // What the account has used (OPL-3765). Account-scoped like `moves`, and for
  // a related reason: the figures include computers that have since been
  // deleted, which is precisely the line an unexplained invoice is about.
  r('GET', 'usage'),
  // How long the automatic snapshots a schedule takes are kept. Account-scoped
  // like `usage` and `moves`, and read-only on every surface: the plan owns
  // retention.
  r('GET', 'retention'),
];

/**
 * Every query parameter, header and body field the platform documents, by route.
 *
 * The second mirror, and the one the first turned out to need. V1_ROUTES proves
 * this server can reach every route; it cannot say whether a call carries the
 * arguments that make the route worth reaching. `Range` on `GET
 * computers/:id/files` is the case that proved it: the platform shipped it in
 * OPL-3727 naming this server as the caller it was for, `check:surface` went on
 * reporting "in step with gorillacloud (32 routes)", and read_file went on
 * telling models it could not page — because a header is a parameter of a route
 * that already existed, and a route table has nowhere to put one.
 *
 * Mirrored from the DOCS table in `web/lib/apidoc.ts` in the platform repo, and
 * compared by `scripts/check-surface.mjs`. That table is the published contract
 * — it is what generates the OpenAPI document and the docs site — so a
 * parameter absent from it is one no caller has been told about, and a
 * parameter here that is absent from it is one this server is sending into a
 * handler that ignores it.
 *
 * Kept in the wire spelling, not this server's: `ram_mb` and not `ramMb`, and
 * `body:timeout_s` for a tool argument that happens to share the name, so the
 * comparison is against what the platform actually reads.
 */
export const PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['GET templates', []],
  ['GET sizes', []],

  ['GET computers', ['query:allow_partial']],
  [
    'POST computers',
    [
      'body:name',
      'body:size',
      'body:template',
      'body:cpu',
      'body:ram_mb',
      'body:disk_gb',
      'body:resolution',
      'body:start',
    ],
  ],
  ['GET computers/:id', []],
  [
    'PATCH computers/:id',
    ['body:name', 'body:cpu', 'body:ram_mb', 'body:disk_gb', 'body:idle_suspend_min'],
  ],
  ['DELETE computers/:id', ['query:snapshots', 'query:expect']],
  ['POST computers/:id/start', []],
  ['POST computers/:id/stop', ['query:force']],
  ['POST computers/:id/suspend', []],
  ['POST computers/:id/restart', []],
  ['POST computers/:id/clone', ['body:name']],
  // The same sizing group PATCH takes, minus the two fields a move cannot
  // deliver: the platform reads only these three off the body and ignores the
  // rest, so a rename sent here would be dropped without a word.
  ['POST computers/:id/move', ['body:cpu', 'body:ram_mb', 'body:disk_gb']],
  ['GET moves', []],

  // Computer use.
  ['GET computers/:id/screenshot', ['query:w', 'query:fresh']],
  [
    'POST computers/:id/input',
    [
      'body:action',
      'body:x',
      'body:y',
      'body:coordinate',
      'body:start_coordinate',
      'body:text',
      'body:key',
      'body:keys',
      'body:button',
      'body:scroll_direction',
      'body:amount',
      'body:scroll_amount',
      'body:duration',
    ],
  ],
  [
    'POST computers/:id/exec',
    ['body:command', 'body:session', 'body:timeout_s', 'body:background', 'body:cwd', 'body:env'],
  ],
  ['GET computers/:id/exec/:pid', []],
  ['DELETE computers/:id/exec/:pid', []],
  ['GET computers/:id/windows', ['query:include']],
  [
    'POST computers/:id/windows/:window',
    ['body:action', 'body:x', 'body:y', 'body:width', 'body:height'],
  ],

  [
    'POST computers/:id/agent',
    [
      'header:X-Model-Key',
      'body:prompt',
      'body:system',
      'body:max_steps',
      'body:model',
      'body:stream',
    ],
  ],
  [
    'POST chat/completions',
    [
      'header:X-Model-Key',
      'body:computer_id',
      'body:messages',
      'body:model',
      'body:max_steps',
      'body:stream',
    ],
  ],

  // The upload's body is the file, raw — there are no named fields to mirror.
  ['PUT computers/:id/files', ['query:path']],
  // And the download's answer is the file. `Range` is the one header a caller
  // sends that reaches the daemon, and read_file's whole ability to page
  // through a file larger than one request moves is this line.
  ['GET computers/:id/files', ['query:path', 'header:Range']],

  ['GET snapshots', ['query:allow_partial', 'query:include']],
  ['GET computers/:id/snapshots', []],
  ['POST computers/:id/snapshots', ['body:name', 'body:memory']],
  ['POST snapshots/:id/restore', []],
  ['POST snapshots/:id/clone', ['body:name']],
  ['DELETE snapshots/:id', []],
  ['GET computers/:id/schedule', []],
  ['PUT computers/:id/schedule', ['body:enabled', 'body:hour', 'body:minute', 'body:tz']],
  ['DELETE computers/:id/schedule', []],

  // Both bounds, and both optional: with neither, the platform answers over the
  // account's current billing period.
  ['GET usage', ['query:from', 'query:to']],

  ['GET retention', []],
]);

/**
 * Parameters the platform documents that this server does not send.
 *
 * Two kinds in one set, and each entry says which it is. A DECISION is an
 * alternate spelling of something this server does send: the input route
 * accepts Anthropic's computer-use vocabulary alongside this API's own, so a
 * model's `tool_use.input` block can be forwarded without translation, which
 * leaves several fields with two names apiece. Picking one and sending it
 * consistently is the point; sending both would be two ways for one call to
 * mean different things. A GAP is a parameter no tool can currently reach —
 * work to do, listed here so that it is somebody's to close rather than
 * nobody's to notice.
 *
 * One set rather than two because what the test needs is the union: the
 * question it asks is "is every documented parameter either sent or accounted
 * for", and which kind of account it is belongs on the line, not in the shape
 * of the file.
 *
 * Parameters of a route in UNIMPLEMENTED are not listed — a route nobody calls
 * sends none of its parameters, and repeating all six of chat/completions'
 * would say nothing that route's own line does not.
 */
export const UNIMPLEMENTED_PARAMETERS: ReadonlySet<string> = new Set([
  // DECISION. `keys: ['ctrl', 'c']` is sent instead. The chord-as-one-string
  // form cannot express a key whose own name contains the separator.
  'POST computers/:id/input  body:key',
  // DECISION. `scroll_direction` is sent instead — `button` is the flat
  // vocabulary's name for it, and on a route that also accepts a real mouse
  // button that is a word worth not overloading.
  'POST computers/:id/input  body:button',
  // DECISION. `amount` is sent instead. Same value, two names.
  'POST computers/:id/input  body:scroll_amount',
  // DECISION. The model is the one this server was configured with, through
  // MODEL_KEY_HEADER, and run_agent bills that key for every step. Offering a
  // model argument would let the caller pick something the key may not be
  // entitled to, and the failure would arrive several steps into a run.
  'POST computers/:id/agent  body:model',
]);

export const key = (route: Route) => `${route.method} ${route.pattern}`;
export const ALLOWED = new Set(V1_ROUTES.map(key));

/**
 * Routes the platform exposes that this server deliberately does not call.
 *
 * Pinned rather than left implicit, because "every call lands on an allowlisted
 * route" stays true no matter how few calls there are. Making the gap a set that
 * has to be edited is what turns a route added upstream into a failing test
 * rather than a feature nobody noticed.
 */
export const UNIMPLEMENTED = new Set([
  // The OpenAI-compatible door onto the same agent loop the platform already
  // exposes at computers/:id/agent, which run_agent uses. Two ways to reach one
  // engine is a good thing for a caller who already has an OpenAI client
  // pointed somewhere; it is nothing at all to an MCP client, which has neither
  // a base URL to redirect nor a reason to prefer the vocabulary.
  'POST chat/completions',
]);

/**
 * Reduce a concrete path to its route pattern, exactly as `patternFor` in the
 * platform's surface.ts does — by position and by parent, never by a regex over
 * the raw path, so an id can never be mistaken for a route segment.
 */
export function patternFor(path: string): string {
  const parts = path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  return parts
    .map((seg, i) => {
      const parent = parts[i - 1];
      if (parent === 'computers' || parent === 'snapshots') return ':id';
      if (i === 3 && parts[0] === 'computers' && parts[2] === 'windows') return ':window';
      if (i === 3 && parts[0] === 'computers' && parts[2] === 'exec') return ':pid';
      return seg;
    })
    .join('/');
}
