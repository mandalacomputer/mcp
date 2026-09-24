---
name: mandala-computer
description: Drive a Mandala Computer — a real Linux desktop in the cloud the agent can see and click — through the `mandala` MCP server. Use when a task needs a GUI, a browser session, a display, or a machine that is not this one; when the user says "mandala", "cloud desktop", "computer use", "spin up a computer", "open it in a real browser"; or before the first create_computer / screenshot / run_agent call of a session.
---

# Driving a Mandala Computer

The `mandala` MCP server exposes desktop tools, each described well enough to
call from its own text. It does not yet implement every API operation. This skill is the part the
tools cannot say for themselves: when a computer is the right answer, what it
costs, and which of the tools to reach for so a task does not become a
screenshot per step.

## Is a computer the right tool?

Reach for one when the work needs a **display**: a web app with no API, a
browser session that has to be logged in and clicked through, a desktop
application, a file that has to be seen rendered, or a machine that must not be
this one — untrusted code, a clean OS, a second network position.

Do not reach for one to run a shell command. `exec` exists, but a Mandala
computer is billed while it runs, and a command the local machine can run costs
nothing. If the task is "run this script", run it here.

## Setup, once

The plugin starts a local stdio server. The user can sign in once through the
TypeScript CLI (`mandala-computer` on npm, requiring Node 22 or newer) and use
the saved credentials. MCP itself supports Node 20.3 or newer with an existing
saved profile or an environment key:

```sh
npm install -g mandala-computer
mandala login
claude mcp add mandala -- npx -y mandala-computer-mcp
```

The TypeScript CLI alone implements `mandala login`; the Python distribution
also has a command named `mandala`. Browser approval is a user action. Do not
use model tools to approve devices, receive device secrets, or write the
credential file.

Local stdio selects `--profile`, then `MANDALA_PROFILE`, then the default in
`~/.mandala/credentials.json`. Profile names are case-sensitive. For example,
`mandala login --profile Work --workspace Research` saves a workspace profile;
add `--profile Work` after `mandala-computer-mcp` to use it. An explicit API key
or nonempty `MANDALA_API_KEY` wins over profile selection without accessing the
store. Whitespace-only environment keys are absent; empty explicit keys fail.

The saved store needs a current-owner real directory with mode `0700` and an
owned regular `0600` file with exactly one link. Symlinks, hardlinks, malformed
files and unsafe protection fail at startup. Verified POSIX file protection is
required; Windows users can use explicit/environment keys. Base overrides must
match the saved profile's complete canonical API base, including its path and
port. A session keeps its chosen key/base until restarted.

- `MANDALA_API_KEY` — optional API key from **Settings → API keys** at
  https://app.mandala.computer. Treat it as a password. It may cover the account
  or only one workspace, which is why a 404 below is not always what it looks like.
- `MANDALA_MODEL_KEY` — optional Anthropic key, enabling `run_agent` and
  `run_agent_chat` when filters permit them. Without it neither is registered.
  The platform stores no copy and model work is billed to that key. It is
  separate from the saved Mandala API credentials.

If startup fails, read the local error and ask the user to correct the named
profile/protection setting, run the TypeScript `mandala login` command, or set
`MANDALA_API_KEY`. Invalid filters also prevent startup. Do not work around an
unavailable server with `exec` or a browser. Revoke a device-named API key in
**Settings → API keys** when it is no longer needed. A revoked key causes an
ordinary refusal; MCP never logs in, changes profiles, rereads the file, or
replays the refused action. The user can explicitly log in again and restart.

Optional configuration:

- `MANDALA_BASE_URL` — a platform other than the default
  `https://app.mandala.computer/api/v1`: a self-hosted install, or staging.
- `MANDALA_COMPUTER_ID` — bind one machine at startup, so `use_computer` is
  never needed and every call may leave `computer_id` out.
- `MANDALA_NO_LIFECYCLE=1` (or `true`, `yes`, `on`) — withholds every tool that makes a computer or
  destroys one: `create_computer`, `clone_computer`, `clone_snapshot`,
  `delete_computer`, `delete_snapshot`. If you were sent here to create a
  computer and `create_computer` is absent, this or the filters below may be
  deliberate. Say that the needed capability is unavailable.
- `MANDALA_READ_ONLY=1` — register only tools with `readOnlyHint: true`.
  Like `MANDALA_NO_LIFECYCLE`, accepts `1`, `true`, `yes`, `on` or `0`,
  `false`, `no`, `off`; whitespace and letter case are ignored. Empty or
  unset means off; unknown values fail at startup. Reads that can resume and
  bill a computer, including `read_file` and `cursor_position`, are withheld.
  Mixed tools such as `wait_for_computer` and `snapshot_schedule` are also
  withheld. `screenshot`, `read_clipboard` and `list_windows` keep the hint.
- `MANDALA_TAGS=input,guest` — select a union of lowercase tool tags:
  `activities`, `agent`, `artifacts`, `computers`, `events`, `executions`, `files`, `guest`,
  `input`, `lifecycle`, `results`, `secrets`, `signals`, `snapshots`, `ssh`, `templates`,
  `usage`, `webhooks`.
  Entries are comma-separated, trimmed and deduplicated; empty entries are
  ignored, and empty or unset means unfiltered. Unknown tags, including
  uppercase names, fail at startup and name the valid set. `files` means
  `list_directory`, `read_file`, `write_file`, `wait_for_file_change`; the last also belongs to
  `events`. `guest` covers execution, windows, clipboard and URL tools;
  `input` includes screenshots and waits. `templates` includes listing and
  builds. See the README's Tool filters table for the full inventory.

Filters intersect: tags cannot restore a tool withheld by read-only,
`MANDALA_NO_LIFECYCLE`, or a missing model key. A connected server may have
an empty tool list (`agent` plus read-only does). `files` plus read-only exposes
only `list_directory`. Both agent tools need the caller's model key, and
lifecycle disabled alone does not withhold them. Check the actual
tool list before following any workflow below; use only tools that are
present. If the task requires a withheld tool, explain the limitation instead
of trying another route to the same action. `use_computer` is not read-only:
pass `computer_id` explicitly when it is absent, or use the stdio startup
binding. If shutdown tools are withheld, report the computer's state instead
of attempting the cleanup recipe below.

### The two ways it gets installed

**stdio**, which is what the plugin does, and what any client that can spawn a
subprocess should do — one server per client, holding the key from its own
saved profile or environment:

```sh
claude mcp add mandala -- npx -y mandala-computer-mcp
```

**HTTP**, for a caller that cannot spawn a subprocess — claude.ai, a phone, a
shared team endpoint. One server, many callers, and it holds no credential of
its own: each caller sends their own key as a bearer token.

```sh
# whoever runs it, once
MANDALA_ALLOWED_HOSTS=mcp.example.com npx mandala-computer-mcp --http --port 3000

# each caller
claude mcp add --transport http mandala https://mcp.example.com/mcp \
  --header "Authorization: Bearer com_…"
```

HTTP never loads the local credential store and ignores `MANDALA_API_KEY`,
`MANDALA_PROFILE` and `--profile`. Over HTTP it also ignores `MANDALA_MODEL_KEY`
and `MANDALA_COMPUTER_ID`, rather than lending the operator's Anthropic key and the operator's machine to
everyone who connects. A caller who wants `run_agent` there sends their own
Anthropic key as an `X-Model-Key` header, and `run_agent` is registered for
that session only if they did and the filters permit it.

## The shape of a session

```
create_computer(size="large")          one call: built, booted, and bound to this session
wait_for_computer(until="guest")       "running" is the VM; "guest" is the desktop answering
… the work …
suspend_computer()  or  stop_computer()   ALWAYS, before you say you are done
```

1. **Prefer a computer that already exists.** `list_computers` first. A
   suspended machine resumes with `start_computer` in about a second, keeps its
   windows and logins, and creates nothing new to pay for. Bind it with
   `use_computer`; every later call then leaves `computer_id` out.
2. **Create with a named `size`** from `list_sizes`. Those shapes are kept
   pre-booted and answer in seconds; a custom cpu/ram/disk shape boots cold.
   Send `size` alone or the explicit fields alone, never both. `create_computer`
   binds the new machine to the session for you.
3. **Wait for the guest, not for "running".** `wait_for_computer` with
   `until="guest"` before the first `screenshot`, `exec` or `open_url`. A
   screenshot of a boot screen is not a failure, it is impatience.
4. **Do the work** — see the next two sections.
5. **Leave nothing booted.** A running computer costs money and a forgotten one
   keeps costing it. Idle suspend catches it after 30 minutes, which is 30
   minutes of bill. `suspend_computer` is a pause (RAM to disk, resume in a
   second, same session); `stop_computer` is a shutdown (disk kept, session
   gone). Say which you did and why in your final message, and name the
   computer so the user can find it. `delete_computer` only when the user asked
   for the machine to go — it is irreversible and requires `confirm: true`.

A skill that leaves a computer running is worse than no skill. If you are
unsure whether the user wants it kept, suspend it and ask.

## Getting the task done: one call, or a loop

**`run_agent` is one call for the whole loop, and is usually the right level.**
Give it the task in plain language and the platform screenshots, decides,
clicks and types inside itself, then answers with a sentence and the list of
what it did. Ten clicks are not ten images in your context. Use it for
anything that is more than two or three interactions: filling a form, logging
in and navigating somewhere, reading a value off a page, driving an
application. It needs a running computer, and it needs a model key to exist
at all: `MANDALA_MODEL_KEY` in the server's environment over stdio, or the
caller's own `X-Model-Key` header over HTTP, where the server's variable is
ignored. If every other `mandala` tool is present and `run_agent` is not, that
may be due to a filter or the missing model key. Check the configured filters
before explaining which key mechanism applies; an HTTP user needs their own
header rather than the operator's environment variable.

- `max_steps` (default 20, max 100) bounds actions, not time, model calls or
  spending. A client needs `progressToken` plus `resetTimeoutOnProgress` to
  keep long calls alive; otherwise choose a smaller value.
- Read the first line of the answer. `finished` is done. `RAN OUT OF STEPS` is
  a task that is probably not done: look with `screenshot`, then either finish
  the last step yourself or run again with a narrower prompt from where it got
  to. Do not re-run the same prompt with a bigger number without looking first.
- A run is minutes. Do not start one and then poll `screenshot` beside it.
- A run can be stopped part way through by something that is about the caller
  rather than the computer — a key revoked, a role changed, an account
  suspended, a plan that no longer covers the work. The answer says so and
  lists the steps that did run; those are billed. Re-running the same prompt
  pays for them again and is refused the same way, so fix the cause first, and
  when you do resume, resume from what the completed steps already did.

**`run_agent_chat` uses textual OpenAI-shaped messages and JSON-only results.**
It drives the same BYOK Anthropic loop, not hosted inference or a chat UI.
The last user message is the task; system messages supply standing instructions.
Previous user/assistant conversation is not replayed. String text and text-part
arrays are supported. Optional `model` must name an Anthropic model and is sent
unchanged. JSON (`stream:false`) preserves `agent.stop`, step count and usage.
Only an explicit, consistent `end_turn` result establishes completion. Treat
limits, refusals, malformed responses and conflicting stop fields as incomplete;
inspect any partial billed work before doing more. It never starts the computer
or retries by calling another agent endpoint. Its progress counts waiting
heartbeats, not completed actions.

**Passive metadata tools** preserve the API's scope and health distinctions.
`list_directory` preserves exact absolute paths and filenames. It contacts the
guest only when running, without resume or idle extension; rate/capacity
admission still applies. A partial unordered listing examines at most 512
entries/128 KiB and has no continuation token. Narrow the path when truncated or
names were skipped; never automatically rescan. Symlinks are not followed and
unavailable entries have no inferred type or size. It does not read file content.

`list_activities` returns one history page; opaque `cursor` continues history,
and `changes:true` requires a cursor to read late updates to older rows. There
is no limit parameter. Preserve nullable `next_cursor`, `changes_cursor`, gap
and health fields. Refresh history after a gap. `get_activity` keeps request
state/revision/scope, optional execution identity and signed exit status.
Accepted background work is not completed execution. Activity IDs identify
requests, never idempotency keys. History is retained, selected, best effort.
`get_activity_results` is passive metadata only: at most eight newest links,
with availability and association intact. `more` has no cursor; caller-selected
artifact association proves neither creation nor command success. Never follow
links implicitly to content, files, captures, downloads or execution polling.
It belongs to both `activities` and `results`, once in a tag union.

`read_signals` belongs to `signals`, separate from the active `events` socket.
Omit `since` or send empty for a head-only baseline; optional `limit` is 1–100,
default 50 at the API. Keep the returned checkpoint even on empty pages because
filtered rows can advance it. Ephemeral retention and explicit reset gaps do
not prove no earlier work or task success. Unsupported 501 and unavailable 503
stay errors, never empty history or new checkpoints. Do not add a watcher,
retry, guest action or page-draining loop. Read-only filters grant no API role;
member/owner and workspace authorization is checked again on each request.

**Drive by hand** — `screenshot`, `click`, `type_text`, `press_key`, `scroll`,
`drag` — when you need to see each frame yourself, when there is no model key,
or for one or two actions. The rules there:

- A screenshot is how you find out what the screen looks like, and the only
  way to know a click landed. Screenshot after anything you expect to change
  the screen. Coordinates are the pixels of the full-size frame; if you asked
  for a scaled `width` to save context, point on a full-size one.
- A screenshot is **not** how you find out whether anything *happened*. The
  computer reports what it does — `wait_for_event` blocks for a window
  opening, a background command exiting, the desktop coming up; `poll_events`
  hands you what arrived while you were busy; `wait_for_file_change` waits on
  a directory in the guest. Use these instead of a screenshot loop, and read a
  timed-out wait as "nothing yet", not as an error.
- `list_windows` sees what a screenshot cannot: an application that failed to
  start versus one that has not painted yet. Match on `class`, not `title`.
- `open_url` puts a page on the screen. `exec` runs as root with **no
  display** — a GUI program started without `desktop: true` cannot draw.
- Anything slower than a few seconds wants `exec` with `background: true`,
  then `exec_poll` or `wait_for_event` for `process.exited`. A foreground
  command past about two minutes is abandoned by a proxy whatever `timeout_s`
  says, and the work keeps running in the guest unread.
- Text into a field: `write_clipboard` then `press_key` with
  `keys: ["ctrl","v"]` — two names, not the string `"ctrl+v"`. Key names are X
  keysyms: `"Return"`, not `"Enter"`.
- `type_text` takes at most 400 characters and types ASCII at about 12 ms a
  character. Text with accents, CJK or emoji types only in Chromium and Xfce
  Terminal on X11; elsewhere use the clipboard. Either way, a screenshot is
  what says the text landed.
- Screenshots deliberately do not count as activity. A loop that only watches
  can see its own machine suspend under it; input, `exec` and files do count.

## Credentials: the secret store

A credential the guest needs goes in the account's secret store, not into a
command line, a file you write, or a message. `create_secret` stores a value,
and no tool shows it again. `set_computer_secrets` binds it to a computer as an
environment variable or a file, and the computer gets it at its next start or
restart. A command that needs a bound variable runs with `exec` and
`desktop: true`. `replace_secret` rotates a value: a running computer gets a
file binding at once, and new desktop shells get an env binding on images that
support it. `delete_secret` stops a computer that is still bound to it from
starting, so remove the binding first. Never repeat a value back to the user.

## Keeping the work: snapshots and clones

A snapshot is a saved point on one computer; a clone is a second computer made
from one. They are how an expensive setup — an install, a login, a configured
application — stops being something you redo.

- `create_snapshot` **before** anything you would not want to do twice, and
  name it after the step rather than letting the platform name it after the
  clock: the name is the only place the reason survives. A disk snapshot is the
  filesystem; a memory one also saves the running session, so a fork of it comes
  up with the windows already open.
- `restore_snapshot` puts the *same* computer back and discards everything on
  that disk since, and it leaves the computer running — which is a start, and
  is charged. `clone_snapshot` and `clone_computer` make a *new* computer
  instead, which bills like any other: the cheap way to get five identical
  desktops, and an easy way to leave five of them running.
- A capture outlives the call that starts it: the platform accepts it and copies
  the disk over the next several minutes. `create_snapshot` waits that out for
  you and answers with the finished snapshot — pass `wait: false` only when you
  have other work to do meanwhile, and then poll `list_snapshots` for the id it
  gave you.
- Both waits report progress on every poll, so a client that sets
  `resetTimeoutOnProgress` can hold the request open through a capture that
  takes minutes. If yours cannot, pass `wait: false` and poll `list_snapshots`
  rather than letting a 60-second default cancel a call while the platform goes
  on copying.
- `delete_snapshot` waits too, and for the opposite thing: a deletion is
  finished when the row **goes**, and one that stays is one that stalled. The
  platform retries those itself, so a wait that runs out is something to watch
  rather than repeat — and a 409 saying the snapshot is already being deleted
  means the platform is doing it, not that you should delete something else.
- Read `state` in `list_snapshots` before acting, on every row rather than on
  the newest: a capture still being taken reads `capturing` and restore, clone
  and delete all fail on one. A row that vanishes without ever leaving
  `capturing` is a capture that failed. Only automatic snapshots age out —
  `get_retention` is the window, and one you took yourself with
  `create_snapshot` is kept until somebody deletes it.

## Refusals: which are worth a second try

The server renders every failure as one sentence, and the sentence usually
says what to do. The judgement it cannot make for you:

- **A 400 never clears.** Do not resend it. Change the request or stop.
- **A 401 or a 403 is about you, not the computer, and either can arrive
  mid-request.** Who you are is checked again while a call is in flight, before
  anything further is done — so a revoked key, a role that changed or an account
  suspended stops a long call after part of its work is already done. Neither
  clears by being resent. The dangerous case is resending one that creates,
  starts, moves, writes or deletes: check what took effect first. Re-authenticate
  for a 401; for a 403 say what was refused and stop. Do not report either as the
  computer being broken or gone, and do not read it as a transport failure worth
  retrying.
- **A 402 is a plan limit.** Waiting does not fix it and neither do you — tell
  the user what was refused and leave it there. One that arrives after a long
  wait means the same thing rather than something going wrong on the machine:
  the plan, as it stands now, does not cover the work.
- **A 404 is not proof the computer is gone.** An API key can be scoped to a
  single workspace, and a computer in a *different* workspace answers 404 and
  not 403 — deliberately, so a key that cannot reach a machine is not told the
  machine exists. So a 404 on an id the user handed you means either deleted or
  out of this key's reach, and from here the two are indistinguishable. Do not
  report it as deleted. `list_computers` shows what the key can actually see;
  if the id the user named is not in that list, ask whether the key is the one
  for that workspace. The same holds for a snapshot id and `list_snapshots`.
- **A 409 is not one thing.** Most describe a passing state — a guest still
  booting, an agent busy with another call, the clipboard claimed for an
  instant — and the sentence will say "worth sending again". Some describe a
  **decision**: the computer is not running (fix: `start_computer`, not a
  retry), a size the host cannot run, a computer that has to be stopped first.
  Those answer the same way forever. When the sentence says "does NOT clear by
  waiting", believe it.
- **A 409 `starting` is the boot window**: about two minutes after a start, a
  restart or a reboot inside the guest. It clears; send the call again in a
  moment. A guest agent still silent after that window answers 502 instead.
- **502, 504 and a dropped connection mean the outcome is unknown, not that
  the request never left.** Never replay a *create* on one of those — the
  computer may exist and be billable. `list_computers` first, and bind what
  you find. A read, a `wait_for_computer`, a `screenshot` can simply be sent
  again.
- **A 503 on a change is the same: it may or may not have happened.** A read
  answered 503 can be sent again shortly. A create, a command, a clone or a
  snapshot answered 503 is read back first — the sentence says so — because
  repeating it blind can do it twice.
- **A refused resize with an offer** ("another host could run it") does not
  clear by retrying. `move_computer` takes the offer up; it copies the disk,
  so say what that costs before calling it.
- **A stop that is refused** is a guest that will not come down — a modal
  dialog, a hung session. `force: true` on the second attempt, not the first;
  whatever was unsaved goes with it.
- **`create_computer` that came back "did not start"** is a computer that
  exists and is selected. `start_computer` often works on a second attempt.
  Do not create another.

## A short list is an answer

`list_computers`, `list_snapshots` and `list_builds` fan out across
hypervisors and answer 503 rather than a list that is quietly missing things.
`allow_partial: true` accepts the incomplete answer; the result then opens
with an `INCOMPLETE:` line. Read that line to the user — a short list looks
exactly like the missing computers were deleted, and a model that "cleans up"
against one is deleting things it cannot see. Never make a destructive decision
off a listing that said `INCOMPLETE`.

## Things not to do

- Do not paste `get_desktop_url` output with `control: true` anywhere but to
  the user who asked: that link is root on the machine. The default, view-only
  URL is safe to share.
- Do not `retire_template` without naming a `version` unless every version is
  meant to go — it cannot be undone and the name can never be republished.
- Do not delete snapshots as a side effect of deleting a computer without
  reading `snapshot_holdings` first and passing its fingerprint as `expect`.
- Do not answer "what did this cost" from memory. `get_usage` is the read, and
  its first line says if a hypervisor could not be reached and the figure is
  low.
