import type { Api } from './api.js';
import * as P from './paths.js';

/**
 * Whether the API key this client runs with expires.
 *
 * Such a key is never given a computer's desktop credentials, which belong to
 * the computer and would outlive it, and the event stream's URL is one of them.
 * So on a running computer with none, this is the one explanation that does not
 * clear, and the only one the platform lets a client tell apart from a host that
 * did not supply them. `whoami` answers any credential, a key limited to
 * computers included.
 *
 * `true` or `false` when the platform said; `undefined` when it did not, which
 * says nothing either way. A credential with no key record (one that is not an
 * API key) does not expire as far as this question goes.
 */
export async function keyExpires(api: Api, signal?: AbortSignal): Promise<boolean | undefined> {
  const deadline = AbortSignal.timeout(WHOAMI_TIMEOUT_MS);
  try {
    const who = await api
      .with(signal ? AbortSignal.any([signal, deadline]) : deadline)
      .json<unknown>('GET', P.WHOAMI);
    if (who === null || typeof who !== 'object' || !('key' in who)) return undefined;
    const key = who.key;
    if (key === null) return false;
    if (typeof key !== 'object' || !('id' in key)) return undefined;
    const at = (key as { expires_at?: unknown }).expires_at;
    if (typeof at === 'string' && at) return true;
    return at === null ? false : undefined;
  } catch {
    return undefined;
  }
}

/** A short deadline: this explains a refusal, and must not hold one up. */
const WHOAMI_TIMEOUT_MS = 5_000;

/** Why an expiring key has no event stream, for the wait and event tools. */
export const EXPIRING_KEY_NO_EVENTS =
  'this API key expires, and a key that expires is not given a computer’s event stream, because the credential in it would outlive the key. Waiting or calling again does not change this. Use an API key without an expiry for wait_for_event, poll_events and wait_for_file_change; screenshot and list_windows still work with this one.';

/** Why an expiring key has no desktop link, for get_desktop_url. */
export const EXPIRING_KEY_NO_DESKTOP =
  'this API key expires, and a key that expires is not given a computer’s desktop credentials, because they would outlive the key. The computer is not at fault, and calling again does not change this. Use an API key without an expiry.';
