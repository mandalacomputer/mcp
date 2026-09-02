---
name: mandala-computer
description: Drive a Mandala Computer — a real Linux desktop in the cloud the agent can see and click — through the `mandala` MCP server. Use when a task needs a GUI, a browser session, a display, or a machine that is not this one; when the user says "mandala", "cloud desktop", "computer use", "spin up a computer", "open it in a real browser"; or before the first create_computer / screenshot / run_agent call of a session.
---

# Driving a Mandala Computer

The `mandala` MCP server carries the whole surface — nearly seventy tools, each
described well enough to call from its own text. This skill is the part the
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

The plugin starts the server for you. It reads two variables from the shell
Claude Code was started in:

- `MANDALA_API_KEY` — a `com_…` key from **Settings → API keys** at
  https://app.mandala.computer. Required. It is every computer on the account,
  so treat it as a password.
- `MANDALA_MODEL_KEY` — an Anthropic key. Optional; it is what enables
  `run_agent`. Without it the tool is not registered at all.

Without the plugin, the same server is one line:
`claude mcp add mandala -e MANDALA_API_KEY=com_… -- npx -y mandala-computer-mcp`.

If a `mandala` tool call fails saying there is no API key, stop and ask the
user for one — nothing else in this skill works until it is set.

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
application. It needs a running computer, and it needs `MANDALA_MODEL_KEY` to
exist at all.

- `max_steps` (default 20, max 100) is the spending cap as much as the loop
  bound — every step is a model call on the user's key. Size it to the task.
- Read the first line of the answer. `finished` is done. `RAN OUT OF STEPS` is
  a task that is probably not done: look with `screenshot`, then either finish
  the last step yourself or run again with a narrower prompt from where it got
  to. Do not re-run the same prompt with a bigger number without looking first.
- A run is minutes. Do not start one and then poll `screenshot` beside it.

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
- Screenshots deliberately do not count as activity. A loop that only watches
  can see its own machine suspend under it; input, `exec` and files do count.

## Refusals: which are worth a second try

The server renders every failure as one sentence, and the sentence usually
says what to do. The judgement it cannot make for you:

- **A 400 never clears.** Do not resend it. Change the request or stop.
- **A 402 is a plan limit.** Waiting does not fix it and neither do you — tell
  the user what was refused and leave it there.
- **A 409 is not one thing.** Most describe a passing state — a guest still
  booting, an agent busy with another call, the clipboard claimed for an
  instant — and the sentence will say "worth sending again". Some describe a
  **decision**: the computer is not running (fix: `start_computer`, not a
  retry), a size the host cannot run, a computer that has to be stopped first.
  Those answer the same way forever. When the sentence says "does NOT clear by
  waiting", believe it.
- **502, 504 and a dropped connection mean the outcome is unknown, not that
  the request never left.** Never replay a *create* on one of those — the
  computer may exist and be billable. `list_computers` first, and bind what
  you find. A read, a `wait_for_computer`, a `screenshot` can simply be sent
  again.
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
