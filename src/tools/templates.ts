import { z } from 'zod';
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
      'The account id the template is published under. Your own templates are in your account id, which is the `namespace` on every row of list_templates that is yours; `system` is ours.',
    ),
  name: z.string().describe('The template name, without the namespace or the version.'),
};

const versionArg = z
  .string()
  .optional()
  .describe(
    'A specific MAJOR.MINOR.PATCH. Send it or omit it entirely — an empty string is refused, because omitting it does not mean the same thing on both tools.',
  );

export const registerTemplates: Registrar = (server, session) => {
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
        'Check a document against the schema and the rules a publish applies, WITHOUT publishing it. Nothing is stored and no ref is claimed, so this is safe on a draft and safe to call repeatedly — and it reports every problem at once, where publish_template stops at the first thing that blocks it. Always check before publishing: a ref is immutable, so a document published with a mistake in it cannot be corrected under the same version.',
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
        // NOT `refused` for an invalid document. That is the answer to the
        // question this tool asks — the platform says so with a 200 — and
        // marking it isError would tell the model its request failed when what
        // it actually got is the list of problems it asked for.
        return body.valid
          ? said(
              'The document is valid. `doc_digest` identifies it; `build_digest` covers only what decides the image, so comparing it against a previous check tells you whether an edit means a rebuild.',
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
        'Store a document under a ref of your own, so create_computer can launch it by name. THE NAMESPACE IS YOUR ACCOUNT: `metadata.namespace` has to be your account id, and anything else is refused rather than rewritten — `system` included. A REF IS IMMUTABLE: publishing the identical document again succeeds and changes nothing, but publishing a DIFFERENT document under the same ref is refused, and the fix is to bump `metadata.version`. What counts as different is the digest, so a changed label is a change. Check the document first — a mistake published under a version can never be corrected under that version.',
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
        return said(
          `Published ${body.ref}. Launch it with create_computer, passing that ref as \`template\` — a published template is named by its ref and by nothing else, so its short name still means one of ours.`,
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
      inputSchema: { ...namespaceArg, version: versionArg },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ namespace, name, version }, extra) =>
      guarded(async () => {
        const body = await session.api
          .with(extra.signal)
          .json<Record<string, unknown>>('DELETE', P.templateRef(namespace, name), {
            query: P.templateVersionQuery(version),
          });
        const gone = Array.isArray(body.retired) ? body.retired : [];
        const left = Array.isArray(body.versions) ? body.versions : [];
        return said(
          `Retired ${gone.length} version(s): ${gone.join(', ')}. ` +
            (left.length
              ? `${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} still published under this name.`
              : 'Nothing is published under this name any more.') +
            ` The account now holds ${body.templates} template(s), and has claimed ${body.refs_claimed} ref(s) — that second number does not go down, because a retired ref still counts.`,
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
        return said(
          `Build ${body.id} started for ${body.ref}. It is not finished — call watch_build with that id, or get_build to check once.`,
          body,
        );
      }),
  );

  server.registerTool(
    'list_builds',
    {
      title: 'List builds',
      description:
        'Every build this account has started that the fleet still holds a record of, newest first. A build lives on the hypervisor that ran it, so this asks all of them — if one cannot be reached the answer says it is short rather than pretending the missing builds never existed.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    (_args, extra) =>
      guarded(async () => {
        // `listing`, not `json`, because this route fans out across the fleet
        // and does NOT fail closed the way the computer and snapshot listings do
        // (adversarial review, OPL-3835). lib/hvproxy answers a short build list
        // with a 200 and X-GC-Incomplete — there is no `allow_partial` to opt
        // into and no 503 to stop you — so a client reading the body alone
        // reports a hypervisor being away as an account with fewer builds. A
        // model that cannot see a running build starts another one.
        const { items, incomplete } = await session.api
          .with(extra.signal)
          .listing<Record<string, unknown>[]>(P.BUILDS);
        if (!Array.isArray(items)) {
          const got = items === undefined ? 'no body at all' : typeof items;
          return refused(
            `GET /builds answered with ${got}, not a list of builds. This is not an empty list — do not conclude anything about what exists from it.`,
            items,
          );
        }
        const warning = incompleteWarning('builds', incomplete);
        return warning ? said(warning.trim(), items) : json(items);
      }),
  );

  server.registerTool(
    'get_build',
    {
      title: 'Get a build',
      description:
        'What became of one build, and which step it is on. Reads once and returns; watch_build is what follows a running one. It stays readable after the build has finished, so this is also how you find out which step failed on a build nobody was watching.',
      inputSchema: { build_id: z.string().describe('The id build_template returned.') },
      annotations: { readOnlyHint: true },
    },
    ({ build_id }, extra) =>
      guarded(async () =>
        json(await session.api.with(extra.signal).json('GET', P.buildAction(build_id, 'progress'))),
      ),
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
          if (ev.event === 'done') sawDone = true;
          last = ev.data;
          await server.server
            .sendLoggingMessage({
              level: 'info',
              data: `${ev.data.phase ?? '?'} ${ev.data.step ?? 0}/${ev.data.of ?? 0} ${ev.data.note ?? ''}`.trim(),
            })
            .catch(() => {});
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
