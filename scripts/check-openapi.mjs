import { createHash } from 'node:crypto';

export const PUBLIC_OPENAPI_URL = 'https://app.mandala.computer/api/docs/openapi.json';
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inScope = (path) => path === '/api/v1' || path.startsWith('/api/v1/');

function validPath(path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    /[?#\\\s]/.test(path) ||
    path.includes('//')
  )
    throw new Error('Invalid OpenAPI path');
  const segments = path === '/' ? [] : path.slice(1).split('/');
  for (const [index, segment] of segments.entries()) {
    if (
      (!segment && index !== segments.length - 1) ||
      segment === '.' ||
      segment === '..' ||
      (/[{}]/.test(segment) && !/^\{[A-Za-z_][A-Za-z0-9_-]*\}$/.test(segment))
    )
      throw new Error('Unsupported OpenAPI path segment');
  }
  return segments;
}
function serverBases(servers) {
  if (servers === undefined) return [''];
  if (!Array.isArray(servers) || !servers.length) throw new Error('Unsupported OpenAPI servers');
  return servers.map((server) => {
    if (
      !record(server) ||
      typeof server.url !== 'string' ||
      server.variables !== undefined ||
      server.$ref !== undefined ||
      /[{}]/.test(server.url)
    )
      throw new Error('Unsupported OpenAPI server variables or reference');
    let url;
    try {
      url = new URL(server.url, PUBLIC_OPENAPI_URL);
    } catch {
      throw new Error('Invalid OpenAPI server URL');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Unsupported OpenAPI server URL');
    const path = url.pathname.replace(/\/$/, '');
    if (path) validPath(path);
    return path;
  });
}

/** Required subset: extra predeployment MCP operations belong to the separate mirror check. */
export function parseOperations(document) {
  if (
    !record(document) ||
    typeof document.openapi !== 'string' ||
    !/^3\.(0|1|2)\.\d+(?:[-+][\w.-]+)?$/.test(document.openapi) ||
    !record(document.paths)
  )
    throw new Error('Expected a supported OpenAPI 3.x document with object paths');
  const rootBases = serverBases(document.servers);
  const operations = [];
  const excluded = [];
  const owners = new Map();
  for (const [path, item] of Object.entries(document.paths)) {
    if (path.startsWith('x-')) continue;
    validPath(path);
    if (!record(item) || item.$ref !== undefined)
      throw new Error('Unsupported OpenAPI path item or reference');
    const pathBases = item.servers === undefined ? rootBases : serverBases(item.servers);
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      if (
        !record(operation) ||
        operation.$ref !== undefined ||
        !record(operation.responses) ||
        !Object.keys(operation.responses).length ||
        Object.values(operation.responses).some((response) => !record(response))
      )
        throw new Error('Invalid OpenAPI operation');
      const bases = operation.servers === undefined ? pathBases : serverBases(operation.servers);
      for (const base of bases) {
        // OpenAPI appends the path to the effective server URL, including repeated segments.
        const full = `${base}${path}`;
        const segments = validPath(full);
        const key = `${method.toUpperCase()} ${full}`;
        if (!inScope(full)) {
          excluded.push(key);
          continue;
        }
        const canonical = `${method.toUpperCase()} ${full.replace(/\{[^}]+\}/g, '{}')}`;
        const previous = owners.get(canonical);
        if (previous !== undefined && previous !== path)
          throw new Error('Ambiguous OpenAPI operation templates');
        if (previous !== undefined) continue;
        owners.set(canonical, path);
        operations.push({ method: method.toUpperCase(), path: full, segments, key });
      }
    }
  }
  if (!operations.length) throw new Error('No in-scope /api/v1 OpenAPI operations');
  return { operations, excluded: [...new Set(excluded)].sort() };
}

/**
 * `METHOD pattern` with every parameter reduced to `{}`, from either spelling:
 * a published operation's `/api/v1/secrets/{id}` or the mirror's `secrets/:id`.
 */
function routeShape(method, path) {
  // A trailing slash is kept: requests are matched segment by segment, so
  // `/secrets/` is a different operation from `/secrets` and must not borrow
  // its exemption.
  const bare = path.replace(/^\/api\/v1(?=\/|$)/, '').replace(/^\/+/, '');
  const shape = bare
    .split('/')
    .map((seg) => (/^\{[^}]+\}$/.test(seg) || /^:[^/]+$/.test(seg) ? '{}' : seg))
    .join('/');
  return `${method.toUpperCase()} ${shape}`;
}

/**
 * Credit one concrete request to at most one operation, respecting literal paths.
 *
 * `unsent` names operations no tool reaches YET, in the mirror's spelling
 * (`GET secrets/:id`) — the same list as `UNIMPLEMENTED` in test/allowlist.ts,
 * so a gap is written down once. A published operation on that list is
 * reported rather than failed; every other one must still be exercised.
 */
export function compareCoverage(contract, evidence, { unsent = [] } = {}) {
  const pending = new Set(
    [...unsent].map((entry) => {
      const [method, pattern] = String(entry).split(' ');
      if (!method || pattern === undefined) throw new Error('Invalid unsent operation');
      return routeShape(method, pattern);
    }),
  );
  if (!Array.isArray(evidence) || !evidence.length) throw new Error('No tool request evidence');
  const seen = new Set();
  let requests = 0;
  const zero = [];
  for (const entry of evidence) {
    if (typeof entry.tool !== 'string' || !entry.tool || !Array.isArray(entry.requests))
      throw new Error('Invalid tool request evidence');
    if (!entry.requests.length) zero.push(entry.tool);
    for (const request of entry.requests) {
      requests++;
      if (
        typeof request.method !== 'string' ||
        typeof request.path !== 'string' ||
        !request.path.startsWith('/') ||
        /[?#\\\s{}]/.test(request.path) ||
        request.path.includes('//')
      )
        throw new Error('Invalid concrete HTTP request evidence');
      const segments = request.path.slice(1).split('/');
      const paths = contract.operations.filter(
        (op) =>
          op.segments.length === segments.length &&
          op.segments.every((seg, i) =>
            /^\{[^}]+\}$/.test(seg) ? Boolean(segments[i]) : seg === segments[i],
          ),
      );
      // Fully literal paths win, regardless of which method was requested.
      const literals = paths.filter((op) => !op.path.includes('{'));
      const candidates = literals.length ? literals : paths;
      const distinctPaths = new Set(candidates.map((op) => op.path));
      if (distinctPaths.size > 1) throw new Error('Ambiguous OpenAPI request match');
      const matches = candidates.filter((op) => op.method === request.method.toUpperCase());
      if (matches.length > 1) throw new Error('Ambiguous OpenAPI operation match');
      if (matches.length === 1) seen.add(matches[0].key);
    }
  }
  if (zero.length) throw new Error(`Zero request coverage for tools: ${zero.sort().join(', ')}`);
  if (!requests) throw new Error('No tool request evidence');
  // An exemption must name something the publication has. One that matches
  // nothing is drift — a published operation renamed or dropped — and passing
  // it silently would read as coverage resolved.
  const published = new Set(contract.operations.map((op) => routeShape(op.method, op.path)));
  const stale = [...pending].filter((shape) => !published.has(shape)).sort();
  if (stale.length)
    throw new Error(`Not-yet-sent operations absent from the publication:\n${stale.join('\n')}`);
  const uncovered = contract.operations.filter((op) => !seen.has(op.key));
  const notYetSent = uncovered
    .filter((op) => pending.has(routeShape(op.method, op.path)))
    .map((op) => op.key)
    .sort();
  const missing = uncovered
    .filter((op) => !pending.has(routeShape(op.method, op.path)))
    .map((op) => op.key)
    .sort();
  if (missing.length) throw new Error(`Missing published operations:\n${missing.join('\n')}`);
  return {
    operations: contract.operations.length,
    requests,
    tools: evidence.length,
    excluded: contract.excluded,
    unsent: notYetSent,
  };
}

export class PublicationError extends Error {
  constructor(classification, status) {
    super(
      `Published OpenAPI ${classification}${status === undefined ? '' : ` (HTTP ${status})`}: ${PUBLIC_OPENAPI_URL}`,
    );
    this.name = 'PublicationError';
    this.classification = classification;
    this.status = status;
  }
}

/** One bounded anonymous attempt; injected fetch is for offline tests, never a URL fallback. */
export async function fetchPublishedOpenApi({
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8 * 1024 * 1024
  )
    throw new PublicationError('invalid fetch bounds');
  const controller = new AbortController();
  let reader;
  let response;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new PublicationError('deadline exceeded'));
  }, timeoutMs);
  const bounded = (work) => Promise.race([work, deadline]);
  try {
    const fetching = fetchImpl(PUBLIC_OPENAPI_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    void fetching.then(
      (late) => {
        if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
      },
      () => {},
    );
    response = await bounded(fetching);
    if (response.status !== 200) throw new PublicationError('unsuccessful status', response.status);
    if (response.redirected || (response.url && response.url !== PUBLIC_OPENAPI_URL))
      throw new PublicationError('redirect rejected', response.status);
    if (
      !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new PublicationError('non-JSON content type', response.status);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
      throw new PublicationError('body size limit', response.status);
    if (!response.body) throw new PublicationError('empty body', response.status);
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new PublicationError('body size limit', response.status);
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    let document;
    try {
      document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new PublicationError('invalid JSON or UTF-8', response.status);
    }
    let contract;
    try {
      contract = parseOperations(document);
    } catch {
      throw new PublicationError('invalid operation contract', response.status);
    }
    return {
      document,
      contract,
      digest: createHash('sha256').update(bytes).digest('hex'),
      status: response.status,
    };
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError(controller.signal.aborted ? 'deadline exceeded' : 'fetch failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
