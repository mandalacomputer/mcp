# mandala-computer-mcp

An [MCP](https://modelcontextprotocol.io) server for
[Mandala Computer](https://mandala.computer) — cloud desktops for AI agents.

Point Claude Code, Claude Desktop, or anything else that speaks MCP at a real
Linux desktop it can **see and drive**. Screenshots come back as images, so the
model looks at the screen and clicks what it sees.

> **Status: alpha.** The tool surface is settling; expect breaking changes
> before 1.0. Tracks the platform's `/api/v1`, which is itself still moving.

## Install

MCP requires Node 20.3 or newer. The **TypeScript CLI** login setup requires
Node 22 or newer (`mandala-computer` on npm). Sign in once, then add the MCP
server:

```sh
npm install -g mandala-computer
mandala login
claude mcp add mandala -- npx -y mandala-computer-mcp
```

On Node 20, MCP can use an existing saved profile or an environment key.
The TypeScript CLI guides you through browser approval and saves an API key in
`~/.mandala/credentials.json`. MCP only reads that file; it never issues or
approves a device, writes credentials, or starts login automatically. The
Python distribution also provides a `mandala` command; use the TypeScript
CLI for `login`.

To select a separate profile and workspace:

```sh
mandala login --profile Work --workspace Research
claude mcp add mandala -- npx -y mandala-computer-mcp --profile Work
```

`--profile` takes precedence over `MANDALA_PROFILE`, then the saved default.
Names are case-sensitive. An explicit key or nonempty `MANDALA_API_KEY` takes
precedence over every profile and avoids accessing the credential store.
Empty explicit keys fail; an empty or whitespace-only environment key is absent.
You can still use a key from **Settings → API keys** with `MANDALA_API_KEY`.

Saved credentials require POSIX protection: a real directory owned by you with
mode `0700`, and an owned regular file with mode `0600` and one link. Symlinks,
hardlinks, unsafe permissions, malformed files and unsupported protection are
refused before any API request. Windows file loading is unsupported; explicit
or environment keys remain available. Only your home directory's store is read.

A saved profile also binds its API base URL. `--base-url` or `MANDALA_BASE_URL`
must match that stored base after canonicalization, including the entire path
prefix and port. An explicitly empty base flag is invalid with saved credentials.
Each stdio session resolves once: restart to pick up another saved key. Revoking
the key in **Settings → API keys** makes later calls fail; MCP does not switch
profiles, reread the file, or retry a refused action. Run login explicitly when
new credentials are needed.

**Claude Code** — as a plugin, which installs the server and a skill together:

```sh
# Run mandala login first, or export MANDALA_API_KEY in this shell.
/plugin marketplace add mandalacomputer/mcp
/plugin install mandala-computer@mandala
```

The skill — [`plugin/skills/mandala-computer/SKILL.md`](plugin/skills/mandala-computer/SKILL.md)
— is the part the tools cannot say for themselves: when a cloud desktop is the
right answer at all, that it costs money until it is suspended or stopped, that
`run_agent` is usually the right level and a screenshot per click is not, and
which refusals are worth a second try. It is a description of *when and how*,
not a second client; once the server is installed it stays out of the way.
`MANDALA_MODEL_KEY`, if exported alongside, is passed through and turns on
`run_agent` when the configured filters permit it.

To use an environment key instead of a saved profile:

```sh
claude mcp add mandala -e MANDALA_API_KEY=com_… -- npx -y mandala-computer-mcp
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mandala": {
      "command": "npx",
      "args": ["-y", "mandala-computer-mcp"]
    }
  }
}
```

**Cursor, Windsurf and the rest** take the same three fields — `command`,
`args`, `env` — in whichever file they keep their MCP servers in.

Your MCP client starts this as a subprocess. It uses the saved profile’s API
base, or `https://app.mandala.computer/api/v1` by default with an environment key.
Programmatic local hosts can call `runStdio({ profile: 'Work' })`; the exported
`StdioConfig` allows a local key or profile. `createServer` still requires an
explicit API key, and `HttpConfig` has no local credential options.

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

`create_computer(size="large")` is the fast path: the named shapes from
`list_sizes` are the ones the platform keeps pre-booted, so one of those is
usually answered in about a second where a custom `cpu`/`ram_mb`/`disk_gb`
shape boots cold. A `size` sets the template and the numbers together, so send
it alone or the explicit fields alone.

`use_computer` binds a machine to the session, so every later call can leave
`computer_id` out. Pass `computer_id` explicitly on any call to override it
without changing the binding, which is how you drive two machines at once.

Set `MANDALA_COMPUTER_ID` to bind one at startup and skip `use_computer`
entirely.

## The tools

This is the unfiltered inventory. The filters below can withhold tools from
both listing and calling; workflows in this README apply only when the needed
tools are available. The offline fixture checks exercised operation coverage;
verification against the live publication is a separate required CI gate.
Parameter and response-mode support remains a separate contract.

**Choosing a machine** — `list_templates`, `list_sizes`, `list_computers`, `get_computer`,
`use_computer`, `wait_for_computer`, `get_desktop_url`

**Lifecycle** — `create_computer`, `start_computer`, `stop_computer`,
`suspend_computer`, `restart_computer`, `update_computer`, `clone_computer`,
`delete_computer`, `move_computer`, `list_moves`

**Driving the desktop** — `screenshot`, `click`, `type_text`, `press_key`,
`scroll`, `drag`, `move_mouse`, `mouse_button`, `cursor_position`, `wait`

**Inside the guest** — `exec`, `exec_poll`, `exec_kill`, `get_execution`,
`read_execution_output`, `open_url`,
`list_windows`, `window_action`, `read_clipboard`, `write_clipboard`,
`read_file`, `write_file`, `list_directory`

`write_file` replaces a file already at the path. With `overwrite: false` it
creates the file only if nothing is there, and a path that is taken is refused
without that attempt writing anything (Linux computers only). Incomplete
contents are never published at the path, but a failure while publishing or
answering can leave the complete file there, so after any error read the path
before retrying or overwriting. `read_file` and `write_file` take `no_wake: true`
to refuse (409) rather than resume a computer that is not running. For
embedders, the `Api` raises that refusal as `FileExistsError`, and a
create-only 409 whose reason could not be read as `CreateOnlyConflictError`,
which says nothing about the path; `isTransient` is false for both.

**Retained versions** — `retain_execution_output`, `get_result`, `read_result_output`,
`delete_result`, `publish_artifact`, `get_artifact`, `read_artifact`, `delete_artifact`

**Passive metadata** — `list_activities`, `get_activity`, `get_activity_results`, `read_signals`

**Being told rather than asking** — `wait_for_event`, `poll_events`,
`wait_for_file_change`

**Snapshots** — `list_snapshots`, `snapshot_holdings`, `create_snapshot`,
`restore_snapshot`, `clone_snapshot`, `snapshot_schedule`, `get_retention`,
`delete_snapshot`

**Your own templates** — `get_template_schema`, `check_template`,
`publish_template`, `get_template`, `retire_template`

**Building one** — `build_template`, `list_builds`, `get_build`, `watch_build`

**Account quota** — `get_account`

**Who you are** — `whoami`, `list_api_keys`. Minting and revoking API keys are
deliberately not tools — see [Who you are, and API keys](#who-you-are-and-api-keys).

**Spending** — `get_usage`

**Being told somewhere else** — `list_webhooks`, `create_webhook`,
`get_webhook`, `update_webhook`, `rotate_webhook_secret`, `test_webhook`,
`list_webhook_deliveries`, `delete_webhook`

**SSH access** — `list_ssh_keys`, `add_ssh_key`, `remove_ssh_key`,
`get_computer_ssh`, `set_computer_ssh`. Keys belong to the person the API key
was issued to, not to the account, and are accepted by every computer with SSH
on, on every account where that person is an owner or member. A
workspace-scoped key can read keys but not add or remove them.

**Secrets** — `list_secrets`, `get_secret`, `create_secret`, `set_secret`,
`replace_secret`, `delete_secret` for the account's secret store, and
`get_computer_secrets`, `set_computer_secrets` and `create_computer`'s `secrets`
for which of them a computer receives. A value goes in through `create_secret`,
`set_secret` (create the name, or replace its value if the scope holds it —
names match ignoring ASCII case) or `replace_secret`, and never comes back out. No route answers one, and a store tool's result
holds only the decoded documented fields (success) or the status, the `reason`
word and a sentence of its own (refusal). It never includes the platform's
response text, and the `Api` keeps none for these routes. The bindings carry
only secret ids, revisions and names. A computer receives a secret as an environment variable (`env`) or as a
file under `/run/mandala-secrets/user/files` (`file`). A set replaces the whole
binding list (`[]` removes every binding) and reaches the guest at the
computer's next start or restart; send the `version` a read answered to have it
refused with 409 if the list changed since. A replaced value also reaches a
running computer: a file binding's file is rewritten in place, and on an image
that supports it an env binding reaches new shells and `exec` with
`desktop: true` (programs already running keep the old value until a restart).
A command that needs a bound variable should use `desktop: true`. Whether a
plain root `exec` sees it depends on the platform version. `replace_secret`
and `delete_secret` need the current `revision_id`, and a stale one is a 409.
`delete_secret` also needs `confirm: true`: a computer still bound to a deleted
secret cannot start again until that binding is removed. A bound computer runs,
and its guest answers, a few seconds before its secrets land, so
`wait_for_computer(until="guest")` on one also waits until they have;
`get_computer` shows the gap as "its secrets are still on their way in".

**Delegating** — `run_agent`, `run_agent_chat`, registered only when a model key is present:
`MANDALA_MODEL_KEY` on stdio, or the caller's own `X-Model-Key` header over HTTP.
Both must also survive the configured filters.

### Tool filters

Set `MANDALA_READ_ONLY=1` to register only tools whose existing
`annotations.readOnlyHint` is exactly `true`. It accepts `1`, `true`, `yes`,
`on` for on and `0`, `false`, `no`, `off`, empty or unset for off, ignoring
surrounding whitespace and letter case. Any other value fails at startup.
Safety is not inferred from a tool's name or HTTP method: `read_file` and
`cursor_position` can wake and bill a computer, so they are withheld. So are
mixed read/write tools such as `wait_for_computer` and `snapshot_schedule`.
`screenshot`, `read_clipboard` and `list_windows` retain their read-only hints.

Set `MANDALA_TAGS=input,guest` to select a union of named tool groups. Names
are **lowercase only**, comma-separated, trimmed and deduplicated. Empty or
unset means no tag filter; empty comma-separated entries are ignored. An
unknown nonempty tag fails before stdio connects or HTTP starts listening,
with an error listing all valid tags.

| Tag | Tools |
| --- | --- |
| `account` | `get_account`, `whoami`, `list_api_keys` |
| `computers` | `list_computers`, `get_computer`, `use_computer`, `wait_for_computer`, `get_desktop_url`, `list_sizes` |
| `lifecycle` | `create_computer`, `start_computer`, `stop_computer`, `suspend_computer`, `restart_computer`, `update_computer`, `clone_computer`, `delete_computer`, `move_computer`, `list_moves` |
| `input` | `screenshot`, `click`, `type_text`, `press_key`, `scroll`, `drag`, `move_mouse`, `mouse_button`, `cursor_position`, `wait` |
| `guest` | `exec`, `exec_poll`, `exec_kill`, `open_url`, `list_windows`, `window_action`, `read_clipboard`, `write_clipboard` |
| `files` | `list_directory`, `read_file`, `write_file`, `wait_for_file_change` |
| `executions` | `get_execution`, `read_execution_output` |
| `results` | `get_activity_results`, `retain_execution_output`, `get_result`, `read_result_output`, `delete_result` |
| `artifacts` | `publish_artifact`, `get_artifact`, `read_artifact`, `delete_artifact` |
| `snapshots` | All snapshot tools listed above, including `get_retention` |
| `templates` | `list_templates`, all your-own-template tools and all build tools listed above |
| `events` | `wait_for_event`, `poll_events`, `wait_for_file_change` |
| `usage` | `get_usage` |
| `webhooks` | All webhook tools listed above |
| `ssh` | All SSH tools listed above |
| `secrets` | `list_secrets`, `get_secret`, `create_secret`, `set_secret`, `replace_secret`, `delete_secret`, `get_computer_secrets`, `set_computer_secrets` |
| `agent` | `run_agent`, `run_agent_chat` |
| `activities` | `list_activities`, `get_activity`, `get_activity_results` |
| `signals` | `read_signals` |

The selected tags form a union, then intersect with read-only and the existing
lifecycle and model-key restrictions. `MANDALA_NO_LIFECYCLE=1` still withholds
its five tools even when their tags are selected; selecting `agent` cannot
enable either agent tool without a per-session model key. Both agent tools are
withheld by read-only, but remain available with lifecycle disabled alone.
`MANDALA_TAGS=files MANDALA_READ_ONLY=1` exposes only `list_directory`.
An `agent` selection with read-only is a valid empty tool list.
`activities,results` includes `get_activity_results` once; `signals` is separate
from the active `events` socket. Filters never grant API privileges: the API
checks current member/owner and workspace authorization on every request.

`use_computer` is not read-only. When it is withheld, pass `computer_id`
explicitly, or bind a computer with `MANDALA_COMPUTER_ID` at stdio startup.
HTTP callers must supply their own computer selection. These variables apply
to both transports and the plugin forwards them. Embedders can pass
`readOnly: true` and `tags: ['input', 'guest']` in `ServerConfig`; the server
does not read the environment itself.

### Who you are, and API keys

`whoami` takes no arguments and reads `GET /api/v1/whoami`: the person this
server's API key was issued to, the account and role it acts with (the role as
it is now), the workspace it is confined to, and the key itself — including
`manage_keys`, whether it may manage API keys. It needs no permission and any
role, and a suspended account can call it; the answer says so when the account
is suspended. Behind the hosted server's OAuth sign-in, the key is the Connected
app's (`prefix` `oauth`).

`list_api_keys` lists the key holder's API keys on the account, newest first —
never a raw key. It needs this server's key to have the **Manage keys**
permission, which only a person can turn on, in the dashboard; without it the
tool answers the platform's 403, whose sentence says exactly that. A Connected
app's key never has the permission.

**Minting and revoking keys are not offered here, on purpose.** A mint answers
the new key in full, once, and a model's context — the conversation, the
client's logs, whatever the transcript is shared with — is the worst place for a
long-lived credential and one nobody can take it back from. A revoke is
irreversible, and on a model's reading of a list it can cut off the person's CI,
another agent, or this very session. People do both from the dashboard or with
the `mandala api-keys` CLI.

### Current account quota

`get_account` takes no arguments and reads `GET /api/v1/account` once with the
caller's account credential. Viewer or stronger access is required. It reports
account-wide aggregates, including for a workspace-scoped key, without resource
identities. It needs no selected computer or model key, opens no event stream,
and remains available with read-only and no-lifecycle filters. Select the
`account` tag to expose it on its own.

The report includes the effective plan, pool ceilings, per-computer maxima,
Windows capability, current consumption and remaining quota. Configured CPU and
disk include kept computers regardless of power state; running or reserved RAM
includes current reservations. CPU, MB, GB and snapshot bytes retain the API's
units. `get_usage` separately reports historical metered consumption over time.

Quota is **advisory**: `observed_at` is an observation time, not a reservation or
consistency token. Later create, resize, start or snapshot requests can still be
refused, and existing 402 messages remain unchanged. Snapshot headroom is against
**indexed stored bytes**; it does not include in-flight capture reservations and
does not establish that a new capture will fit.

`complete.computers` and `complete.snapshots` are independent. An incomplete group
has `null` for all its consumption and remaining figures, meaning **unknown**,
while the other group can retain numeric values. Complete zero usage and zero
remaining quota remain numeric zeros. Verified plan ceilings remain available in
a partial report, including a no-plan account that still has retained usage.
Malformed reports and HTTP failures remain errors, never an empty account.
The tool prints unknown and advisory guidance before the projected public fields.

## Things worth knowing

**Every computer is a Linux desktop today.** Windows guests are not offered on any
plan; where this README mentions Windows it is describing behaviour the client
already supports for when they are.

**A running computer costs money, and a forgotten one keeps costing it.**
`create_computer` says so in its own description, and so does everything that
starts a machine by a side door — `restore_snapshot` boots a stopped computer,
and `write_clipboard`, `read_file` and `cursor_position` each resume a suspended
one, because each has to reach the guest agent to do its job. All of them are
charged like any other start, and on a plan at its limit can come back 402
rather than a result. The two reads are the surprising half of that list, and
are why neither is annotated `readOnlyHint`: a host that auto-approves
read-only tools would otherwise wake and bill a machine with nobody asked.
`screenshot`, `read_clipboard` and `list_windows` genuinely do not start
anything and keep the hint. When a stretch of work is over, `suspend_computer` (a pause:
`start_computer` brings the same session back in about a second) or
`stop_computer` (a shutdown: the disk is kept, the session is not). Idle
suspend catches the ones a model forgets, but only after 30 minutes untouched.
`get_usage` is what says what any of it cost.

**Ten clicks need not be ten screenshots.** Driving the desktop one tool at a
time — `screenshot`, `click`, `screenshot` — puts an image in the calling
model's context for every step. `run_agent` hands a task in plain language to
the platform's own loop instead, which screenshots, decides and clicks inside
the platform and answers with a sentence and the list of what it did. It is
registered only when a model key is present (see [Configuration](#configuration))
and bills that key for the run. `max_steps` bounds the WORK rather than the
bill: a step is one action on the desktop, one model reply can ask for several
and spends a step on each, a paused turn costs tokens and no step, and not every
step takes a screenshot. It defaults to 20 and is capped at 100 here.

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

**A capture outlives the request that starts it.** `POST /computers/:id/snapshots`
answers `202` with a placeholder row and copies the disk afterwards, which takes
minutes and scales with how much has been written — longer than any HTTP request
survives. So `create_snapshot` polls: it holds the id the platform allocated
before the copy, watches `list_snapshots` for that row to stop reading
`capturing`, and answers with the finished snapshot. It waits for *not
capturing* rather than for `pending`, because replication can carry a small
snapshot straight on to `durable` between two polls; and it matches on the id
rather than on the newest row for the computer, because a scheduled capture
finishing in the same window makes that wrong on exactly the long captures where
it matters. `wait: false` hands back the id instead, for a caller that would
rather poll on its own schedule.

The three answers it can end on are kept apart deliberately. A capture that
lands is the snapshot. A capture that FAILS mid-copy leaves no snapshot and no
row — the `capturing` row simply disappears, and that absence is the only signal
there is, which is why an incomplete listing is never allowed to decide it. A
wait that runs out says the capture is still running and names the id to follow,
because that one asks for a look rather than for another attempt.

**A deletion outlives its request too, and reads the other way round.**
`DELETE /snapshots/:id` answers `202` and then detaches the dependent snapshots
and removes the stored objects. There is no state that means deleted, so
`delete_snapshot` polls for the row to **go** — the mirror of a capture, which
polls for a row to stay and change. A row that stays is one that STALLED, and it
sits in `deleting`, a state a bare listing hides: the poll asks with
`include=unfinished` for exactly that reason, since without it a half-deleted
snapshot is indistinguishable from a deleted one. The platform retries a stalled
deletion itself every fifteen minutes, so the give-up sentence says to watch
rather than to repeat.

Because absence is the success signal here, "Deleted" is said only off a listing
read **whole**. A row missing because a hypervisor did not answer is not a row
that is gone, and that mistake is unrecoverable in a way the others are not:
nobody goes looking for a snapshot they have been told was destroyed. A `409`
saying the snapshot is already being deleted is progress, not a fault — the
answer is to watch that deletion finish, never to go and delete something else.

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

**Stable background reads.** When an accepted `exec` returns `execution_id`,
use `get_execution` for its last observed `running`, `exited` or `lost` state.
Only `exited` carries an `ended_at` and signed `exit_code`; `running` does not
prove the computer is awake, and `lost` establishes neither success nor failure.
Older replies can omit the ID. A malformed supplied ID leaves the accepted
command and its valid PID usable, but supplies no stable identity: do not replay
the command to obtain one. PID polls/kills never reconstruct this association.

`read_execution_output` takes that ID and **both** `stdout_offset` and
`stderr_offset` byte positions. Start each reader at zero, then pass its own
returned positions. For example:

```json
{"execution_id":"exec_0123456789abcdef0123456789abcdef","stdout_offset":0,"stderr_offset":0,"limit":4096}
```

Each stream is bounded to 4,096 bytes by default, at most 16,384. Complete
lossless UTF-8 appears as `stdout`/`stderr` with its BOM preserved. NUL, binary
and split UTF-8 chunks remain exact canonical `stdout_b64`/`stderr_b64`; nothing
is trimmed or replaced. `stdout_more` and `stderr_more` are independent, and
false means EOF at that moment, not that the command has finished.

The separate `diagnostic`/`diagnostic_b64` repeats on every read. At most 4,096
of its up-to-65,536 available bytes are displayed: inspect
`diagnostic_available_bytes`, `diagnostic_displayed_bytes`, and
`diagnostic_display_truncated`. The independent `diagnostic_truncated` flag is
the platform's capture limitation. Diagnostics never advance either cursor.
Neither new tool consumes output from another reader or the shared `exec_poll`
cursor, and both carry read-only, non-destructive, idempotent annotations.

These are single requests with cancellation, no automatic resume, retry,
watcher, capture or command replay. Metadata reads no guest files. Output reads
perform guest I/O without refreshing activity and are unsuitable for passive
Activities/history. Files are mutable guest data, not retained artifacts;
handles can vanish on restart, replacement or cleanup, and observed exits
expire after ten minutes. An unavailable read is an error, not empty output.
Every new-tool result is bounded to 256 KiB of serialized data.

**Explicit immutable retained versions.** `retain_execution_output` accepts an
`execution_id` and captures one version of its volatile output with one POST.
It performs guest I/O, without resuming or replaying the command. Its optional
`max_bytes_per_stream` defaults to 1 MiB (maximum 4 MiB); `retention_seconds`
defaults to 86400 (maximum 604800). Diagnostics are separate, up to 64 KiB.
Each capture creates a version; there is no automatic capture or retry.

`get_result` reads finite metadata by `result_id`. `read_result_output` requires
`result_id`, `stream` (`stdout`, `stderr` or `diagnostic`) and `offset`, with
`limit` defaulting to 4096 and capped at 16384 bytes. It reads one independent
page, with exact `offset`, `next_offset`, `eof` and returned `bytes` count.
Content is lossless `text` (BOM preserved) or canonical `base64` for binary,
controls and split UTF-8. EOF means the end of this retained prefix, not task
completion. A page alone does not verify the full manifest hash.
`delete_result` deletes that version once; a repeated 404 remains unavailable.

Existing synchronous `exec` accepts `retain_output: true` or a strict object
with those same two options. False or absence leaves default behavior alone.
It cannot be combined with `background: true`. A canonical returned `result_id`
confirms optional retention; no execution ID is fabricated. Missing, malformed
or unsupported optional metadata leaves the command outcome unchanged and does
not authorize replay. Retained-prefix truncation and upstream response
truncation are distinct. Synchronous results have no diagnostic stream; an
explicit diagnostic read can return 409.

**Nominated file versions.** `publish_artifact` requires an absolute `path`,
`expected_size` and `expected_sha256` supplied by the caller. For example:

```json
{"path":"/tmp/empty.txt","expected_size":0,"expected_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
```

Paths preserve legal Unicode, spaces and Linux backslashes; Windows drive and
UNC paths are also accepted, subject to the platform's current OS proof.
Publication performs one nominated guest-file capture, without a client-side
stat, list, read, hash or exec preflight. `max_bytes` defaults to 8 MiB and is at
most 64 MiB; expected size must fit. Retention has the bounds above. Optional
`execution_id` records verified **caller selection**, not proof the execution
created the file. Every publication creates an independent immutable version.

`get_artifact` reads metadata. `read_artifact` first reads that metadata and,
only if the complete size fits `max_bytes` (default 4096, maximum 16384), reads
the entire retained object and verifies its exact length and SHA-256. Over-cap
objects return metadata with a refusal before any content request; use an SDK
whole download with an adequate cap. There are no partial artifacts, Range
requests, local destinations, filenames, image/HTML previews or guest fallbacks.
Verified content uses the same lossless `text`/`base64` presentation.
`delete_artifact` deletes only that stored version, not the guest file; repeat
404s remain truthful failures.

All eight retained tools resolve the computer selection once. Reads are passive
but require current authorization and scope availability; retained bytes can be
unavailable when the host cannot verify access, after expiry or deletion, or
when storage is unavailable. They never wake a guest or substitute live output.
New operations have one 90-second budget across headers, bodies, and both
artifact requests. An MCP client can impose an earlier deadline. Cancellation,
redirects and malformed responses never trigger a retry; a lost publication
response means commitment is **unconfirmed**, not undone. Each entire serialized
retained tool result is bounded to 256 KiB. Reads are marked read-only;
capture/publication create new versions; deletes are destructive with an
idempotent deletion effect. Activities result detail remains outside this MCP
runtime.

Past about **two minutes** it does not even come back as a timeout. A proxy in
front of the platform abandons a request that has produced no response for
roughly that long and answers 524, which arrives as `GatewayTimeoutError` —
whatever `timeout_s` said, because the hop that gives up never saw it. Measured
against `app.mandala.computer`: `sleep 130` failed at 125.2s with
`timeout_s: 300` and at 125.3s with `timeout_s: 3600`. Raising `timeout_s` buys
nothing; `background: true` is the only thing that works. The abandoned command
keeps running, so the call after one of these often reports the guest agent as
busy — that is the first failure continuing, not a second one.

That roughly two-minute ceiling belongs to the hosted proxy. The server accepts
integer foreground `timeout_s` values from 1 through 600 seconds (default 30),
and the tool exposes that range for a `MANDALA_BASE_URL` reached without the
proxy. The HTTP client allows 630 seconds for response headers so the server can
report a 600-second timeout. Use `background: true` and poll the handle for
longer work.

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
out of a host cache that has no workspace column, and handing a confined
credential ids from the workspaces it is confined away from. For such a key all
three listings are the `INCOMPLETE:` line and nothing else, which is why that
line is written first and in prose.

**A computer has a lifecycle of its own, separate from what its guest is
doing.** `state` is the platform's record of whether the machine exists —
`live`, `deleting`, `deleted`, `lost`, or `unreachable` when a listing could not
confirm the row against its host — while `status` is the host's answer about the
guest. A row served from the record has the first and not the second, so
`list_computers` prints both when both are there: a computer can be running and
being deleted at once.

An unfiltered listing is `live`, `unreachable` and `deleting`. The two terminal
states are withheld from it, so `list_computers(state: 'deleted')` is the only
way a computer that has gone is ever shown — and an empty answer to a filtered
listing is a fact about the filter rather than about the account, which is what
it says rather than inviting you to create one.

**Snapshots mid-deletion are billed but hidden.** A deletion that began and did
not finish still holds objects and still counts against storage, and the default
listing leaves it out — every ordinary caller is asking "what can I restore".
`list_snapshots(include_unfinished: true)` is the flag for when the question is
about storage instead.

**A 409 usually clears; a 400 never does.** A guest still booting or a busy
guest agent answers 409. The platform's own error messages come through
unedited, because they are written to be acted on.

HTTP failures preserve their actual response status. An unsupported method on a
known path is `MethodNotAllowedError` (405), with the received `Allow` value when
available. A missing computer, snapshot, route or guest file remains
`NotFoundError` (404); other guest failures keep their own status and message.
Neither response causes an automatic retry or method switch.

`isTransient(err)` answers "is this worth sending again unchanged". A `503` is
transient only for a GET or HEAD. Any change answered `503` may or may not have
happened, because the platform answers a failure after the request was sent the
same way. So `isTransient` is false for it whatever `reason` it carries, the
tool's answer says to read the current state first, and `error.method` records
the method. A `reason` this version does not
know, such as a new word, is treated as no classification. `reasonKind` returns
`undefined` for it, and the status decides.

The secret store has typed calls on `api.secrets`: `list`, `create`, `get`,
`replace` and `delete`. Each answer is decoded strictly to the documented
fields, and none of them carries a value:

```ts
const { secrets } = await api.secrets.list();
const s = await api.secrets.create({ name: 'OPENAI_API_KEY', value: key });
await api.secrets.replace(s.id, { value: next, revisionId: s.revision_id });
```

Embedders can inspect optional diagnostics on every `APIError`:

```ts
import { Api, APIError, MethodNotAllowedError } from 'mandala-computer-mcp';

const api = new Api(process.env.MANDALA_API_KEY!);
try {
  await api.json('GET', 'account');
} catch (error) {
  if (error instanceof APIError) {
    console.error({ status: error.status, requestId: error.requestId,
      reason: error.reason, allow: error.allow,
      wwwAuthenticate: error.wwwAuthenticate });
    if (error instanceof MethodNotAllowedError) {
      // Inspect error.allow before correcting the request method.
    }
  }
}
```

`requestId` uses a nonblank `X-Request-ID` header first, then the top-level
`request_id` body field. It is an opaque diagnostic, never an idempotency key.
The raw body remains available on `error.body`, including any differing body ID
and nested chat accounting. `allow` and `wwwAuthenticate` come only from received
headers. HEAD failures can carry these fields with no body. Older servers,
intermediaries and connection failures may supply none of them. Existing
constructor arguments retain their meanings; an optional trailing
`APIErrorMetadata` object adds these three fields, and `method`.

MCP error results include supplied `reason`, `request_id`, `allow`,
`www_authenticate` and `retry_after_ms` as labelled JSON metadata. Diagnostic
strings are limited to 128, 256, 512 and 512 characters respectively; an
oversized field is omitted with a notice, so a shortened Allow is never
presented as complete. Tool-specific warnings about partial work, retained
publication, execution reads and explicit template continuation still apply.
Serialized JSON object or array prefixes are not displayed as error prose.
Valid scalar error messages retain their wording; embedders still have the
original `APIError.message` and `APIError.body` for diagnostics. Native agent
error frames retain their supplied numeric status even without a reason or
request ID, independently of the successful HTTP stream carrying them.

For a 401, `missing` means a platform credential was not supplied; `invalid`
means the supplied platform credential was not accepted; `revoked` means its
authority no longer holds. Unknown reasons stay visible. An unclassified 401
alone does not identify whether the account key or model key was refused,
including a nested chat failure. A 403 remains a permission or authority
refusal. Inspect recorded work before another run; no key fallback, login or
automatic replay is performed. Nested error reasons and in-band stream errors
do not grant permission to replay a partly completed run.

For desktop events, use the exact returned `events_url`, including its desktop
capability, in a WebSocket client. A REST Bearer key alone is not sufficient;
the HTTP events response provides JSON guidance rather than another login flow.

**Desktop links are credentials.** `get_desktop_url` returns the watch-only URL
by default — the platform drops input on that socket, so it is safe to hand to
somebody. `control: true` returns the full-control one, which is root-equivalent
on that machine. Neither appears in any other tool's output, deliberately: a
tool result lands in a model's context and from there in whatever captured it.
It is also why `get_desktop_url` carries no `readOnlyHint` even though its route
neither writes nor spends: hosts treat that hint as licence to call without
asking, so keeping it would let a model pass out control of a desktop with
nobody prompted.

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
it reads once and returns.

**The same applies to every tool here that waits.** `wait_for_computer`,
`move_computer`, `create_snapshot` and `delete_snapshot` all poll, and all report
progress on every poll — a changed line at once, an unchanged one on a ten-second
heartbeat, so the request stays open without flooding the client. A live capture
took 107 seconds and was cancelled at 60 before this existed, which turned every
carefully-worded answer about what had actually happened into a transport error.
Each of them has a way out for a client that cannot opt in: `wait: false` on the
two snapshot tools, `list_moves` after a move, a shorter `timeout_s` and a second
call on the wait. A build that *failed* is a normal answer from
`watch_build`, not an error — it names the step that stopped it, which is the
thing to fix. An `error` event is the *stream* failing and says nothing about the
build, and the tool says so rather than letting a model rewrite a document that
is fine.

A completed template build can launch with `create_computer` when eligible
capacity and its image are available. Publishing a template and completing its
build are separate steps; publication alone does not guarantee launch capacity.

When the API supports image preparation continuation, a `create_computer`
refusal with code `template_image_preparing` preserves `template_transfer` and
`preparation` (including `state` and `error`) in the JSON appended to the tool's
error text. `retry_after_ms`, when present, is the parsed `Retry-After` delay in
**milliseconds**, also available to embedders as `APIError.retryAfterMs`. Both
integer seconds and HTTP dates are accepted; missing or invalid delays are
omitted. Delays are capped at 2,147,483,647 milliseconds to fit a timer.

For `preparing`, `copying`, or `ready` with a usable token and delay, wait for
that delay, then repeat the original identical create arguments, including
`template`, adding the token exactly as returned. The token must be a nonblank
string, requires the original `template`, and cannot be combined with `size`.
A `failed` preparation reports its error for inspection before deciding what to
do next. Missing or unknown states and missing or invalid delays do not supply
automatic retry advice. The server never replays a create automatically, and
`isTransient` returns false for this refusal code because unchanged replay is
not the continuation protocol.

The token selects the image build; it is **not a create idempotency key**. Stop
after success. After a lost or ambiguous response, inspect `list_computers`
before deciding what to do; never automatically replay the create.

## Running it as a service

The same server speaks streamable HTTP, for clients that cannot spawn a
subprocess — claude.ai, mobile, a shared team endpoint:

```sh
MANDALA_ALLOWED_HOSTS=mcp.example.com npx mandala-computer-mcp --http --port 3000
```

```sh
claude mcp add --transport http mandala https://mcp.example.com/mcp \
  --header "Authorization: Bearer com_…"
```

The MCP endpoint is `/mcp`; `/healthz` answers a JSON `{ ok, name, version }`
for whatever is checking that the process is up.

**It holds no credential of its own.** Each caller's key arrives as their own
bearer token and is used only for their session; there is no store, and nothing
outlives a session but a digest of the key — kept so that a later request can be
shown to come from the same holder, which means a leaked session id on its own
is not enough to drive somebody else's desktop. HTTP startup and requests never
read the operator's credential store, `MANDALA_API_KEY` or `MANDALA_PROFILE`.
`--profile` is local-only and ignored with `--http`.

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

### Hosted, with OAuth

The endpoint at `https://app.mandala.computer/mcp` is this server run with
`--http` behind the platform's own proxy, with the platform as its OAuth 2.1
authorization server. Nobody pastes a key:

```sh
claude mcp add --transport http mandala https://app.mandala.computer/mcp
```

Two variables make an HTTP server behave that way, and without them nothing
changes — self-hosters keep bringing API keys:

```sh
MANDALA_MCP_RESOURCE_METADATA_URL=https://app.mandala.computer/.well-known/oauth-protected-resource/mcp \
MANDALA_MCP_SERVICE_SECRET=… \
MANDALA_ALLOWED_HOSTS=app.mandala.computer \
  npx mandala-computer-mcp --http --host 127.0.0.1 --port 3000
```

In this mode `X-Forwarded-For` is believed from a loopback peer only, so the
proxy in front must be on the same machine and must set it to the real client
address.

- **Every `/mcp` request needs a bearer**, initialize and `tools/list`
  included. One without is answered `401` with exactly
  `WWW-Authenticate: Bearer resource_metadata="<that URL>", scope="mcp:tools"`,
  which is how a client finds where to authorize. `/healthz` stays open.
- **The bearer is passed through unchanged** — an `mcpat_…` access token, or an
  API key, which the platform still accepts. The access token is good for this
  endpoint only. It is not an API key: sent to the API directly, the platform
  refuses it with `401` (`reason: "invalid"`). A person revokes it under
  Settings → Connected apps.
- **A bearer is checked with the platform before it gets anything.** An
  initialize makes no session until the platform accepts its token — a `2xx`
  from `GET ssh-keys`, which every valid credential gets — so invented tokens
  cannot fill the session pool. A `401` is the challenge above; any other
  answer is `503` and nothing is remembered. Refused initializes are budgeted
  per source address, 20 a minute. Past that, a token already accepted still
  passes and a new one is still checked, but only one every 5 s per address;
  the rest get `429` with `Retry-After`. The budget comes back when its minute
  is up. A POST
  carrying a request is checked again before it is dispatched, with an
  acceptance cached for 60 s under the token's digest, so an expired or
  revoked token is a clean `401` before any stream opens.
- **A token the platform refuses during a call comes back as that same
  `401`**, not as a tool error, so the client refreshes or authorizes again —
  the answer is held until its first byte for this. The one case that cannot
  work: a token that dies mid-call AFTER the stream has committed (the SDK's
  15 s keep-alive, a progress notification or a partial result). That call
  ends as a tool error, the session remembers the refusal, and the next
  request on that token gets the `401` without reaching the platform.
- **A refreshed token starts a new session.** A session is bound to the digest
  of the bearer that opened it, and a different bearer on it is answered
  `404 Unknown session`, the MCP spec's signal to initialize again. An access
  token says nothing this server can check about which grant it came from, so
  rebinding would let any valid credential that learned a session id take over
  its bound computer, buffered events and retained results.
- `X-Mandala-MCP-Service` carries `MANDALA_MCP_SERVICE_SECRET` on every
  platform request, only ever to `MANDALA_BASE_URL`, so a token cannot be
  replayed at the API directly by the app it was issued to. A client's own
  header of that name is never forwarded.

### Configuration

| Variable | Meaning |
| --- | --- |
| `MANDALA_API_KEY` | Optional local API key, taking precedence over saved credentials. Ignored by HTTP; each caller sends their own bearer token. |
| `MANDALA_PROFILE` | Local saved profile; `--profile` overrides it. Otherwise the file default is selected. Ignored by HTTP. |
| `MANDALA_BASE_URL` | With a saved profile, must match its stored base. Otherwise defaults to `https://app.mandala.computer/api/v1`. |
| `MANDALA_COMPUTER_ID` | Bind a computer at startup, so `use_computer` is not needed. **stdio only** — under `--http` it is ignored rather than bound into every caller's session, since it names a machine on the operator's account. |
| `MANDALA_MODEL_KEY` | An Anthropic key. Enables `run_agent` and `run_agent_chat` when filters permit them, which runs the platform's own loop on that key. **stdio only** — under `--http` each caller sends their own as `X-Model-Key`, and this variable is ignored. |
| `MANDALA_NO_LIFECYCLE` | `1`, `true`, `yes` or `on` withholds `create_computer`, `clone_computer`, `clone_snapshot`, `delete_computer` and `delete_snapshot` — every tool that makes a computer or destroys one. `0`, `false`, `no`, `off` or unset leaves them registered. Any other value is **refused at startup** rather than read as off: a typo here would otherwise leave those tools in place on a server whose operator believes they are gone. The `--no-lifecycle` flag reads the same vocabulary and refuses the same way, except that it has no spelling for *unset*: `--no-lifecycle=` is refused rather than ignored, so a launcher template whose variable did not expand stops instead of quietly leaving the tools registered. |
| `PORT`, `HOST` | For `--http`. Default `3000`, `127.0.0.1`. |
| `MANDALA_READ_ONLY` | Keep only tools annotated `readOnlyHint: true`; strict boolean parsing as described under Tool filters. |
| `MANDALA_TAGS` | Comma-separated lowercase tool tags; see Tool filters for the inventory and intersection rules. |
| `MANDALA_ALLOWED_HOSTS`, `MANDALA_ALLOWED_ORIGINS` | Comma-separated. Which `Host` and `Origin` values this server answers to. On a loopback bind the host list defaults to the address it was given, so DNS-rebinding protection is on without configuration; set this when serving under a name. |
| `MANDALA_MCP_RESOURCE_METADATA_URL` | `--http` only. The OAuth protected-resource metadata URL this server is published under. Set, it answers OAuth clients as described under Hosted, with OAuth; unset, callers bring an API key. |
| `MANDALA_MCP_SERVICE_SECRET` | `--http` only. Sent as `X-Mandala-MCP-Service` on every platform request, to `MANDALA_BASE_URL` only. Never logged. |

Every one of these but the model key, the two tool filters and the two OAuth settings has a flag as well, and a flag overrides
the environment: `--http`, `--port`, `--host`, `--base-url`, `--computer`,
`--allowed-hosts`, `--allowed-origins`, `--no-lifecycle`, local `--profile`, plus `--help` and
`--version`. `--key` exists for a caller launching several servers under
different keys, and warns when used, because an argument vector is readable by
`ps`, lands in shell history and is recorded verbatim by any exec audit —
none of which is true of `MANDALA_API_KEY`.

`run_agent` deserves a note. It hands a task to the platform's own agent loop,
which drives the computer inside the platform and answers with a sentence. Worth
it when a stretch of pixel work would otherwise cost the calling model a
screenshot per step — ten clicks stop being ten images. It bills your Anthropic
key, and the platform never stores that key.

### Passive directories, activity history and signals

`list_directory` takes an exact absolute guest `path`. Unicode, spaces and
punctuation survive query encoding. It requires an already running computer,
does not resume it or extend its idle timer, and still contacts the guest with
ordinary rate/capacity admission. The result preserves `path`, `entries` with
`name`, `type` and optional `size_bytes`, `truncated` and `skipped`. An unavailable
entry has no inferred type or zero size. Symlinks are not followed, and a final
symlink directory is refused. No file content is read. A partial listing is an
unordered subset: at most 512 examined entries/128 KiB, with no continuation
token. Narrow the path when names are omitted; do not automatically rescan.

`list_activities` returns one newest-first history page with a fixed watermark.
Pass an opaque `cursor` for continuation, or `changes:true` with a cursor for
late final updates to older rows. False/absent `changes` is omitted on the wire;
there is no `limit` argument. Preserve `next_cursor`, `changes_cursor`, `gap`
and health fields. A gap requires refreshing history. The tools keep no cursor
cache and never drain pages automatically. `get_activity` takes an `activity_id`
shaped as `act_` plus 32 lowercase hex digits, a request identity rather than an
idempotency key. Recorded state, scope, revision, timestamps, execution identity
and status remain distinct: accepted background work is not finished execution,
and a dispatched error may have had effects. History is selected, retained,
best-effort metadata, not all guest work or an agent identity.

`get_activity_results` returns at most eight newest metadata links, preserving
revision, availability, association, byte/truncation metadata and observations.
`more:true` has no continuation cursor and does not mean all versions were
returned. An unavailable item is not an empty available item. Caller-selected
artifact association does not prove creation or command success. This tool
never follows a link to content, files, captures, downloads or execution polling.

`read_signals` reads one passive daemon page, independently of the active event
socket. Omit `since` or send an empty string for a head-only baseline with no
replay. Optional `limit` is 1–100; omitting it uses the API default 50. Preserve
the returned `cursor` even when `events` is empty: filtered-out rows may advance
it. Retention is ephemeral; expired/restarted/migrated cursors can return an
explicit reset gap. Baselines and gaps do not prove there was no earlier work
or that a task succeeded. Unsupported (501) and unavailable (503) responses
remain errors, never empty history or new checkpoints. There is no watcher,
guest action, retry loop or automatic checkpoint cache in this tool.

### JSON chat with your own Anthropic key

`run_agent_chat` drives the selected computer using the same BYOK Anthropic loop
as `run_agent`. It accepts a nonempty array of textual OpenAI-shaped `messages`,
including string content or arrays of `{type:"text",text:"..."}` parts. The
**last user message** supplies the task; system messages supply standing
instructions. Earlier user/assistant conversation is not replayed. Optional
`model` is sent unchanged and must name an Anthropic model. `max_steps` is 1–100,
default 20. This is computer control, not hosted general-purpose inference or a
chat UI; it adds no key storage or model billing service.

This tool deliberately sends `stream:false` and uses the JSON response so the
result preserves the underlying `agent.stop`, step count and token usage.
Only explicit `end_turn` consistent with the completion's finish reason can
report success. Limits, refusal, missing or conflicting terminal fields remain
errors with valid partial results. Nested failures preserve the agent computer,
recorded steps and native usage, including separate cache-read and cache-write
token counts, alongside OpenAI-shaped aggregate usage. Malformed native detail
is explicitly marked incomplete. A failed call may include completed, billed
work: inspect it before deciding what remains, and do not automatically replay.
Neither agent tool starts the computer or switches endpoints after a failure.

The caller supplies the model key through `MANDALA_MODEL_KEY` on stdio or their
own `X-Model-Key` header on HTTP. The account Authorization remains separate;
HTTP never falls back to the operator's model key. Waiting heartbeats count
notifications, not completed actions. Long-running clients need a
`progressToken` plus `resetTimeoutOnProgress`; otherwise choose a smaller
`max_steps`. That bound is neither a time cap nor a spend cap.

## Development

```sh
npm ci
npx vitest run    # deterministic offline tests, including the synthetic contract
npm test          # offline tests plus the separate private mirror check
npm run build
npm run lint
```

CI runs the offline suite on Node 20, 22, 24 and 26. A separate Node 22
`published-openapi` job runs on pull requests and main pushes:

```sh
npx vitest run --config vitest.openapi.config.ts
```

It anonymously fetches the fixed publication at
`https://app.mandala.computer/api/docs/openapi.json` once, with a 20-second
overall deadline and an 8 MiB body ceiling, then exercises the real MCP tools
and requires request evidence for every published `/api/v1` operation. Every
exercise variant must succeed and dispatch a request, including later variants
of a tool that already dispatched successfully.
Non-v1 operations are explicitly excluded and reported. The check uses OpenAPI
server inheritance and literal-path precedence, not the local route allowlist.
Each path is appended to its effective server base; repeated prefixes are not
removed. Fully prefixed paths work with an absent or root server.
It fails on a blocked fetch, redirect, invalid document or missing operation;
there is no fixture fallback, credential requirement or skip branch.

The committed OpenAPI fixture is synthetic, assembled from the public MCP route
inventory, and is never presented as a downloaded publication. Offline green
proves deterministic implementation coverage only. Anonymous CI at
[commit 1b04314](https://github.com/mandalacomputer/mcp/commit/1b04314e84f5701e2e15c65cbb1c44a0c14a4948)
returned HTTP 200 and matched all 56 operations in the fetched v1 contract using
123 requests from 83 tools. That result applies to that commit and publication;
every subsequent head must pass the gate independently. These counts are
observations, never fixed thresholds or exemptions. A blocked or red public gate
must not be merged. Parameters and response modes remain separate contracts,
with documented parameter exceptions and JSON-only chat support.

### Where the platform's rules live

This server gets no privileged access. Everything it does goes through the same
curated `/api/v1` surface the Python SDK uses, owner-scoped to the key's account
and audited against it. Anything it needs that `/api/v1` does not expose is a
change to the platform's route table, not a wider pass-through here.

### Maintainers: the surface check

The platform allowlists every route `/api/v1` will answer and 404s the rest.
`test/allowlist.ts` mirrors that table, and the tests assert two things: that
every successful exercised call lands on an allowlisted route, and that no
mirrored operation remains unexercised (`UNIMPLEMENTED` is empty). Tool names
and exercise entries must match in both directions, and every tool must make
an observed HTTP request during its callback. The independent public gate also
detects a new published operation when the mirror has not yet been updated.

`npm run check:surface` goes further and diffs the mirror against the platform's
published surface manifest — a file the platform generates from its own tables
and commits like a lockfile — whenever the platform repository happens to be
checked out next door, or wherever `MANDALA_PLATFORM_REPO` points. Without it
the script says it is skipping and exits 0, which is what it does for anyone
outside the platform team; a manifest it cannot read is a failure, never a
comparison of nothing. The diff is enforced from the platform's own CI, which
checks this repository out beside itself and runs the same script.

```
check:surface — the mirror matches the platform (N routes, N parameters, from …).
```

## See also

- [python-sdk](https://github.com/mandalacomputer/python-sdk) — the Python SDK,
  for writing code against the same API rather than driving it from a model.

## Security

Please report anything security-sensitive privately — see
[SECURITY.md](SECURITY.md) rather than opening an issue.

## Licence

MIT.
