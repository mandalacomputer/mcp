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
];

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
