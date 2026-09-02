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
`delete_computer`, `move_computer`, `list_moves`

**Driving the desktop** — `screenshot`, `click`, `type_text`, `press_key`,
`scroll`, `drag`, `move_mouse`, `mouse_button`, `cursor_position`, `wait`

**Inside the guest** — `exec`, `exec_poll`, `exec_kill`, `open_url`,
`list_windows`, `window_action`, `read_clipboard`, `write_clipboard`,
`read_file`, `write_file`

**Being told rather than asking** — `wait_for_event`, `poll_events`,
`wait_for_file_change`

**Snapshots** — `list_snapshots`, `snapshot_holdings`, `create_snapshot`,
`restore_snapshot`, `clone_snapshot`, `snapshot_schedule`, `get_retention`,
`delete_snapshot`

**Your own templates** — `get_template_schema`, `check_template`,
`publish_template`, `get_template`, `retire_template`

**Building one** — `build_template`, `list_builds`, `get_build`, `watch_build`

**Spending** — `get_usage`

**Being told somewhere else** — `list_webhooks`, `create_webhook`,
`get_webhook`, `update_webhook`, `rotate_webhook_secret`, `test_webhook`,
`list_webhook_deliveries`, `delete_webhook`

**Delegating** — `run_agent`, registered only when a model key is present:
`MANDALA_MODEL_KEY` on stdio, or the caller's own `X-Model-Key` header over HTTP.

## Things worth knowing

**A screenshot is how you find out what the screen looks like.** A click that
landed and a click that did nothing produce the same tool result, so a model
that acts without looking is the single most common way one of these sessions
goes wrong. The tools say so in their own descriptions and the server's
instructions say it once more.

**But a screenshot is no longer how you find out whether anything happened.**
The platform's computers report what they do — a window opening, closing or
taking focus, the clipboard changing hands, a background command exiting, the
desktop coming up, the machine going idle, every power transition — and
`wait_for_event` blocks until one of those arrives instead of screenshotting in
a loop to discover that nothing has.

The part worth understanding is where the socket lives. A model takes turns; it
is not sitting in a loop reading a stream, and between two of its turns there is
nobody here to read one. So **this server holds the connection**, one per
computer, opened the first time a tool asks about it and kept across turns. What
arrives while the model is doing something else is buffered, and the next
`wait_for_event` or `poll_events` is handed it in order. The model holds a
cursor and never learns that a socket exists.

Three consequences, and they are the whole of the design:

- **A wait that times out has missed nothing.** The stream stayed open while the
  tool call was not running. That is why the timeout is capped at 55 seconds
  rather than the fifteen minutes `wait_for_computer` allows — a short wait
  costs nothing, because calling again picks up exactly where it left off. A
  timeout is a normal answer here, not an error.
- **An event that already happened still ends a wait.** `computer.ready` fires
  once per desktop session, so a machine that has been up for an hour will never
  send it again; attach to one and you are handed a `computer.ready` marked
  `synthesized` rather than waiting forever for an event that cannot arrive.
- **A hole in the history is answered, not forwarded.** When the platform cannot
  replay from where this server had got to, the events that survived come back
  with a count of what did not **and** with the state the missing ones would
  have reported — the window listing and the computer's own record. The `gap`
  frame itself never reaches the model, because a model handed one would invent
  a recovery procedure.

**A file being written is an event, once you ask for one.** `file.changed` is
the one thing on this stream nobody is sent unasked: a directory has to be
nominated on the connection, and without one the platform sends no file events
at all. `wait_for_file_change` is that nomination and the wait in one call —
give it an absolute directory in the guest and it blocks until something under
it is created, modified or deleted. Use it for a build writing its output, a
download landing, a script producing a file; the alternative is running `ls` in
a loop, which is the file-shaped version of the screenshot loop.

Three things about it are worth knowing before you use it, because each is a way
to read an answer wrongly:

- **A nomination is not a watch.** The guest has to be asked, and on a computer
  nobody has opened a terminal on the watcher is installed into the guest first
  — seconds, not milliseconds. inotify reports changes and not state, so nothing
  that happens before a tree is armed is ever reported. This tool never returns
  "nothing changed" from inside that window: until the tree is genuinely being
  watched it says so, in as many words, and tells you to call again.
- **`lost` is not an error.** A tree that changes faster than the stream reports
  it comes back as one marker rather than thousands of events — which is what
  makes a watch under a build usable at all. The watch is still on and the tree
  is still being watched; what you have lost is your picture of it, so list the
  directory and carry on. The one exception is `unwatchable`, which means the
  tree is not being watched: the path is not there yet, is not a directory,
  cannot be read, or is a symlink, and symlinks are refused rather than followed.
- **Nominate the narrowest tree you care about.** A home directory under a build
  is thousands of changes a second, and what you get for it is a flood marker
  rather than the changes. Your session holds four trees at once per computer —
  a fifth evicts the one you asked about longest ago, and you are told which one
  went — while the computer itself watches at most 32 across every client
  connected to it. A nomination past that limit is refused where a websocket
  client is told nothing at all, so this server works it out by elimination: it
  drops the tree, the rest of the stream comes back, and it says which of the
  two it was. Adding a watch can never cost you the window and process events
  you already had.

Not everything else is an event, though. A click landing and a page painting are
not, and no amount of waiting will produce one — `screenshot`, `list_windows`
and `exec_poll` are still the answers there. `wait_for_event` refuses at once,
naming what the computer *can* emit, when asked for something this guest will
never produce.

**The guest half is not one capability.** A Windows guest has no event stream at
all. A Linux one whose hardware carries no terminal channel produces nothing the
guest reports about itself. But `file.changed` runs against libc's own inotify
calls and needs only that channel, while `window.*`, the clipboard and readiness
also need the X bindings their desktop watcher is written against — so an older
Linux image reports every file change and no window event whatever, and a host
old enough to predate file watches reports the reverse. The refusals name which
shape it is, because the three want different things done about them: a stop and
a start gets a channel, nothing gets an image its bindings, and a host that
predates the feature is not something a caller can act on at all.

**`running` does not mean ready.** A computer reports running when the
hypervisor has started the VM; the desktop inside comes up seconds later.
`wait_for_computer(until="guest")` waits for the software to answer, which is
what `exec`, files and a painted screen actually need.

**A resize can be refused with an offer rather than a no.** Growing a computer
past what the host it is on can run comes back as a refusal that says another
host in the region could run it. That one does not clear by waiting — retrying
the same resize gets the same answer for as long as the computer is on that
host. `move_computer` is how you take the offer up: it moves the machine to
different hardware, copying its disk to get there, and applies the size on
arrival. Tell whoever you are working for what it costs before you call it, and
read `list_moves` if the wait runs out. A move that ends `moved` rather than
`done` is the one to read carefully — the computer **is** on another host, at
its old size, and an ordinary `update_computer` finishes the job.

**A webhook is the same events, delivered to somebody who is not here.**
`wait_for_event` is for the model, which takes turns and can afford to ask.
A CI job or a queue worker cannot, and `create_webhook` is how it gets woken
instead: an HTTPS endpoint the platform POSTs each event to, byte for byte the
object the socket frames, signed with the three Standard Webhooks headers. The
secret that signs them is in the create answer **once** and never readable
again, which is why the first line of that answer says so; `rotate_webhook_secret`
is the only way to another. This server only sets webhooks up and reads how
they are doing — it does not receive them and has no `verify`, because a
server with no endpoint has nothing to verify. `list_webhook_deliveries` is
where a delivery that ran out of retries shows up; nothing is dropped silently.

**A schedule says when, not how long.** `snapshot_schedule` sets the window a
computer's automatic snapshot is taken in; `get_retention` is what says how many
of them survive, and it takes no computer because the window belongs to the
account. Only automatic snapshots are ever aged out, so taking one with
`create_snapshot` is how a model keeps something past it.

**A usage total that is short does not look short.** `get_usage` answers what
the account has spent — the read to make before and after a batch of computers,
and the one to make when somebody asks what anything cost. Every figure in it is
a sum across the hypervisors the account's computers are on, so a host that could
not be reached does not leave a gap: it leaves a total that is quietly too small.
The answer says so in its FIRST line when that has happened, ahead of the
numbers, because a caveat under a figure is a caveat that has already been acted
on. Two kinds, and only one of them clears by retrying.

One window at a time, at most 62 days of it, reaching back 399 — every
hypervisor replays its ledger a day at a time to answer, so an older period is
read by naming both `from` and `to` rather than by widening one of them. `to` on
its own is measured from the current billing period and is refused.

**`exec` runs as root with no display.** A GUI application started without
`desktop: true` cannot draw. `open_url` is the reliable way to put a web page on
the screen — and it returns before the browser paints, sometimes by ten seconds.

**A variable belongs in `env`, not in front of the command.** `exec` takes an
`env` object, and `FOO=bar cmd` is a different thing: it is shell syntax, so a
value with a space or a quote in it is yours to quote and is silently cut in
half when you get it wrong. It also puts the value in the guest's `ps` for
anyone logged into the machine, and a background command's command line comes
back inside every `exec_poll` answer.

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

**The clipboard is two tools, not a shell recipe.** `read_clipboard` and
`write_clipboard` reach the desktop's `CLIPBOARD` selection — what Ctrl-C writes
and Ctrl-V pastes — on Linux computers whose desktop image includes `xclip`.
An older or custom image without `xclip` gets a permanent 400 from both tools;
changing the computer's runtime state or retrying cannot fix that image dependency.
Pair `write_clipboard` with `press_key` and `keys: ["ctrl","v"]` — two key
names, not the string `"ctrl+v"` — to get the text into whatever has focus. Do not reach for `xclip` through `exec` instead:
`exec` runs a login shell, so the guest user's profile prints onto the same
output your command does and corrupts a read you are trying to parse, and a
write that way needs a resident holder, a redirect, base64 and a polling loop.
The write here is confirmed by the platform reading the selection back before it
answers. 64 KiB in, 128 KiB out, and the read is refused rather than truncated
past its cap. `write_clipboard` resumes a suspended computer; `read_clipboard`
does not.

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

**A short list is refused, not silently served.** `list_computers`,
`list_snapshots` and `list_builds` fan out across hypervisors, and if one cannot
be reached the platform answers 503 rather than a list that is quietly missing
things. `allow_partial: true` accepts the incomplete answer instead — and when
it does, the result opens with an `INCOMPLETE:` line saying so, because a short
list reads exactly like the missing things were deleted.

`list_builds` is the one where that line is always all you get. The platform
keeps no record of which hypervisor ran which build, so a short build listing
simply has fewer rows, an unknown number missing and nothing marking the gap.

The other two append a row marked `unreachable` for each thing they could not
reach — but only for a key that spans the account. A WORKSPACE-SCOPED key gets
no marked rows either, because naming the missing ids would mean reading them
out of a placement cache that has no workspace column, and handing a confined
credential ids from the workspaces it is confined away from. For such a key all
three listings are the `INCOMPLETE:` line and nothing else, which is why that
line is written first and in prose.

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

**Retiring a template cannot be undone, and takes more than it looks.**
`retire_template` without a `version` retires **every** version of the name —
that is what retiring a template means, and it is deliberately not
`get_template`'s "the newest". A retired ref is then refused for ever, identical
bytes included, so the version you retire can never be published again. What it
does *not* touch is any computer: a computer is built from the image the ref
resolved to and holds no reference to the document, so anything already running,
stopped or suspended keeps working. The tool says all of this in its own
description, carries `destructiveHint`, and requires `confirm: true` — the same
gate `delete_computer`, `restore_snapshot` and `delete_snapshot` take. It is
strictly less recoverable than any of them: a deleted snapshot's name can be
used again, a retired ref never can.

An empty `version` is refused here rather than sent. That spelling — which a
model is more likely than a program to produce for an optional argument — read as
"no version was named" on the platform and retired an entire template. The
platform answers `400` for it now; this server will not send one at all.

**A build is minutes, and `watch_build` is how you follow one.** `build_template`
returns immediately with a job; watching it streams the platform's own progress,
emitting both a progress notification and a log line for each step, so a long
build is visibly alive rather than indistinguishable from a hang.

**Set `resetTimeoutOnProgress` if you intend to watch a real build.** The MCP
default request timeout is 60 seconds and only a progress notification can reset
it — but the SDK resets it only for a caller that passed that option, so a client
which merely accepts progress is still cancelled a minute into a fifteen-minute
build. `get_build` is the answer for a client that cannot hold a request open:
it reads once and returns. A build that *failed* is a normal answer from
`watch_build`, not an error — it names the step that stopped it, which is the
thing to fix. An `error` event is the *stream* failing and says nothing about the
build, and the tool says so rather than letting a model rewrite a document that
is fine.

What you build is **not launchable yet**: the fleet does not advertise a family
it built rather than shipped, so a create naming such a ref is still refused.
`publish_template` says the same thing where it matters — publishing and being
launchable are different questions, and its result no longer ends on a flat
"launch it with `create_computer`" that a document declaring `spec.build` would
have led straight into a refusal on.

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
check:surface — the mirror matches the platform (56 routes, 89 parameters, from /Users/…/mandala-computer).
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
