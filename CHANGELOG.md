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

[0.4.0]: https://github.com/mandalacomputer/mcp/compare/v0.3.0...v0.4.0
