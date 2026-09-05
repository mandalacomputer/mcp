import { z } from 'zod';
import { CancelledError, isTransientForPoll } from '../errors.js';
import { guarded, incompleteWarning, json, refused, said } from '../format.js';
import * as P from '../paths.js';
import type { Registrar } from './types.js';

/**
 * The template store, and the builds that compile documents into images.
 *
 * Its own module rather than lines in computers.ts, because none of this is
 * about a computer: a template is a document the account owns, and a build is a
 * job that outlives the request that started it. Nothing here reads or writes
 * the session's selected computer.
 *
 * WHAT A MODEL HAS TO BE TOLD, and the reason these descriptions are long. Two
 * of these tools are irreversible in a way that is not obvious from their names.
 * `retire_template` without a version takes EVERY version, and a retired ref can
 * never be published again — so the description says both, in the tool the model
 * reads before deciding, rather than in a 409 it reads afterwards.
 */

const namespaceArg = {
  namespace: z
    .string()
    .describe(
      'The account id the template is published under. READ IT OFF A `ref`: every row of list_templates carries one shaped `<namespace>/<name>@<version>`, and the part before the slash is the namespace. Rows reading `system` are the templates we publish; anything else is your own account id. There is no separate `namespace` field on a template — the ref is where it lives.',
    ),
  name: z.string().describe('The template name, without the namespace or the version.'),
};

const versionArg = z
  .string()
  .optional()
  .describe(
    'A specific MAJOR.MINOR.PATCH. Send it or omit it entirely — an empty string is refused, because omitting it does not mean the same thing on both tools.',
  );

export const registerTemplates: Registrar = (server, session, opts) => {
  // What to call the thing that launches a template, when there IS one.
  //
  // `create_computer` is not registered under MANDALA_NO_LIFECYCLE, and a name
  // in a neighbouring tool's description is the same idea by a different route
  // as a tool in the list: the model reads it and tries it. The server
  // instructions were already parameterised on this; the descriptions were not.
  const launcher = opts.lifecycle ? 'create_computer' : 'whatever creates computers on this setup';
  server.registerTool(
    'get_template_schema',
    {
      title: 'Get the template document schema',
      description:
        'The JSON Schema for a `mandala/v1` template document — the declarative form a template is written in. Read this before writing one: it describes the ref, the image family, what the template is layered onto, and the shape a computer gets when a create names no numbers.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () =>
        json(await session.api.with(extra.signal).json('GET', P.TEMPLATE_SCHEMA)),
      ),
  );

  server.registerTool(
    'check_template',
    {
      title: 'Check a template document',
      description:
        'Check a document against the SCHEMA, without publishing it. Nothing is stored and no ref is claimed, so this is safe on a draft and safe to call repeatedly, and every problem comes back at once. Always check before publishing: a ref is immutable, so a document published with a mistake in it cannot be corrected under that version. WHAT IT CANNOT SEE: this reads the document alone and knows nothing about your account, so `valid: true` does not mean publish_template will succeed. Whether the namespace is yours, whether the family is yours, whether your plan may publish at all, and whether the ref is already taken or retired are all decided at publish time and can still refuse a document that checks out here.',
      inputSchema: {
        document: z
          .string()
          .describe('The document itself, as JSON or YAML — the file contents, not a wrapper.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ document }, extra) =>
      guarded(async () => {
        const body = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('POST', P.TEMPLATE_VALIDATE, {
            raw: P.templateDocument(document),
          });
        // `valid` READ AS A BOOLEAN, not for truthiness (adversarial review,
        // OPL-3835). `json<T>` is a cast and checks nothing at run time, so a
        // body answering `{"valid": "false"}` — a proxy stringifying, a field
        // that changes type — is truthy, and this tool then reported a document
        // the platform had just rejected as valid. The one answer a check tool
        // must never get wrong is "yes".
        if (typeof body.valid !== 'boolean') {
          return refused(
            'POST /templates/validate answered without a boolean `valid`, so this says NOTHING about the document — do not publish on the strength of it. Check it again.',
            body,
          );
        }
        // NOT `refused` for an invalid document. That is the answer to the
        // question this tool asks — the platform says so with a 200 — and
        // marking it isError would tell the model its request failed when what
        // it actually got is the list of problems it asked for.
        return body.valid
          ? said(
              'The document is valid — against the schema. Publishing can still refuse it for something only your account decides: the namespace, the family, your plan, or a ref already taken. `doc_digest` identifies the document and changes with anything that changes what it MEANS — a label included. Comments, key order, indentation and YAML-versus-JSON do not reach it: the digest is over the canonical re-marshalling of the parsed document, not over your file. `build_digest` covers only what decides the image, so comparing it against a previous check tells you whether an edit means a rebuild — but it is present ONLY for a document with no `spec.from`, and a document that declares build steps must have one, so a buildable document gets `build_digest_needs` instead, naming the parent whose digest would be required.',
              body,
            )
          : said(
              'The document is NOT valid. Every problem is listed — fix them all and check again rather than one at a time.',
              body,
            );
      }),
  );

  server.registerTool(
    'publish_template',
    {
      title: 'Publish a template document',
      description:
        `Store a document under a ref of your own, so ${launcher} can launch it by name. ` +
        'THE NAMESPACE IS YOUR ACCOUNT: `metadata.namespace` has to be your account id, and anything else is refused rather than rewritten — `system` included. A REF IS IMMUTABLE: publishing the identical document again succeeds and changes nothing, but publishing a DIFFERENT document under the same ref is refused, and the fix is to bump `metadata.version`. What counts as different is the digest, so a changed label is a change. Check the document first — a mistake published under a version can never be corrected under that version.',
      inputSchema: {
        document: z
          .string()
          .describe('The document itself, as JSON or YAML — the file contents, not a wrapper.'),
      },
      annotations: { openWorldHint: true },
    },
    ({ document }, extra) =>
      guarded(async () => {
        const body = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('POST', P.TEMPLATES, {
            raw: P.templateDocument(document),
          });
        // The ref, checked rather than interpolated. This is a WRITE, so a
        // malformed 2xx is the one answer that cannot be shrugged off:
        // `Published undefined` reads as a success and names a ref nothing can
        // resolve, and a model that responds by bumping `metadata.version` and
        // publishing again has claimed two refs for one document — neither of
        // which it can take back (adversarial review, OPL-3835).
        if (typeof body.ref !== 'string' || !body.ref.trim()) {
          return refused(
            'POST /templates answered without a `ref`, so this server cannot say what was stored. THE PUBLISH MAY HAVE SUCCEEDED — read the name with get_template before publishing again, because a ref is immutable and a second version claims a second ref.',
            body,
          );
        }
        // What it takes to LAUNCH the thing, rather than the flat "Launch it
        // with create_computer" this used to end on. That sentence contradicted
        // build_template's own description two tools down: a document declaring
        // `spec.build` names a family the fleet does not advertise, so following
        // this line led straight into a refusal the server already knew about
        // (adversarial review, OPL-3835). Publishing and being launchable are
        // different questions and this says so, without claiming to know which
        // of the two this document is — the store answers the first, and only
        // the document says whether it declares build steps.
        return said(
          `Published ${body.ref}. A published template is named by its ref and by nothing else, so its short name still means one of ours. ` +
            `WHETHER IT LAUNCHES depends on the document: pass the ref to ${launcher} as ` +
            '`template` if it layers onto a family the fleet ships, but one declaring `spec.build` steps names a family that has to be built first — that is build_template — and the fleet does not yet advertise a family it built rather than shipped, so a create naming such a ref is still refused.',
          body,
        );
      }),
  );

  server.registerTool(
    'get_template',
    {
      title: 'Read a template document',
      description:
        'One template as the document it was written as — the lineage, the build steps and the digest, which list_templates drops. Works for your own namespace and for `system`, so you can read what you are layering onto before writing a document of your own. Without `version` this is the newest, which is also what a create naming the unpinned `namespace/name` resolves to.',
      inputSchema: { ...namespaceArg, version: versionArg },
      annotations: { readOnlyHint: true },
    },
    ({ namespace, name, version }, extra) =>
      guarded(async () =>
        json(
          await session.api.with(extra.signal).json('GET', P.templateRef(namespace, name), {
            query: P.templateVersionQuery(version),
          }),
        ),
      ),
  );

  server.registerTool(
    'retire_template',
    {
      title: 'Retire a template you published',
      description:
        'Stop a template resolving, and give its row back against your ceiling. WITHOUT `version` THIS RETIRES EVERY VERSION OF THE NAME — that is what retiring a template means here, and it is deliberately not get_template\'s "the newest". Pass `version` to take exactly one. THIS CANNOT BE UNDONE: a retired ref is refused for ever, identical bytes included, so the version you retire can never be published again — publish the next version instead. Computers are NOT affected: a computer is built from the image the ref resolved to and holds no reference to the document, so anything already running, stopped or suspended keeps working. What a retire breaks is resolution — a NEW create naming the ref is refused. Say what it costs before you call it.',
      inputSchema: {
        ...namespaceArg,
        version: versionArg,
        // The same gate delete_computer, restore_snapshot and delete_snapshot
        // take. This is strictly LESS recoverable than any of them — a deleted
        // snapshot's name can be used again, a retired ref never can — and it
        // was the only unrecoverable tool here without one. `destructiveHint`
        // delegates the question to the host application; this asks it here.
        confirm: z
          .literal(true)
          .describe(
            'Must be true. Retiring cannot be undone, and without `version` it takes every version of the name.',
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ namespace, name, version }, extra) =>
      guarded(async () => {
        // `send` rather than `json`, because `json` raises on an empty body and
        // a DELETE answering 204 is the ordinary REST shape — the same reason
        // `kill_exec` gives one module over. A transport error here would be
        // this server reporting the platform's silence as its own failure, on
        // the one call in this file that cannot be undone: a model told the
        // retire failed is a model that repeats a call the refusal below
        // explicitly warns it not to repeat.
        const body = await session.api
          .with(extra.signal)
          .send<Record<string, unknown>>('DELETE', P.templateRef(namespace, name), {
            query: P.templateVersionQuery(version),
          });
        // The one unreadable response in this module that must not be smoothed
        // over. `Array.isArray(body.retired) ? … : []` turned a body this
        // server could not read into "Retired 0 version(s)" — a confident report
        // that nothing happened, about an irreversible DELETE the platform
        // answered 2xx to and which may well have just taken every version of
        // the name (adversarial review, OPL-3835).
        if (
          body === null ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          !Array.isArray(body.retired) ||
          !Array.isArray(body.versions)
        ) {
          return refused(
            'The retire answered without the `retired` and `versions` lists, so this server cannot say what went. THE RETIRE MAY HAVE HAPPENED, and it cannot be undone — read the name with get_template before concluding anything, and do not repeat the call on the assumption that nothing was taken.',
            body,
          );
        }
        // And the ELEMENTS checked, not only that the lists are lists. These two
        // are the sentence the comment above calls the one that must not be
        // wrong about an irreversible DELETE, and `join` over a row that is an
        // object enumerates the versions that went as `[object Object]` — the
        // same sentence-level failure the account totals below were type-checked
        // for (OPL-4314), in the clause a caller actually needs after a call it
        // cannot repeat. The counts stay honest by counting what arrived.
        const readable = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
        const gone = body.retired.filter(readable);
        const left = body.versions.filter(readable);
        const unreadable = body.retired.length - gone.length + (body.versions.length - left.length);
        const dropped = unreadable
          ? ` ${unreadable} version identifier${unreadable === 1 ? '' : 's'} the platform sent ${unreadable === 1 ? 'was' : 'were'} not readable and ${unreadable === 1 ? 'is' : 'are'} not named above — the attached JSON has them as they arrived.`
          : '';
        const templates = body.templates;
        const claimed = body.refs_claimed;
        // The lists above are the sentence that must not be wrong about an
        // irreversible DELETE. The account totals are detail: interpolating
        // them untyped turned a 2xx that had the lists but omitted the
        // counters into "undefined template(s)" / "undefined ref(s)" in the
        // prose a model reads first (adversarial review, OPL-4314). Omit the
        // clause rather than invent a number; the JSON is still attached.
        const totals =
          typeof templates === 'number' &&
          Number.isFinite(templates) &&
          typeof claimed === 'number' &&
          Number.isFinite(claimed)
            ? ` The account now holds ${templates} template(s), and has claimed ${claimed} ref(s) — that second number does not go down, because a retired ref still counts.`
            : '';
        // Counted off what ARRIVED and enumerated off what was readable. A
        // retire the platform reported took three versions took three whether
        // or not this server could read all three names, and counting the
        // filtered list would under-report an irreversible DELETE.
        const retiredCount = body.retired.length;
        const remaining = body.versions.length;
        // The survivors are counted and enumerated on the same footing, for the
        // same reason. Naming only the readable ones while agreeing the verb
        // with the full count reads "1.1.0 are still published" and names one
        // version where two survive — in the clause that has to be right about
        // what the DELETE did NOT take.
        const unnamed = remaining - left.length;
        const survivors = left.length
          ? `${left.join(', ')}${unnamed > 0 ? ` and ${unnamed} more` : ''}`
          : `${remaining} other version(s)`;
        return said(
          `Retired ${retiredCount} version(s)${gone.length ? `: ${gone.join(', ')}` : ''}. ` +
            (remaining
              ? `${survivors} ${remaining === 1 ? 'is' : 'are'} still published under this name.`
              : 'Nothing is published under this name any more.') +
            totals +
            dropped,
          body,
        );
      }),
  );

  server.registerTool(
    'build_template',
    {
      title: 'Compile a template document into an image',
      description:
        'Compile a document that declares `spec.build` steps into a golden image. Returns IMMEDIATELY with a job — a build takes minutes, an agent image roughly fifteen — and watch_build is how you follow it. THE NAMESPACE AND THE FAMILY BOTH HAVE TO BE YOURS: `spec.family` is what the image is called on a hypervisor, in a directory shared with every computer on that machine, so a build may only write into `golden-<your account id>` or that and a `-` and a name of your choosing. A refusal saying a host is busy is not a problem with your document — one build runs per hypervisor — and is worth retrying. What you build is NOT launchable yet: the fleet does not advertise a family it built rather than shipped, so a create naming such a ref is still refused.',
      inputSchema: {
        document: z
          .string()
          .describe('The document itself, as JSON or YAML — the file contents, not a wrapper.'),
        no_reuse: z
          .boolean()
          .optional()
          .describe(
            "Build again even when an image already carries this document's build digest. Identical documents normally share an image, which is what makes a repeated build cheap — so leave this off unless you specifically want the work done twice.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    ({ document, no_reuse }, extra) =>
      guarded(async () => {
        const body = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('POST', P.BUILDS, {
            raw: P.templateDocument(document),
            query: P.buildQuery(no_reuse),
          });
        // The id, checked: it is the only handle on a job that outlives this
        // request, and `Build undefined started` sends a model to watch_build
        // with a build_id it cannot have (adversarial review, OPL-3835).
        if (typeof body.id !== 'string' || !body.id.trim()) {
          return refused(
            'POST /builds answered without an `id`, so there is no handle to follow this build with. THE BUILD MAY HAVE STARTED — call list_builds to find it rather than building again, since a build is minutes of work on a hypervisor that runs one at a time.',
            body,
          );
        }
        // The ref is named only when the platform sent one. Unchecked, a 2xx
        // without it read `Build bld-1 started for undefined` — the same
        // sentence-level failure the `id` guard above was added for
        // (OPL-3835), and the one publish_template already guards its own ref
        // against. The build handle is the checked `id` either way, so a
        // missing ref costs nothing but the clause that names the document.
        const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref : undefined;
        return said(
          `Build ${body.id} started${ref ? ` for ${ref}` : ''}. It is not finished — call watch_build with that id, or get_build to check once.`,
          body,
        );
      }),
  );

  server.registerTool(
    'list_builds',
    {
      title: 'List builds',
      description:
        'Every build this account has started that the fleet still holds a record of, newest first. A build lives on the hypervisor that ran it, so this asks all of them — and WITHOUT allow_partial, one that cannot be reached makes the platform refuse rather than answer short, so an empty or small list is the truth rather than an outage. Pass allow_partial and that stops being so: you get the short answer, opening with an INCOMPLETE line, and nothing else in the result says how much is missing.',
      inputSchema: {
        allow_partial: z
          .boolean()
          .optional()
          .describe(
            'Accept a short list when a hypervisor cannot be reached, instead of the 503 the platform answers by default. Nothing in the rows will say the answer was partial — a short build list has no marker in it at all, so the INCOMPLETE line is the whole of the evidence. Read it before concluding anything about what this account has built.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    ({ allow_partial }, extra) =>
      guarded(async () => {
        // `listing`, not `json` (OPL-3840). This route fans out, and like every
        // other fan-out on the v1 surface it FAILS CLOSED: `forward` in
        // lib/surface turns a response carrying X-GC-Incomplete into a 503. So
        // without the flag a short list still cannot arrive — but WITH it one
        // can, and then the header is the only news there is.
        //
        // The platform read `allow_partial` here from the day this route
        // started fanning out and did not DOCUMENT it until OPL-3840, which is
        // why this tool sent nothing and why the comment that stood here said a
        // short list could not arrive at all. What that cost was a build
        // listing being strictly less available than a computer listing.
        const { items, incomplete } = await session.api
          .with(extra.signal)
          .listing<unknown>(P.BUILDS, {
            query: { allow_partial: allow_partial ? 1 : undefined },
          });
        if (!Array.isArray(items)) {
          const got =
            items === undefined ? 'no body at all' : items === null ? 'null' : typeof items;
          return refused(
            `GET /builds answered with ${got}, not a list of builds. This is not an empty list — do not conclude anything about what exists from it.`,
            items,
          );
        }
        // Each ROW checked too, which list_computers and list_snapshots do and
        // this one did not (adversarial review, OPL-3835). `Array.isArray`
        // alone passed `[null]` and `["bad projection"]` through as an
        // inventory, and a model reading a build row that is a string gets
        // `undefined` for every field it asks about with nothing saying the row
        // was never a build.
        const malformed = items.filter(
          (item) => item === null || typeof item !== 'object' || Array.isArray(item),
        ).length;
        const builds = items.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        );
        const warning =
          incompleteWarning('builds', incomplete) +
          (malformed
            ? `WARNING: ignored ${malformed} malformed build entr${malformed === 1 ? 'y' : 'ies'} from the platform.\n\n`
            : '');
        if (!builds.length && malformed) {
          return refused(
            `${warning}No valid builds remained. This is not an empty build list — do not conclude anything about what exists from it.`,
            items,
          );
        }
        // `json`, with nothing to say, ONLY when there is nothing to say. The
        // fast path used to be `if (!malformed) return json(builds)`, which
        // returns bare data — so a warning added above it would have been
        // dropped on exactly the answers that most needed it.
        if (!warning) return json(builds);
        // An empty answer from a fleet that could not all be asked is not an
        // empty account, and the two are told apart here rather than left to
        // the model: with no rows and no stub rows there is nothing at all in
        // the payload to suggest a hypervisor is away.
        if (!builds.length) {
          return said(
            `${warning}No builds came back from the part of the fleet that answered. This is NOT "no builds" — retry in a moment for a complete answer.`,
          );
        }
        return said(`${warning}${builds.length} build(s).`, builds);
      }),
  );

  server.registerTool(
    'get_build',
    {
      title: 'Get a build',
      description:
        'What became of one build, which template it was for, and which step it is on. Reads once and returns; watch_build is what follows a running one. It stays readable after the build has finished, so this is also how you find out which step failed on a build nobody was watching.',
      inputSchema: { build_id: z.string().describe('The id build_template returned.') },
      annotations: { readOnlyHint: true },
    },
    ({ build_id }, extra) =>
      guarded(async () => {
        // BOTH routes, because neither answer contains the other. The two
        // projectors in the platform's lib/projection overlap only on `id`,
        // `status` and `error`: publicTemplateBuild carries `ref` and both
        // timestamps, publicBuildProgress carries the phase and the steps. This
        // tool was pinned as "progress is a superset", which was simply untrue —
        // read that way it could not tell a model WHICH TEMPLATE a build was for
        // (/code-review, OPL-3835).
        //
        // One tool rather than two, still. An MCP client pays for every tool in
        // the model's context before any is called, and "get_build" and
        // "get_build_progress" differing by a word is how a model picks the
        // wrong one. Two requests inside one call is the cheaper trade.
        const api = session.api.with(extra.signal);
        // allSettled, not all: the two legs are INDEPENDENT fleet walks — the job
        // read forwards through hvAny, the progress read is a local handler that
        // does its own — so one can fail while the other succeeds, and
        // Promise.all threw the good half away. Progress is the half a model
        // calls this for after a build nobody watched (the status, the phase, the
        // failed step), so it is required and the job read is best effort: a
        // fleet hiccup costs `ref` and the timestamps rather than the whole
        // answer (/code-review, OPL-3835).
        const [jobRead, progressRead] = await Promise.allSettled([
          api.json<Record<string, unknown>>('GET', P.build(build_id)),
          api.json<Record<string, unknown>>('GET', P.buildAction(build_id, 'progress')),
        ]);
        if (progressRead.status === 'rejected') throw progressRead.reason;
        const progress = progressRead.value;
        // Best effort means AVAILABILITY, not everything (adversarial review,
        // OPL-3835). `status === 'fulfilled' ? … : undefined` swallowed the
        // rejection whatever it was, so a 401, a 403, a 404 or the caller's own
        // cancellation came back as a successful partial answer with a note
        // about the fleet — the shape a caller reading `isError` to decide
        // whether it may act on the result cannot see through. Only the
        // statuses that clear on their own are worth losing `ref` and the
        // timestamps for; the rest are decisions, and a decision suppressed is a
        // decision the model never learns about.
        //
        // `isTransientForPoll` rather than a list here, because it is the same
        // question the wait loops in computers.ts ask and this is the same kind
        // of call: a read, where replaying costs nothing, so a 52x during an
        // outage counts as a hiccup too. It says no to CancelledError, which is
        // the one that must never be suppressed — nobody is waiting for this
        // answer.
        if (jobRead.status === 'rejected' && !isTransientForPoll(jobRead.reason)) {
          throw jobRead.reason;
        }
        let job = jobRead.status === 'fulfilled' ? jobRead.value : undefined;
        // The two reads land at different instants, so a build that finishes
        // between them would otherwise merge into a record contradicting itself.
        // Progress owns `status` and `done` because that is what a model
        // branches on.
        //
        // BOTH ORDERS, and the first fix only had one of them (adversarial
        // review, OPL-3835). Job-then-finish-then-progress gives `running`
        // beside a populated `finished_at`, which the delete below handles.
        // Progress-then-finish-then-job gives the mirror image — `succeeded`,
        // `done: true`, and no finish time at all, a build that completed
        // without ever ending — and that one cannot be fixed by dropping a
        // field, because the field that is missing is the true one. So the job
        // record is read again: one extra request, only inside the race window,
        // and by the time it is made the record it asks for has settled.
        if (job && progress.done === true && job.finished_at === undefined) {
          try {
            job = await api.json<Record<string, unknown>>('GET', P.build(build_id));
          } catch (err) {
            // The first read already succeeded, so a second failure costs the
            // reconciliation rather than the call. Except a cancellation, which
            // means there is nobody left to answer.
            if (err instanceof CancelledError) throw err;
          }
        }
        const merged: Record<string, unknown> = { ...job, ...progress };
        if (job && progress.done !== true) delete merged.finished_at;
        if (!job) {
          merged.partial = 'the build record could not be read; ref and timestamps are missing';
        }
        return json(merged);
      }),
  );

  server.registerTool(
    'watch_build',
    {
      title: 'Watch a build until it finishes',
      description:
        "Follow a build to its end and report what happened. Streams the platform's own progress — each event is sent only when something actually moved — and logs each one as it arrives, so a long build is visibly alive rather than indistinguishable from a hang. A build that FAILED is a normal answer here, not an error: read `status` and the failed step. Attaching to a build that has already finished is fine and returns immediately.",
      inputSchema: { build_id: z.string().describe('The id build_template returned.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ build_id }, extra) =>
      guarded(async () => {
        let last: Record<string, unknown> | undefined;
        // The token the CLIENT sends when it wants progress. Without one there
        // is nothing to address a progress notification to, and this falls back
        // to logging alone.
        const progressToken = extra._meta?.progressToken;
        let sent = 0;
        // Whether a well-formed `done` actually arrived, as against whether any
        // event did (adversarial review, OPL-3835). Without it a stream that
        // reached EOF after a `progress` — a proxy cutting it, a host going away
        // — fell out of the loop with `last` set and was reported through
        // `said(...)` as a finished build whose status happened to be `running`.
        // A tool whose whole promise is "watch until it finishes" must not
        // answer that way when it did not.
        let sawDone = false;
        for await (const ev of session.api.sse('GET', P.buildAction(build_id, 'events'), {
          signal: extra.signal,
        })) {
          if (ev.event === 'error') {
            // The STREAM failed, not the build. Said as such, because a model
            // told "the build failed" would go and rewrite a document that is
            // fine — and the build is very likely still running.
            return refused(
              `The event stream for ${build_id} ended. This says nothing about the build itself, which is probably still running — call get_build to find out.`,
              ev.data,
            );
          }
          if (ev.event !== 'progress' && ev.event !== 'done') continue;
          if (!isRecord(ev.data)) continue;
          // An event about ANOTHER build is not this build's news. The stream is
          // per-build so this should never arrive, but `id` is one of the three
          // fields both of the platform's build projectors carry, so checking it
          // is free — and a misrouted frame reported as this build's outcome is
          // the kind of wrong answer nobody could spot afterwards.
          if (typeof ev.data.id === 'string' && ev.data.id !== build_id) continue;
          if (ev.event === 'done') {
            // A `done` is terminal only if it SAYS SO (adversarial review,
            // OPL-3835). `isRecord` alone called `event: done\ndata: {}`
            // well-formed, set the flag, and answered `Build bld-1 undefined.`;
            // it accepted `{status: "running", done: false}` as a completed
            // watch too, which is the very misreport `sawDone` was added to
            // prevent, reached from the other side.
            //
            // `done: true` and a status that is a non-empty string, rather than
            // a list of the statuses a build may end in. The platform owns that
            // vocabulary — `succeeded` and `failed` are the two this server has
            // seen and a cancelled build would be a third — so an enum here
            // would refuse a real outcome the first time one was added, while
            // these two facts are exactly what the sentence at the end reads.
            if (ev.data.done !== true || typeof ev.data.status !== 'string' || !ev.data.status) {
              continue;
            }
            sawDone = true;
          }
          last = ev.data;
          const line =
            `${ev.data.phase ?? '?'} ${ev.data.step ?? 0}/${ev.data.of ?? 0} ${ev.data.note ?? ''}`.trim();
          // A PROGRESS notification, not only a logging one, because it is the
          // only frame that CAN hold a long request open: `_onprogress` in the
          // SDK's shared/protocol.js resets a pending request's timer, and
          // `notifications/message` — what sendLoggingMessage emits — never
          // touches it.
          //
          // IT IS NOT SUFFICIENT ON ITS OWN, and the first version of this
          // comment claimed it was (/code-review, OPL-3835). protocol.js reads
          // `options?.resetTimeoutOnProgress ?? false`, so the reset happens only
          // for a client that asked for it when it made the call. One that mints
          // a progressToken and leaves that option alone is still cancelled at
          // the 60s default on a build that takes fifteen minutes. What this does
          // is make the keepalive AVAILABLE — without it no client could hold the
          // request open at all; with it, one that opts in can. The rest is the
          // client's to set, and get_build is the answer for a client that cannot.
          if (progressToken !== undefined) {
            sent += 1;
            await extra
              .sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  // `of` is the step count, which is 0 until the build reaches
                  // its first step — sent only once it means something, since a
                  // total of 0 renders as a finished bar.
                  // The event COUNT, not the step index. The SDK's ProgressSchema
                  // asks that this increase every time, and `step` is 0 for every
                  // pre-step phase — planning, staging, the multi-gigabyte base
                  // copy — and stays 0 for the whole life of a document with no
                  // build steps, so successive frames repeated `progress: 0`.
                  progress: sent,
                  message: line,
                },
              })
              .catch(() => {});
          }
          // Kept as well: this is what a person watching a terminal sees, and it
          // is the only channel when the client asked for no progress.
          await server.server.sendLoggingMessage({ level: 'info', data: line }).catch(() => {});
          if (ev.event === 'done') break;
        }
        // `|| !last` as well, which is unreachable — a `done` sets both in the
        // same breath — and is what lets the compiler narrow `last` below.
        if (!sawDone || !last) {
          // Both halves of the same failure, and both are refusals: the stream
          // is the platform's contract that `done` is the last event, so one
          // that ends without a well-formed one has been CUT rather than
          // completed. Saying so points the model at the poll that can still
          // answer, instead of letting it act on a status that was true
          // whenever the connection died.
          return refused(
            last
              ? `The event stream for ${build_id} ended before the build did. This is the stream failing, not the build — it is probably still running. Call get_build for where it has got to.`
              : `The event stream for ${build_id} ended without sending anything. Call get_build for the outcome.`,
            last,
          );
        }
        // Not `refused` for a failed build. It is an outcome with a remedy —
        // the failed step names what to fix — and marking it isError would tell
        // the model its request failed rather than that its document did.
        const failed = Array.isArray(last.steps)
          ? (last.steps as Record<string, unknown>[]).find((s) => s?.status === 'failed')
          : undefined;
        return said(
          last.status === 'succeeded'
            ? `Build ${build_id} succeeded. The image exists, but the fleet does not yet advertise a family it built rather than shipped, so a create naming this ref is still refused.`
            : `Build ${build_id} ${last.status}.` +
                (failed
                  ? ` Step ${failed.n} (${failed.kind}: ${failed.label}) is the one that failed.`
                  : '') +
                (last.error ? ` ${last.error}` : ''),
          last,
        );
      }),
  );
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
