/**
 * The library face of this package, for embedding the server rather than
 * spawning it — a host application that already knows who the user is can build
 * a server on their key without going through the CLI.
 */
export { Api, DEFAULT_BASE_URL, MODEL_KEY_HEADER } from './api.js';
export {
  APIError,
  AuthenticationError,
  CancelledError,
  ConflictError,
  ConnectivityError,
  ConnectivityInterruptedError,
  GatewayTimeoutError,
  isTransient,
  MandalaError,
  MoveRequiredError,
  NotFoundError,
  OriginResponseError,
  OriginTLSError,
  OriginUnreachableError,
  PermissionDeniedError,
  PlanLimitError,
  RangeNotSatisfiableError,
  RateLimitError,
  type ReasonKind,
  RedirectError,
  reasonKind,
  UnavailableError,
} from './errors.js';
export { type HttpConfig, runHttp } from './http.js';
export { createServer, SERVER_NAME, SERVER_VERSION, type ServerConfig } from './server.js';
export { Session, type SessionConfig } from './session.js';
export { runStdio } from './stdio.js';
export type { ToolOptions } from './tools/types.js';
