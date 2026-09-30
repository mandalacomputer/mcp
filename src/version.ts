/**
 * This server's version, in a module of its own so that the API client can
 * name it in its `User-Agent` without importing `server.ts`, which imports the
 * client. The release workflow checks a tag against this line and
 * `package.json`.
 */
export const SERVER_VERSION = '0.8.0';
