// Reads the JSON-RPC lines the CI smoke test captured from the built server
// over stdio and fails unless the initialize request (id 1) succeeded with
// the protocol version asked for and tools/list (id 2) returned tools. Both
// halves matter: the server answers tools/list even after an initialize it
// refused, so a tool count alone does not show the server came up.
import { readFileSync } from 'node:fs';

const PROTOCOL = '2025-06-18';
const messages = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const reply = (id) => messages.find((m) => m.id === id);

const init = reply(1);
const list = reply(2);
const failures = [];
if (!init || init.error || init.result?.protocolVersion !== PROTOCOL) {
  failures.push(`initialize did not succeed with ${PROTOCOL}: ${JSON.stringify(init)}`);
}
const tools = list?.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) {
  failures.push(`tools/list returned no tools: ${JSON.stringify(list)?.slice(0, 500)}`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(`initialize ok (${PROTOCOL}), ${tools.length} tools`);
