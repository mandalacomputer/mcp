#!/usr/bin/env node
import { DEFAULT_BASE_URL } from './api.js';
import { runHttp } from './http.js';
import { runStdio } from './stdio.js';

const USAGE = `mandala-computer-mcp — drive a Mandala Computer desktop over MCP

  mandala-computer-mcp                 stdio (what an MCP client spawns)
  mandala-computer-mcp --http [--port 3000]   hosted, callers bring their own key

Environment
  MANDALA_API_KEY      com_… from Settings → API keys. Required on stdio; over
                       HTTP each caller sends their own as a bearer token.
  MANDALA_BASE_URL     default ${DEFAULT_BASE_URL}
  MANDALA_COMPUTER_ID  bind a computer at startup, so use_computer is not needed
  MANDALA_MODEL_KEY    an Anthropic key; enables the run_agent tool. stdio only
                       — over HTTP each caller sends their own X-Model-Key, and
                       this is ignored rather than spent on their runs
  MANDALA_NO_LIFECYCLE set to 1 to withhold create_computer, clone_computer,
                       delete_computer and delete_snapshot
  PORT, HOST           for --http (default 3000, 127.0.0.1)
  MANDALA_ALLOWED_HOSTS, MANDALA_ALLOWED_ORIGINS
                       comma-separated; enables DNS-rebinding protection

Flags override the environment.`;

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return flags;
}

/**
 * The port to listen on, or a refusal naming what was wrong with it.
 *
 * `--port` with nothing after it parses as the boolean true, and `Number(true)`
 * is 1 — a privileged port nobody asked for, which also swallows the PORT
 * environment variable on the way past, since `??` sees a value. Better to say
 * so than to fail later with EACCES on a number the user never typed.
 */
function port(flag: string | boolean | undefined): number {
  if (flag === true) throw new Error('--port needs a number, e.g. --port 3000');
  const raw = flag ?? process.env.PORT ?? '3000';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`not a port number: ${raw}`);
  }
  return n;
}

const list = (v: string | undefined) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

async function main(): Promise<void> {
  const flags = parse(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(USAGE);
    return;
  }
  if (flags.version) {
    console.log('0.1.0');
    return;
  }

  const base = {
    baseUrl: (flags['base-url'] as string) || process.env.MANDALA_BASE_URL || DEFAULT_BASE_URL,
    computerId: (flags.computer as string) || process.env.MANDALA_COMPUTER_ID || undefined,
    modelKey: process.env.MANDALA_MODEL_KEY || undefined,
    lifecycle: !(flags['no-lifecycle'] || process.env.MANDALA_NO_LIFECYCLE === '1'),
  };

  if (flags.http) {
    await runHttp({
      ...base,
      port: port(flags.port),
      host: (flags.host as string) || process.env.HOST || '127.0.0.1',
      allowedHosts: list((flags['allowed-hosts'] as string) || process.env.MANDALA_ALLOWED_HOSTS),
      allowedOrigins: list(
        (flags['allowed-origins'] as string) || process.env.MANDALA_ALLOWED_ORIGINS,
      ),
    });
    return;
  }

  const apiKey = (flags.key as string) || process.env.MANDALA_API_KEY || '';
  if (!apiKey) {
    // stderr and a non-zero exit, not a thrown stack. On stdio the client sees
    // a process that died; the person reading the log needs the one sentence
    // that tells them what to set.
    console.error(
      'No API key. Set MANDALA_API_KEY (Settings → API keys at https://app.mandala.computer), ' +
        'or run with --http and let each caller send their own.',
    );
    process.exit(2);
  }
  await runStdio({ ...base, apiKey });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
