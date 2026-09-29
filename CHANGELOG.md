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

### Changed

- **`wait_for_computer` with `until: "guest"` now waits for the desktop
  session** on a Linux computer. The guest agent answers a few seconds before
  the desktop user is logged in, and an `exec` with `desktop: true` sent in
  between was refused with a 409 "no active desktop session". A computer whose
  desktop session never becomes active now gives up naming it rather than
  reporting the guest as answering.

## [0.8.0] — 2026-09-29

### Added

- **`MANDALA_MCP_MAX_SESSIONS_PER_TOKEN`** sets the per-bearer session limit
  of a `--http` server (default 16), so 17 or more agents on one key need not
  evict each other's sessions and lose their `use_computer` bindings. It takes
  a whole number from 1 to 256, the server's whole session pool; anything
  else is refused at startup. A suspended account's bearer is still held to
  one, and a token is also held to its account's limit, below.
- **`MANDALA_MCP_MAX_SESSIONS_PER_ACCOUNT`** (`maxSessionsPerAccount` for
  embedders of `runHttp`) sets how many sessions one account may hold across
  all its tokens: default 128, half the pool. Read by the same rules as the
  per-token variable. On a self-hosted server each token is an account of its
  own, so a token that should hold more than 128 needs both raised.

### Fixed

- **`run_agent` and `run_agent_chat` no longer blame the plan for the model
  provider's refusals.** On these routes a `402` is the model provider's
  billing error for the configured model key, a `504` its timeout and a `529`
  its overload, and the advice now says to check the model-provider account.
  A `403` gets account advice (a role that changed, an account suspended) only
  when it carries `reason: "revoked"`; any other `403` is named as a possible
  permission error on the model key. This applies to a run that started and
  failed; a refusal given before any run started (a role that cannot run
  agents, a plan that does not cover them) keeps the role and plan advice.
- **`run_agent_chat` says it is for short tasks.** It does not stream, and the
  hosted edge cuts a request that does not stream after about 120 seconds,
  which stops the run and loses its result; the description and README say so
  and point long tasks to `run_agent`, and a `524` is answered with that
  explanation.
- **`run_agent_chat`'s answer to the edge's `524` says one thing.** A `524`
  with no JSON body (none at all, or the edge's HTML page) also carried the
  generic gateway text, which says the work carries on and is usually still
  going, beside the advice that the run was stopped. The answer now says only
  that the edge cut the request after about 120 seconds and the run stopped
  with it.
- **`open_url` opens the browser the image has.** It named `firefox` and
  backgrounded it, so it reported success either way, including on Omarchy,
  which ships only `chromium`. It now opens the first of `firefox-esr`,
  `firefox` or `chromium`, and an image with none is an error (exit 127)
  rather than a success. A launch still running when the 30-second wait runs
  out is reported as unknown (screenshot before retrying), not as a failure.
- **A lifecycle tool's platform `5xx` that names no `operation_id` is resent
  with the same `idempotency_key`.** Such an answer is usually a refusal given
  before the call was sent anywhere (another launch in progress, no host, an
  incomplete template catalogue), which releases the key; resending with it is
  safe either way. The spent-key, read-first route is kept for a `5xx` that
  names an `operation_id` and for `idempotency_outcome_unknown`.
- **The hosted server admits a suspended account.** Its bearer check read
  `GET ssh-keys`, which a suspended account is refused, so it was answered
  `503` and could never reach `whoami`; the check now reads `GET whoami`.
- **`delete_computer` reports a snapshot purge left incomplete.** A `202` with
  `ok: false` is now said to be a deleted computer with copies still queued,
  refused or unknown, quoting the platform's `error`, and `ok` and `purge` are
  kept in the structured answer.
- **`clone_snapshot` no longer says a disk clone boots.** A clone built from a
  disk ends its build stopped and has to be started with `start_computer`; the
  answer says "Built", not "Forked", since nothing in it says a fork resumed.
- Descriptions: `create_computer`'s `template` and `list_templates` describe
  the fallback to base and the retryable `503` while the catalogue is
  incomplete, and call the template's disk a minimum; `build_template` and
  `check_template` state the `system/...` parent rule and the `spec.secrets`
  rules (by id, at most 32, which refusals are worth retrying); every `exec`,
  plain or desktop, is said to see bound environment variables on an image
  that supports it; `create_webhook` says eight attempts (seven retries).

### Security

- **One bearer can no longer fill the HTTP server's session pool.** The only
  limit was the process-wide one (256 sessions), so a single accepted token,
  a suspended account's included, could hold every session and every other
  caller's initialize was answered `503` until the idle sweep. A bearer now
  holds at most 16 live sessions (`maxSessionsPerBearer` for embedders of
  `runHttp`), and a suspended account's bearer at most one, which is still
  enough to reach `whoami`. At its limit, an initialize closes that bearer's
  least recently used idle session to make room, and only once the new
  session exists, so an initialize that is refused or fails closes nothing;
  a session with a request in flight, including one still waiting on its
  token check, is never the one closed. When none is idle it is answered
  `429` with `Retry-After`; if the one it planned to close is put to work
  before the new session is made, the new one is dropped and answered `404`
  instead. Another bearer's sessions are never touched. A self-hosted server
  checks no bearer, so there the per-bearer cap only spreads one key's
  clients, and the process-wide cap still bounds an untrusted caller, even
  when `maxSessionsPerBearer` is not a usable number.
- **An account suspended after its bearer opened sessions no longer keeps
  them all.** The one-session limit was applied only at initialize, so a
  bearer that opened 16 sessions while active held all 16 after suspension,
  and while any of them was busy its next initialize was answered `429`
  saying it held its maximum of one session and should close one. Now the
  next request on any of its sessions, and its next initialize, close its
  other idle sessions down to one; the session serving that request and any
  with a request in flight are kept, and go on a later request once idle. A
  `429` for a bearer still over its limit says how many it holds and to wait
  for the busy ones.
- **One account can no longer fill the hosted server's session pool by
  holding many keys.** The limit was per bearer, so an account with 16 keys
  held all 256 sessions and every other tenant's initialize was answered
  `503`. Sessions now also count against the account the platform's
  `whoami` names for each token (a token whose `whoami` names none is an
  account of its own), and an account holds at most 128, half the pool.
  Initializes in flight are counted per account, so a burst across its keys
  cannot pass the ceiling together. At the ceiling an initialize closes an
  idle session to make room only if it is the requesting token's own (least
  recently used first, as at its own cap, and even while it is under that
  cap) or one of the same account whose token the platform has already
  refused; otherwise it is answered `429` with `Retry-After`, naming only
  the account's limit. A live session of another token, or any session of
  another account, is never closed for it. A refused session counts until it
  is closed, so an account cannot pass its ceiling by revoking its own keys.
  A session left behind by an OAuth refresh keeps counting too, until the
  client closes it (`DELETE /mcp` with the old token) or it idles out after
  30 minutes, so an account above half its ceiling when its clients refresh
  can be answered `429` for that long. Suspension is unchanged and still held per token. A full pool is still a
  `503`, now with `Retry-After`, and nothing is closed to make room in it.
- **A revoked token's sessions idle out on the hosted server, whatever
  else its holder sends.** Only a POST carrying a request has its token
  checked, yet a notification, a response, the standing `GET /mcp` stream,
  a `HEAD /mcp` or a `DELETE /mcp` the server refused (an unsupported
  protocol version, say) each kept its session from idling out, so a revoked token's holder could
  keep its sessions, and its account's ceiling, held indefinitely without
  ever being found refused, answering the account's valid tokens `429`. That
  traffic is still served, but now keeps a session alive only while the
  platform's acceptance of its token is still cached (60 s), so such a
  session idles out within about that plus the session idle timeout (30
  minutes). Each request renews the acceptance, so a client that makes one
  at least once per idle timeout is unaffected, and a session with a request
  in flight is still never swept.
  A self-hosted server is unchanged.

## [0.7.0] — 2026-09-27

### Added

- **`list_workspaces`, `get_workspace` and `list_workspace_members`**, read
  only, over the platform's `GET workspaces`, `GET workspaces/{id}` and
  `GET workspaces/{id}/members`: a workspace is `{id, name, created_at}`, a
  member `{user_id, email, name, role, accepted_at, suspended}`. A key confined
  to a workspace lists only that one and is refused the members (403). All
  three are in the `account` tag.
- **`paste_text`**: puts 1 to 8192 bytes of UTF-8 on the desktop clipboard and
  presses the paste shortcut, over the platform's input `paste` action, with an
  optional `shortcut` of `ctrl+v` (the default) or `ctrl+shift+v`. It is in the
  `input` tag, and `type_text`'s description points to it.
- **`modifiers` on `drag`**, the same list `click` and `scroll` take: keys held
  down for the whole gesture, sent as the drag's held keys.
- **`resume_only` on `start_computer`**, sent as `resume_only=true`. On a
  stopped computer with no saved session it succeeds without booting, and the
  answer says to read the status rather than take it as a start.
- **`model` on `run_agent`**: an Anthropic model id passed to the platform's
  agent body; left out, the platform picks.
- **`minted_by_key_id` on `list_api_keys` and `whoami`'s key**: the key that
  minted it over the API, or `null`. It was dropped from both answers. The
  description says revoking a key does not revoke the keys it minted.
- **`delete_computer` says its operation**: `(operation op_…)` in its sentence,
  and `operation_id` in the JSON it now appends when the platform recorded one.

- **`egress_proxy` on `create_computer` and `update_computer`:** `{server,
  credentials_secret_id?}` sends ALL of a computer's outbound TCP through a
  proxy (`http://`, `https://` or `socks5://`, explicit port, no bypass list);
  on `update_computer` it travels alone and `null` removes it. Its description
  tells the model that it fails closed, drops UDP to the internet and ICMP,
  does not proxy DNS, closes open connections when it changes, and that the
  credentials secret is not bound to the computer. A key it does not have
  (such as `bypass`), or `egress_proxy` beside any other field, is refused
  before a request is sent. A computer's summary line names the proxy, its
  credentials id, and `egress_proxy_pending`.

- **`idempotency_key` on every lifecycle tool:** `create_computer`,
  `clone_computer`, `start_computer`, `stop_computer`, `suspend_computer`,
  `restart_computer`, `update_computer`, `move_computer`, `delete_computer`,
  `restore_snapshot` and `clone_snapshot` send an `Idempotency-Key` — a fresh
  random one per call, or the tool's new optional `idempotency_key` input
  (1 to 255 printable ASCII characters, no spaces; anything else is refused
  before a request is sent). A failure whose outcome is unknown ends with the
  retry that cannot do the step twice. After a dropped connection or timeout
  once the request went out, a `5xx` a proxy in front of the platform answered
  (an HTML or empty body, or `520`-`526`), or the platform's
  `409 idempotency_in_progress`, that is the same key: `To retry without
  risking a second <what>, call <tool> again with idempotency_key "<K>".` After
  a `5xx` the platform answered itself, it is not: the platform has settled
  that key as lost, so resending with it can only answer
  `idempotency_outcome_unknown`, and the call may still be under way on its
  host (its operation stays `pending` for up to an hour, whatever happened).
  For `start_computer`, `stop_computer`, `suspend_computer`,
  `delete_computer`, `move_computer` and `update_computer`, the answer says to
  read `get_computer` (and `get_operation` when the error named one:
  `succeeded` means it happened, `running` means wait, `pending` alone is no
  reason to wait) and, if the step did not take effect, to call the tool again
  with a new key, or none. For `restart_computer`, which `get_computer` cannot
  show (a computer reads `running` before and after a reset), it says to read
  the operation instead (`get_operation`, or `list_operations` with the key):
  `succeeded` means the restart happened, `running` means wait, and anything
  else leaves it possibly done, so the user is asked before a second restart
  with a new key, or none. For
  `create_computer`, `clone_computer`, `clone_snapshot` and `restore_snapshot`,
  where a read made straight away cannot see a build or restore still landing,
  it says to read the operation first (`get_operation` with the `operation_id`
  the error named, or `list_operations` with the key), to wait with
  `wait_for_operation` and not resend with any key while it is `pending` or
  `running`, and to send the call with a new key, or none, only once the
  operation is final as `failed` or not found AND `get_computer` (or
  `list_computers` after a create or a clone) shows the step did not happen.
  The `idempotency_key` input's description says the same, per tool. The
  platform's `idempotency_in_progress`, `idempotency_outcome_unknown` and
  `idempotency_key_reused` refusals each get a sentence of their own
  (`idempotency_outcome_unknown` ends with the same per-tool route), and
  `isTransient` is false for `idempotency_outcome_unknown`. `list_operations`
  takes `idempotency_key`, an operation carries the key it was started with,
  and `delete` is a documented kind.

- **Lifecycle operations: `get_operation`, `list_operations` and
  `wait_for_operation`**, over the platform's `GET operations` and
  `GET operations/{id}`. `wait_for_operation` answers on `succeeded` and is an
  error carrying the platform's `error.code` and sentence on `failed`; it
  reports progress while it waits. `succeeded` means the platform finished its
  step, not that the desktop has booted, and every answer says so beside it.
  `kind` and `state` are open strings. The lifecycle tools now say the
  `operation_id` their answer carried (`create_computer`, `clone_computer`,
  the four power tools, `update_computer` when it resized, `restore_snapshot`,
  `clone_snapshot`), `create_computer` keeps it off the envelope of a create
  that would not boot, and `move_computer` carries it onto the outcome it
  reports. The three tools are in the `lifecycle` tag.
- **`browser_proxy` on `create_computer` and `update_computer`**: a proxy
  (`{server, bypass}`) for a computer's browsers, over the platform's new body
  field; `null` on `update_computer` removes it. Only the shape is checked
  here — which schemes and hosts are accepted is the platform's rule, and its
  400 sentence comes back as it is. `wait_for_computer` with `until: "guest"`
  now also waits while the platform reports the setting still being applied,
  and a computer's one-line description names its proxy and that gap.
- **`screenshot` takes `region`, `scale`, `format` and `quality`**, over the
  platform's new query parameters: a crop in screen pixels (measured before
  any scaling), a shrink factor in (0, 1], `png` or `jpeg`, and a JPEG quality
  of 1-100 — a cheaper frame for the model. A shaped picture comes back with a
  note that says how to turn a position in it into the screen coordinates
  `click` takes. `width` with `scale`, and `quality` on a PNG, are refused
  before anything is sent. A suspended computer refuses a crop, a scale, a PNG
  or a quality (409 `unavailable`), and the refusal names the two ways out:
  `start_computer`, or `fresh: false` without those arguments for the saved
  picture.
- **`whoami`** and **`list_api_keys`**, in the `account` tag, over the
  platform's new `GET whoami` and `GET api-keys`. `whoami` needs no permission;
  `list_api_keys` needs the key's opt-in "Manage keys" permission, and without
  it answers the platform's 403 sentence, which says how to turn it on. Neither
  ever shows a raw key. Minting and revoking keys are deliberately not tools: a
  mint would put a long-lived credential into the model's context, and a revoke
  is irreversible.
- **`set_secret`**: make a name hold a value — create the secret, or replace its
  value if the scope already holds one by that name (matched ignoring ASCII
  case, as the platform keeps names unique). The upsert the SDKs and both CLIs
  already had. A conflict between its read and its write is read again up to
  three times; a 503 is never sent again, and the value is never shown back.
  In the `secrets` tag.
- **`browser_proxy.credentials_secret_id` on `create_computer` and
  `update_computer`**: the id of a secret whose value is `user:password`, for
  a proxy that asks for one. Before this the schema refused the field, so the
  setting `get_computer` returns could not be sent back as it was, and an
  update without it removed the proxy's credentials, leaving every browser on
  the computer answered 407 by its upstream. The secret must be bound to the
  computer as a file; `update_computer` replaces the setting whole, so copy
  the id from `get_computer` to keep it for the same proxy. The descriptions
  say not to carry the id to a different server, since the credentials are
  sent to the proxy on every request and belong to the one they were set for.
  A value that is not a secret's id is
  refused before any request, and a computer's one-line summary names the
  secret: `browsers via <server> (with credentials <id>)`.

### Changed

- **`create_computer` takes `browser_proxy: null`**, and sends it: a template
  you published may carry a default browser proxy, which the computer inherits
  unless the create sends another one, or `null` for none. The schema refused
  `null` before.
- **`write_clipboard` takes empty text**, which the platform reads as a clear
  (the only way to clear the clipboard, after pasting a secret, say). It was
  refused before any request; the answer now says the clipboard is cleared.
- **`wait_for_computer(until="guest")` waits for an egress proxy's
  credentials.** While `egress_proxy_pending` is true every connection the
  computer opens is closed, so the wait holds until it clears, as it does for
  `browser_proxy_pending`. The tool and `until` descriptions say so. Because
  a wait can time out on an ordinary delivery, one that times out on it names
  `egress_proxy_pending` and says to call again to keep waiting; only if it
  persists across waits (the credentials secret was deleted, or an
  `update_computer` egress change got a `5xx` or no answer) does it say to
  send the `egress_proxy` setting again with `update_computer`, naming a
  secret that exists. Removing the proxy is named as the user's decision, since
  it sends all traffic directly. A wait that times out held on
  `browser_proxy_pending` names that flag too.
- **`screenshot` labels a suspended computer's saved frame.** A response marked
  `X-GC-Frame: suspended` (`fresh: false` on a suspended computer) is labelled
  as a saved frame with its own pixel size, not the live screen and not in
  click coordinates, instead of "Screen is WxH". The tool description qualifies
  its coordinate claim to match. `Bytes` carries the header as `frame`.
- **`get_computer_ssh` and `set_computer_ssh` say when only some keys are on
  the computer.** When `keys_pushed` is below `key_count` (one computer accepts
  at most 200), the answer says only that many are there and the rest are
  refused, instead of saying all of them can log in.
- **Descriptions brought in line with the platform:** `clone_snapshot` says a
  resumed copy gets its own MAC, address, hostname, machine ID, SSH host keys
  and desktop password and runs beside its source (it said the copy shared its
  source's identity and could not); `create_computer`'s `egress_proxy` says a
  create carrying one is never answered from the warm pool (not "always a cold
  boot") and that connections are closed, not leaked, until the credentials
  arrive; `check_template` names two refusals only a publish can make, a
  `spec.hardware.disk_gb` below the family's or parent's disk floor (400) and a
  build into a family that is not the account's (403).
- **A busy suspended computer's `screenshot` refusal keeps the shape rule.** A
  shaped screenshot refused with a word that clears by itself used to offer
  `fresh: false` without saying the crop, scale, PNG or quality has to go too.
  That word can come from a suspended computer whose saved desktop is busy, and
  there a shaped `fresh: false` is refused. The caveat now stays whenever the
  platform's sentence speaks of the saved desktop or of a suspend. A computer
  part way into a suspend is still refused as a busy screen, like a running one,
  and gets no caveat; the retry named first reaches it once it is suspended.

- **`wait_for_computer(until="guest")` waits for a bound computer's secrets.** A
  computer with secrets bound runs, and its guest answers, a few seconds before
  the values land, and a command run in between saw them unset. "guest" now
  also waits until the platform's `secrets_delivering` is false — or, on a
  platform that predates the field, until the receipt names the latest
  delivering start, the fallback both SDKs use. A delivery that
  failed stops the computer, and the refusal now says so, with the platform's
  reason. `get_computer` and the other computer summaries say "its secrets are
  still on their way in" while it lasts. A restart delivers bound secrets again
  and reads running before they land. `restart_computer`'s description and its
  answer now say so: waiting with "guest" covers that redelivery on a platform
  that reports it as `secrets_delivering`, and on one that does not, a command
  run in those first seconds can see its secrets unset.
- `--http`: a request with no session that is not an initialize now answers
  `401` when it carries no key, and, in hosted OAuth mode, when the platform
  refuses its token. It answered `400` "No session id" either way, which sent a
  client to its session handling when the fix was its credential. A caller
  whose key is fine still gets the `400`. The `429` for an address that has
  sent too many refused tokens now says "tokens" rather than "initializes",
  since it counts both.

### Fixed

- **`whoami` answers for a key confined to a workspace.** The platform now
  withholds the holder's email and name, and the account's name and plan, from
  such a key, answering `null` for each, because it may be in an end customer's
  hands. The tool refused that answer as malformed; it now accepts it, and its
  one-line summary names the user id where it named the email. The tool's
  description says which fields are `null` and why.
- **A 409 whose `reason` is `running` is permanent.** It is the platform's
  refusal of something only a stopped computer can have, a resize today, and
  nothing clears it by waiting. `isTransient` called it worth sending again, as
  it does any other `ConflictError`, and `reasonKind` had no answer for it; now
  `isTransient` answers `false`, `reasonKind` answers `'permanent'`, and a
  refused `update_computer` tells the model to stop the computer first, and to
  say so rather than stop one the user did not ask it to stop.

## [0.6.0] — 2026-09-25

Read before upgrading. The model gains five secret store tools, including
`create_secret`, `replace_secret` and `delete_secret`, which change the
account's secrets; they are in the `secrets` tag, so a deployment that should
not do that can leave them out with `MANDALA_TAGS`, or with `MANDALA_READ_ONLY`,
which keeps only their reads, `list_secrets` and `get_secret`. `--http` gains a hosted OAuth mode, off unless its
variables are set. For embedders, `isTransient` no longer calls a `503` on a
change transient, and a create-only upload's refusals arrive as two new
`ConflictError` subclasses, `FileExistsError` and `CreateOnlyConflictError`.
Several tool refusals and descriptions are reworded (see **Changed**).

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

- **`write_file` takes `overwrite`.** It defaults to `true`, which replaces a
  file already at the path as before and sends nothing new. `overwrite: false`
  creates the file only if nothing is there; a path that is taken is refused,
  and the reply says that attempt wrote nothing, that retrying does not change
  it, that if an earlier attempt's outcome was unknown the file may be yours (read
  it and compare before choosing another path or overwriting), and that
  `overwrite: true` replaces the file on purpose. A create-only 409 with no usable
  reason (a body that could not be read, or JSON without a string `reason`) is
  refused as a conflict with the reason unknown, never as one worth sending
  again, without claiming the path is taken, and with the attempt's outcome
  reported as unconfirmed. Linux computers only.
- **`FileExistsError`**, exported for embedders: the 409 whose `reason` is
  `"exists"`, a `ConflictError` that `isTransient` calls permanent.
  `reasonKind("exists")` is `"permanent"`. Raised only for that explicit word.
- **`CreateOnlyConflictError`**, exported for embedders: the exported `Api`
  raises a create-only upload's 409 with no usable reason as this
  `ConflictError`, with `reason` undefined and a message saying the reason is
  unknown. `isTransient` calls it permanent, and it claims nothing about the
  path.

- **The account's secret store: `list_secrets`, `get_secret`,
  `create_secret`, `replace_secret` and `delete_secret`** (OPL-4984, OPL-5026).
  A value is a tool argument and goes one way. A success shows only the
  decoded documented fields. A refusal shows only the status, the `reason`
  word and the tool's own sentence, never the platform's response text, which
  the `Api` does not keep for these routes. Any output is also scrubbed of the
  value, however short. Every public `Api` operation on a secret route runs
  inside one boundary. The route is judged on the URL actually sent, so `//`,
  `./`, `..` and percent-encoded spellings count. That covers `json`, `send`,
  `bytes`, `listing`, `sse` and `api.secrets`, including body reads,
  validation, iteration and reading the value itself. Any error that escapes is
  rebuilt with a fixed message. It keeps its class, so `isTransient` is
  unchanged, plus the status, the method, a documented `reason` word, a UUID
  request id and an `Allow` list of method names. Any of those that shares
  four characters with the value is dropped, and `Retry-After` is dropped
  entirely. `replace_secret` and `delete_secret` need the current
  `revision_id`, and `delete_secret` needs `confirm: true` and says that a
  computer still bound to the secret cannot start again. For embedders,
  `api.secrets` offers `list`, `create`, `get`, `replace` and `delete`, decoded
  strictly, with `Secret`, `SecretList`, `SecretLimits` and `SecretStore`
  exported as types. Every documented operation is now called by a tool.
- **`read_file` and `write_file` take `no_wake`.** With `no_wake: true` a
  computer that is not running is refused (409) rather than resumed, so nothing
  is charged for a resume. The refusal is read the same way whether it carries
  no `reason` or `reason: "unavailable"`.
- **`type_text` reports how the text was typed** (`mechanism`: key presses,
  Unicode composition, or both in order) and says that sending is not the
  application accepting it. Empty text and more than 400 characters are
  refused before anything is sent.
- **`APIError.method`**: the method of the refused request, set by the `Api`.

### Changed

- **`isTransient` is true for a `503` only on a GET or HEAD.** The platform
  documents that a change answered `503` may or may not have happened, so any
  other method, or an unknown one, is false. This is decided before the
  `reason` word, so `contention` or `starting` cannot make a create look safe to
  replay. The TypeScript and Python SDKs answer the same way. A tool refused
  with `503` says the same thing: read the current state before sending a
  change again.
- **`window_action` resize needs both `width` and `height`**, as the platform
  requires. `x`/`y` are bounded to -32768..32767 and `width`/`height` to
  1..32767.
- **`update_computer`'s `idle_suspend_min` is capped at 10080** (a week), as
  documented.
- **Tool descriptions brought in line with the corrected API docs**
  (OPL-5025):
  - Env secret live apply reaches new shells and `exec` with `desktop: true`.
    It is worded to hold after the platform also gives plain `exec` the bound
    environment (app OPL-5028).
  - A resumed guest's clock is resynced within seconds.
  - `start_computer`, `suspend_computer`, `restart_computer` and
    `stop_computer` state their conditions for computers that hold secrets.
  - `clone_computer`: the source must be stopped or suspended, and the copy
    lands stopped with no secrets.
  - `write_file` says a failure can leave the complete file at the path.
  - `list_templates` and `create_computer` say a template you published is
    named by its `ref`, and `create_computer` gives the resolution depths.
  - `restore_available` is explained on the snapshot tools.
  - `exec` says a missing `cwd` exits 127.
  - `window_action` covers Wayland tiling.
  - `list_webhook_deliveries` calls `last_error` an open set, with the
    retention measured from when a delivery was queued.
  - The `starting` refusal names its two-minute window and the `502` after it.
- **`get_computer` and the listings say when a computer's secrets are
  pending** (`secrets_pending: true`), when that is unknown (`null`), and why a
  delivery failed (`secrets_error`).
- **`clone_snapshot` names the `capture unrecorded` reason** for a memory
  snapshot built from its disk, and shows a reason it does not know rather than
  a generic sentence.

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

[0.8.0]: https://github.com/mandalacomputer/mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mandalacomputer/mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mandalacomputer/mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mandalacomputer/mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mandalacomputer/mcp/compare/v0.3.0...v0.4.0
