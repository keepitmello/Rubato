// Rubato: the agy instances on one isolated Google login (RUBATO_LOCAL_AGY_LOGIN) share one
// profile and the sign-in stored in it, but T3 keeps a sign-in state per instance. Without this,
// one instance could say signed out while another on the same login says signed in, and signing
// in again on one left the other signed out. So checks of one login run one at a time, a passing
// check or a sign-in has the login's signed-out instances check again, and the stored sign-in that
// lapses after an idle hour (only a running agy renews it) is renewed once for the whole login.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface AgyLoginMember {
  /** The instance's own login check (its model refresh): true when it ended signed in. */
  readonly check: Effect.Effect<boolean>;
  /** Whether the instance last found the login signed out. */
  readonly signedOut: Effect.Effect<boolean>;
}

interface Login {
  readonly checks: Semaphore.Semaphore;
  readonly renewals: Semaphore.Semaphore;
  readonly members: Map<string, AgyLoginMember>;
  renewedAt: number;
}

/** A failed renewal (no network, a revoked sign-in) waits this long before the next one. */
export const AGY_LOGIN_RENEW_INTERVAL_MS = 10 * 60_000;

const logins = new Map<string, Login>();

/** Adds the instance to its login's profile until the scope closes. */
export const joinAgyLogin = (profileDirectory: string, instanceId: string, member: AgyLoginMember) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let login = logins.get(profileDirectory);
      if (!login) {
        login = {
          checks: Semaphore.makeUnsafe(1),
          renewals: Semaphore.makeUnsafe(1),
          members: new Map(),
          renewedAt: Number.NEGATIVE_INFINITY,
        };
        logins.set(profileDirectory, login);
      }
      login.members.set(instanceId, member);
    }),
    () =>
      Effect.sync(() => {
        const login = logins.get(profileDirectory);
        if (login?.members.get(instanceId) !== member) return;
        login.members.delete(instanceId);
        if (login.members.size === 0) logins.delete(profileDirectory);
      }),
  );

/** The login's other instances that found it signed out check again, one at a time. */
export const recheckAgyLoginSiblings = Effect.fn("recheckAgyLoginSiblings")(function* (
  profileDirectory: string,
  instanceId: string,
) {
  const login = logins.get(profileDirectory);
  if (!login) return;
  for (const [id, member] of [...login.members]) {
    if (id === instanceId || !(yield* member.signedOut)) continue;
    yield* login.checks.withPermits(1)(member.check);
  }
});

/** One instance's login check, after any other check of the login; a pass rechecks signed-out siblings. */
export const checkAgyLogin = Effect.fn("checkAgyLogin")(function* (
  profileDirectory: string,
  instanceId: string,
) {
  const login = logins.get(profileDirectory);
  const member = login?.members.get(instanceId);
  if (!login || !member) return false;
  const signedIn = yield* login.checks.withPermits(1)(member.check);
  if (signedIn) yield* recheckAgyLoginSiblings(profileDirectory, instanceId);
  return signedIn;
});

/**
 * Renews the login's stored sign-in through this instance's check. Callers that arrive during a
 * renewal wait for it, and the login renews at most once per interval.
 */
export const renewAgyLogin = Effect.fn("renewAgyLogin")(function* (
  profileDirectory: string,
  instanceId: string,
) {
  const login = logins.get(profileDirectory);
  if (!login) return;
  yield* login.renewals.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - login.renewedAt < AGY_LOGIN_RENEW_INTERVAL_MS) return;
      login.renewedAt = now;
      yield* checkAgyLogin(profileDirectory, instanceId);
    }),
  );
});
