# mandala-computer-mcp

An [MCP](https://modelcontextprotocol.io) server for
[Mandala Computer](https://mandala.computer) — cloud desktops for AI agents.

Point Claude Code, Claude Desktop, or anything else that speaks MCP at a real
Linux desktop it can **see and drive**. Screenshots come back as images, so the
model looks at the screen and clicks what it sees.

> **Status: alpha, unpublished.** The tool surface is settling; expect breaking
> changes before 1.0. Tracks the platform's `/api/v1`, which is itself still
> moving.

## Install

You need an API key from the dashboard — **Settings → API keys**, a `com_…`
string. It is scoped to your account and it is every computer on it, so treat it
the way you would treat a password.

**Claude Code**

```sh
claude mcp add mandala -e MANDALA_API_KEY=com_… -- npx -y mandala-computer-mcp
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mandala": {
      "command": "npx",
      "args": ["-y", "mandala-computer-mcp"],
      "env": { "MANDALA_API_KEY": "com_…" }
    }
  }
}
```

Nothing is hosted and nothing is operated: your MCP client starts this as a
subprocess, and it talks to `https://app.mandala.computer/api/v1` with your key.

## Use

Ask for what you want. A first session usually goes:

> Create a computer from the base template, open example.com, and show me what's
> on the screen.

Under that, the model is doing roughly this:

```
create_computer(template="base")     → builds it and selects it for the session
wait_for_computer(until="guest")     → the desktop inside is answering, not just the VM
open_url(url="https://example.com")  → puts the page on the screen
screenshot()                         → an image the model can point at
click(x=640, y=400)                  → clicks what it saw
screenshot()                         → looks again
```

`use_computer` binds a machine to the session, so every later call can leave
`computer_id` out. Pass `computer_id` explicitly on any call to override it
without changing the binding, which is how you drive two machines at once.

Set `MANDALA_COMPUTER_ID` to bind one at startup and skip `use_computer`
entirely.

## The tools

**Choosing a machine** — `list_templates`, `list_sizes`, `list_computers`, `get_computer`,
`use_computer`, `wait_for_computer`, `get_desktop_url`

**Lifecycle** — `create_computer`, `start_computer`, `stop_computer`,
`suspend_computer`, `restart_computer`, `update_computer`, `clone_computer`,
`delete_computer`

**Driving the desktop** — `screenshot`, `click`, `type_text`, `press_key`,
`scroll`, `drag`, `move_mouse`, `mouse_button`, `cursor_position`, `wait`

**Inside the guest** — `exec`, `exec_poll`, `exec_kill`, `open_url`,
`list_windows`, `window_action`, `read_file`, `write_file`

**Snapshots** — `list_snapshots`, `snapshot_holdings`, `create_snapshot`,
`restore_snapshot`, `clone_snapshot`, `snapshot_schedule`, `delete_snapshot`

**Delegating** — `run_agent`, registered only when a model key is present:
`MANDALA_MODEL_KEY` on stdio, or the caller's own `X-Model-Key` header over HTTP.

## Things worth knowing

**A screenshot is how you find out what happened.** Nothing on a desktop reports
back. The tools say so in their own descriptions, and the server's instructions
say it once more, because a model that acts without looking is the single most
common way one of these sessions goes wrong.

**`running` does not mean ready.** A computer reports running when the
hypervisor has started the VM; the desktop inside comes up seconds later.
`wait_for_computer(until="guest")` waits for the software to answer, which is
what `exec`, files and a painted screen actually need.

**`exec` runs as root with no display.** A GUI application started without
`desktop: true` cannot draw. `open_url` is the reliable way to put a web page on
the screen — and it returns before the browser paints, sometimes by ten seconds.

**Anything slow wants `background: true`.** A build or an install run in the
foreground comes back as a timeout, with the work still going inside the guest
and its output unreadable. With a handle you get the exit code and the output,
and `exec_kill` stops it.

Past about **two minutes** it does not even come back as a timeout. A proxy in
front of the platform abandons a request that has produced no response for
roughly that long and answers 524, which arrives as `GatewayTimeoutError` —
whatever `timeout_s` said, because the hop that gives up never saw it. Measured
against `app.mandala.computer`: `sleep 130` failed at 125.2s with
`timeout_s: 300` and at 125.3s with `timeout_s: 3600`. Raising `timeout_s` buys
nothing; `background: true` is the only thing that works. The abandoned command
keeps running, so the call after one of these often reports the guest agent as
busy — that is the first failure continuing, not a second one.

The ceiling belongs to that proxy rather than to the platform, which is why
`timeout_s` still accepts up to 300: a `MANDALA_BASE_URL` pointed at an origin
reached without the proxy in front of it does not have one.

**`list_windows` sees what a screenshot cannot.** It is how you tell an
application that failed to start from one that has not painted yet. Match on
`class` (the application), not `title` (whatever page it is showing).

**Computers suspend themselves.** After 30 minutes untouched, by default. Input,
`exec` and file transfers count as use and resume it automatically;
**screenshots deliberately do not**, so a loop that only watches can see its own
machine go down under it.

**A stop is a request, and can be refused.** `stop_computer` asks the guest to
shut down and gives it time to do it. A hung X session, a modal "unsaved
changes" dialog or a service that ignores its own shutdown will refuse that
identically every time it is asked. `force: true` pulls the power instead — the
equivalent of holding the button in — and whatever the guest had not written to
disk goes with it, so it is the second attempt rather than the first.

**Purging snapshots is bound to the set you were shown.** Deleting a computer
keeps its snapshots by default. To destroy them too, read `snapshot_holdings`
first — a count, a byte total and a fingerprint — and pass that fingerprint to
`delete_computer` as `expect`. The purge is then refused if the set has changed
since you looked, so a capture that finished in between cannot be swept up by a
decision that was never about it. `delete_computer` will not purge without one,
and the platform makes `expect` optional only for callers that had no way to
read the holdings.

**A short list is refused, not silently served.** `list_computers` and
`list_snapshots` fan out across hypervisors, and if one cannot be reached the
platform answers 503 rather than a list that is quietly missing things.
`allow_partial: true` accepts the incomplete answer instead — and when it does,
the result opens with an `INCOMPLETE:` line saying so, because a short list
reads exactly like the missing things were deleted.

**Snapshots mid-deletion are billed but hidden.** A deletion that began and did
not finish still holds objects and still counts against storage, and the default
listing leaves it out — every ordinary caller is asking "what can I restore".
`list_snapshots(include_unfinished: true)` is the flag for when the question is
about storage instead.

**A 409 usually clears; a 400 never does.** A guest still booting or a busy
guest agent answers 409. The platform's own error messages come through
unedited, because they are written to be acted on.

**Desktop links are credentials.** `get_desktop_url` returns the watch-only URL
by default — the platform drops input on that socket, so it is safe to hand to
somebody. `control: true` returns the full-control one, which is root-equivalent
on that machine. Neither appears in any other tool's output, deliberately: a
tool result lands in a model's context and from there in whatever captured it.

## Running it as a service

The same server speaks streamable HTTP, for clients that cannot spawn a
subprocess — claude.ai, mobile, a shared team endpoint:

```sh
MANDALA_ALLOWED_HOSTS=mcp.mandala.computer npx mandala-computer-mcp --http --port 3000
```

```sh
claude mcp add --transport http mandala https://mcp.mandala.computer/mcp \
  --header "Authorization: Bearer com_…"
```

**It holds no credential of its own.** Each caller's key arrives as their own
bearer token and is used only for their session; there is no store, and nothing
outlives a session but a digest of the key — kept so that a later request can be
shown to come from the same holder, which means a leaked session id on its own
is not enough to drive somebody else's desktop.

That is also why anyone can run their own: point the same container at the same
API and it works, with no secret to provision.

Bound to loopback — the default — it answers only to `127.0.0.1`, `localhost`
and `[::1]`, so a page the user happens to be visiting cannot reach it by
resolving its own name there. Served under a name, or bound to `0.0.0.0`, that
default cannot be guessed and `MANDALA_ALLOWED_HOSTS` is what turns the check
back on.

Which matters most in the arrangement that looks like neither: bound to
`127.0.0.1:3000` **behind a proxy** — nginx, Caddy, cloudflared, ngrok. The
proxy forwards the original `Host: mcp.example.com`, the loopback default does
not list it, and every request is refused with a 403. Set
`MANDALA_ALLOWED_HOSTS` to the name it is served under. Startup says which list
is in force, so a `403` on a deployment that worked before has a line above it
naming the fix.

### Configuration

| Variable | Meaning |
| --- | --- |
| `MANDALA_API_KEY` | `com_…` from Settings → API keys. Required on stdio; over HTTP each caller sends their own. |
| `MANDALA_BASE_URL` | Defaults to `https://app.mandala.computer/api/v1`. |
| `MANDALA_COMPUTER_ID` | Bind a computer at startup, so `use_computer` is not needed. **stdio only** — under `--http` it is ignored rather than bound into every caller's session, since it names a machine on the operator's account. |
| `MANDALA_MODEL_KEY` | An Anthropic key. Enables `run_agent`, which runs the platform's own loop on that key. **stdio only** — under `--http` each caller sends their own as `X-Model-Key`, and this variable is ignored. |
| `MANDALA_NO_LIFECYCLE` | `1` withholds `create_computer`, `clone_computer`, `clone_snapshot`, `delete_computer` and `delete_snapshot` — every tool that makes a computer or destroys one. |
| `PORT`, `HOST` | For `--http`. Default `3000`, `127.0.0.1`. |
| `MANDALA_ALLOWED_HOSTS`, `MANDALA_ALLOWED_ORIGINS` | Comma-separated. Which `Host` and `Origin` values this server answers to. On a loopback bind the host list defaults to the address it was given, so DNS-rebinding protection is on without configuration; set this when serving under a name. |

`run_agent` deserves a note. It hands a task to the platform's own agent loop,
which drives the computer inside the platform and answers with a sentence. Worth
it when a stretch of pixel work would otherwise cost the calling model a
screenshot per step — ten clicks stop being ten images. It bills your Anthropic
key, and the platform never stores that key.

## Development

```sh
npm install
npm test          # vitest, plus the surface check below
npm run build
npm run lint
```

### The surface check

The platform allowlists every route `/api/v1` will answer and 404s the rest.
`test/allowlist.ts` mirrors that table, and the tests assert two things: that
every call this server can make lands on an allowlisted route, and that the gap
between the platform's surface and this server's coverage is *exactly* the set
written down in `UNIMPLEMENTED`. A route added upstream becomes a failing test
here rather than a feature nobody noticed.

`npm run check:surface` goes further and diffs the mirror against the real
`V1_ROUTES` in the platform repo, whenever that repo happens to be checked out
next door — or wherever `MANDALA_PLATFORM_REPO` points. It skips silently when
it is not there, which is the ordinary case in CI on this repository.

```
check:surface — in step with /Users/…/gorillacloud (30 routes).
```

### Where the platform's rules live

This server gets no privileged access. Everything it does goes through the same
curated `/api/v1` surface the Python SDK uses, owner-scoped to the key's account
and audited against it. Anything it needs that `/api/v1` does not expose is a
change to the platform's route table, not a wider pass-through here — see the
long note at the top of `web/lib/surface.ts` in the platform repo for why that
boundary is where it is.

## See also

- [mandala-computer-python](https://github.com/mboyd1/mandala-computer-python) —
  the Python SDK, for writing code against the same API rather than driving it
  from a model.

## Licence

MIT.
