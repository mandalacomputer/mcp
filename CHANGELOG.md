# Changelog

Notable changes to `mandala-computer-mcp`. Dates are release dates; the format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project is pre-1.0, so a minor version may carry a behaviour change.

The reasoning behind a change lives in its commit message rather than here.
This is the summary you read to decide whether to upgrade.

Note that in an MCP server the error text *is* the interface: what a tool says
about a refusal is what the model reads and reasons from. Several entries below
are wording changes, and they are behaviour changes in the way that matters.


## [Unreleased]

### Added

- **Hosted OAuth mode for `--http`.** With
  `MANDALA_MCP_RESOURCE_METADATA_URL` set, every `/mcp` request without a
  bearer, and every one whose token the platform refuses, is a `401` with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:tools"`, so MCP
  clients authorize and refresh on their own. A different bearer on an existing
  session is answered `404` (initialize again) rather than rebound. A bearer
  is checked with the platform before an initialize creates a session and
  before a request is dispatched (only a `2xx` counts, cached 60 s), and
  refused initializes are budgeted per source without locking out a valid
  client behind the same address.
  `MANDALA_MCP_SERVICE_SECRET` is sent as `X-Mandala-MCP-Service` on every
  platform request; a client's own header of that name is never forwarded.
  Without either variable nothing changes.


## [0.5.0] — 2026-09-23

### Added

- **`clone_snapshot` takes `memory` and `inherit_secrets`.** `memory: false`
  builds a memory snapshot's clone from its disk alone, as a fresh boot with its
  own network identity. `inherit_secrets: true` consents to resuming a memory
  snapshot of a computer that held secrets, and the tool's description says in
  so many words that the copy then holds the same credentials.
- **`clone_snapshot` says when the session was not resumed.** When the platform
  built the copy from the disk instead (`memory_dropped`), the reply leads with
  that and the reason, rather than reporting a fork the model would go on to
  treat as a live session.
- **`get_computer_secrets` and `set_computer_secrets`.** Read and replace which
  of the account's secrets a computer is bound to — secret id, revision and env
  name; no value ever crosses either tool. A set replaces the whole list (`[]`
  removes every binding), and its reply says the change reaches the guest at the
  computer's next start or restart, not before. Sending the `version` a read
  answered makes the change refuse with 409 if the list moved in between. A
  computer's first binding needs it stopped (409 while running or suspended,
  since a restart does not deliver it); start it afterwards. Both are under a
  new `secrets` tag.
- **Secret bindings as files, and at create.** `create_computer` takes
  `secrets`, binding secrets from the account when the computer is made; with
  none, no `secrets` key is sent. A binding, there and in
  `set_computer_secrets`, names exactly one of `env` (an environment variable)
  or `file` (published as `/run/mandala-secrets/user/files/<file>`), and
  `get_computer_secrets` shows a file binding by its full path. At most 32
  secrets and 8 files per computer, none twice, and names in the platform's
  spelling: a list the platform would refuse is refused before it is sent, and
  names the entry at fault. Both tools now say that every start and restart
  delivers each secret's latest value, and that a secret bound as a file is
  rewritten on a running computer within seconds of its value being replaced.
  Ids must not be empty or carry spaces around them. An answer with a binding
  that is missing its id or revision, names both or neither of `env` and
  `file`, or spells either in a way the platform would not accept, is refused
  whole rather than shown one short; so is one without a whole-number
  `version`.
- **Stable handles for background commands.** A background `exec` now returns
  the platform's stable `execution_id` when it has one, alongside the PID, which
  still works for `exec_poll` and `exec_kill`. `get_execution` reads what was
  last observed of that execution — running, exited or lost — without touching
  the guest, and `read_execution_output` reads stdout and stderr at independent
  byte offsets without moving the shared PID cursors or resuming the computer.
  A command accepted with a malformed id says so and tells the model not to run
  it again.
- **Retained results and artifacts.** Volatile guest output can now be kept.
  `retain_execution_output` captures an immutable copy of a background
  command's output, and a synchronous `exec` takes an optional `retain_output`
  (default behaviour is unchanged). `get_result`, `read_result_output` and
  `delete_result` read, page through and delete those versions.
  `publish_artifact` captures a file the caller names, with its expected size
  and SHA-256; `get_artifact`, `read_artifact` and `delete_artifact` read and
  delete it. `read_artifact` returns content only when the whole artifact fits
  (4 KiB by default, 16 KiB at most) and verifies its size and hash; a larger
  one comes back as metadata alone. None of them resumes a computer or replays
  a command.
- **Passive reads that do not wake a computer.** `list_directory` lists a
  directory on a computer that is already running. `list_activities`,
  `get_activity` and `get_activity_results` read the account's retained API
  activity history, newest first. `read_signals` reads the platform's finite
  facts about a computer without resuming it or opening the event socket.
- **`run_agent_chat`.** The same computer agent as `run_agent`, driven with
  OpenAI-shaped text messages and returning JSON: the last user message is the
  task and system messages are standing instructions. Like `run_agent`, it
  needs a model key for the session.
- **`get_account`.** The account's plan ceilings, what it is using and what is
  left. It is advisory: headroom for indexed snapshots does not reserve
  capacity, and a total the platform could not count is shown as unknown rather
  than as zero.
- **SSH keys and per-computer SSH.** `list_ssh_keys`, `add_ssh_key` and
  `remove_ssh_key` (which asks for confirmation) manage keys, which belong to
  the person the API key was issued to rather than to the account;
  `set_computer_ssh` switches SSH on or off for one computer, reachable only
  through the platform's jump host and accepting the keys of every owner and
  member, with no restart either way; `get_computer_ssh` reads that setting and
  whether the computer can run SSH at all. `add_ssh_key` refuses a private key
  without sending it. All five are under a new `ssh` tag.
- **Tool filters.** `MANDALA_READ_ONLY=1` registers only the tools annotated
  read-only, and `MANDALA_TAGS` (comma-separated, lowercase) registers only the
  named groups. An invalid setting fails at startup, before any transport opens,
  and the instructions a filtered session receives describe only the tools it
  has. The Claude Code plugin forwards both. The tag inventory is in the README.
- **Saved credential profiles.** A local stdio session with no API key can use
  the profile saved by `mandala login`: `--profile`, then `MANDALA_PROFILE`,
  then the saved default. An explicit or environment key still wins. The
  session keeps that identity until it is restarted and never falls back to
  another. HTTP mode ignores profiles and uses each caller's bearer token. The
  plugin forwards `MANDALA_PROFILE`.

### Changed

- **Errors keep the platform's diagnostics.** A tool's error result now carries
  the `reason`, `request_id`, `allow`, `www_authenticate` and `retry_after_ms`
  the platform sent, as labelled and length-bounded metadata. A 401 the
  platform classified says whether the credential was missing, invalid or
  revoked; one it did not is no longer presented as telling the account key
  from the model key. An error nested in a chat run keeps its real status and
  the work already recorded.
- **For embedders:** an unsupported method now raises the exported
  `MethodNotAllowedError` (405), and every `APIError` carries optional
  `requestId`, `allow` and `wwwAuthenticate`. Existing constructor arguments
  keep their meaning.

### Internal

No effect on the tool surface.

- The surface mirror tracked each platform route as it landed — file browser,
  execution results, activity history, signals, retained output, artifacts and
  the `secrets`, `memory` and `inherit_secrets` parameters — pinned as not yet
  implemented until the tool that uses it arrived.
- A new CI job fetches the platform's published OpenAPI anonymously and requires
  evidence that every v1 operation is covered, so a route this server does not
  cover now fails a build rather than going unnoticed.


## [0.4.0] — 2026-09-14

### Changed

- **A mid-call authorization or plan refusal says what it means.** Who the
  caller is, and what their plan covers, are rechecked while a call is in
  flight, so a long call can be refused after part of its work is already done.
  The tool result now says that, rather than handing a model a bare failure to
  guess at.
- **`reason: "revoked"` is classified as permanent.** The platform added a fifth
  refusal word for the case where the authority a request arrived with no longer
  holds — suspended, demoted, removed, or a retired session — and it is the
  first of these words about the *caller* rather than about a computer. Nothing
  was broken before this: a 401 or 403 is none of the four transient classes, so
  an unrecognised word already answered `false`. What changes is that it is
  answered on purpose, and that a model is told to stop rather than left to
  retry by default.

### Fixed

- **A running move is no longer reported as stopped.** `list_moves` tested its
  `live` flag for truthiness — the very flag its own description tells a model
  to poll on — so a move still in progress could be reported as finished. A
  model acting on that starts work against a computer that has not arrived.
- **An event gap is attributed to the call that asked for it**, not to a later
  one. Two defects in the event subscription, both of them answers given to the
  wrong caller.
- **Event delivery survives cancellation and eviction**, delivery frontiers
  survive gaps and stopped waits, and a replacement greeting recognises a
  retained frontier.
- **The progress heartbeat survives an early timer fire.** A timer landing a
  millisecond short of its own deadline took the throttled branch and scheduled
  nothing, so one early fire — which libuv is entitled to deliver — ended the
  keepalive for the rest of the operation and put the 60-second client
  cancellation back.
- Progress is kept independent of slow senders and starts before polling; open
  SSE frames are delivered; partial downloads are validated and an unknown range
  total is preserved; guest text is preserved and tool outcomes reported
  accurately; overlapping watch nominations recover and metadata is bounded.

### Documentation

- **`run_agent` tells the model what a step is, not what it is not.** The
  description said a step was a model call plus a screenshot on your key,
  offering `max_steps` as a spending cap on that basis. That is false in both
  directions — the platform counts a step per *tool call*, one model call can
  spend several, a paused turn costs tokens and no step, and a bash call takes
  no screenshot. Of the three copies of this sentence across the clients, this
  is the one that mattered most: it is not documentation a person skims, it is
  the description handed to the model driving the tool.

### Internal

No effect on the tool surface, listed because it is most of the window.

- The drift check reads the platform's published **surface manifest** instead of
  scanning its source as text, and imports this repository's mirror the way the
  suite does. The scanner and its tests are gone, along with the class of defect
  they kept producing: a false all-clear, reporting the mirror in step because
  the scan had silently read nothing. The new reader fails closed on a manifest
  that is missing, unparseable, of an unknown version, or that names a key
  twice.
- The three limits this server mirrors are now compared against the platform's,
  which nothing did before.
- Several parser fixes landed before that scanner was retired, each ported to
  and from the TypeScript SDK's byte-identical copy.

[0.5.0]: https://github.com/mandalacomputer/mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mandalacomputer/mcp/compare/v0.3.0...v0.4.0
