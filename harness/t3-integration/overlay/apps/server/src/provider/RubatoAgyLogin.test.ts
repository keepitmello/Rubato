import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  checkAgyLogin,
  joinAgyLogin,
  recheckAgyLoginSiblings,
  renewAgyLogin,
} from "./RubatoAgyLogin.ts";

/** An instance whose checks are counted and end signed in or not, as `passes` says at the time. */
const member = (state: { passes: boolean; signedOut: boolean }) => {
  const counter = { checks: 0 };
  return {
    counter,
    member: {
      check: Effect.sync(() => {
        counter.checks += 1;
        state.signedOut = !state.passes;
        return state.passes;
      }),
      signedOut: Effect.sync(() => state.signedOut),
    },
  };
};

it.effect("a check that passes has the login's signed-out agents check again, and only those", () =>
  Effect.gen(function* () {
    const profile = "/profiles/pass";
    const lead = member({ passes: true, signedOut: false });
    const helenaState = { passes: true, signedOut: true };
    const helena = member(helenaState);
    const other = member({ passes: true, signedOut: false });
    yield* joinAgyLogin(profile, "lead", lead.member);
    yield* joinAgyLogin(profile, "helena", helena.member);
    yield* joinAgyLogin(profile, "other", other.member);

    expect(yield* checkAgyLogin(profile, "lead")).toBe(true);
    expect([lead.counter.checks, helena.counter.checks, other.counter.checks]).toEqual([1, 1, 0]);
    expect(helenaState.signedOut).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("a check that fails leaves the other agents alone", () =>
  Effect.gen(function* () {
    const profile = "/profiles/fail";
    const lead = member({ passes: false, signedOut: false });
    const helena = member({ passes: true, signedOut: true });
    yield* joinAgyLogin(profile, "lead", lead.member);
    yield* joinAgyLogin(profile, "helena", helena.member);

    expect(yield* checkAgyLogin(profile, "lead")).toBe(false);
    expect(helena.counter.checks).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("a sign-in on one agent rechecks the others that found the login signed out", () =>
  Effect.gen(function* () {
    const profile = "/profiles/sign-in";
    const helena = member({ passes: true, signedOut: true });
    yield* joinAgyLogin(profile, "lead", member({ passes: true, signedOut: false }).member);
    yield* joinAgyLogin(profile, "helena", helena.member);

    yield* recheckAgyLoginSiblings(profile, "lead");
    expect(helena.counter.checks).toBe(1);
    // Signed in now, so a second sign-in does not check it again.
    yield* recheckAgyLoginSiblings(profile, "lead");
    expect(helena.counter.checks).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("checks of one login run one at a time", () =>
  Effect.gen(function* () {
    const profile = "/profiles/serial";
    const release = yield* Deferred.make<void>();
    const order: Array<string> = [];
    const slow = (name: string, wait: boolean) => ({
      check: Effect.gen(function* () {
        order.push(`${name} start`);
        if (wait) yield* Deferred.await(release);
        order.push(`${name} end`);
        return true;
      }),
      signedOut: Effect.succeed(false),
    });
    yield* joinAgyLogin(profile, "lead", slow("lead", true));
    yield* joinAgyLogin(profile, "helena", slow("helena", false));

    const lead = yield* checkAgyLogin(profile, "lead").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const helena = yield* checkAgyLogin(profile, "helena").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(order).toEqual(["lead start"]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(lead);
    yield* Fiber.join(helena);
    expect(order).toEqual(["lead start", "lead end", "helena start", "helena end"]);
  }).pipe(Effect.scoped),
);

it.effect("the login renews its stored sign-in once for every agent, then waits ten minutes", () =>
  Effect.gen(function* () {
    const profile = "/profiles/renew";
    const lead = member({ passes: true, signedOut: false });
    const helena = member({ passes: true, signedOut: false });
    yield* joinAgyLogin(profile, "lead", lead.member);
    yield* joinAgyLogin(profile, "helena", helena.member);

    yield* Effect.all([renewAgyLogin(profile, "lead"), renewAgyLogin(profile, "helena")], {
      concurrency: "unbounded",
    });
    expect(lead.counter.checks + helena.counter.checks).toBe(1);

    yield* TestClock.adjust("9 minutes");
    yield* renewAgyLogin(profile, "helena");
    expect(lead.counter.checks + helena.counter.checks).toBe(1);

    yield* TestClock.adjust("1 minute");
    yield* renewAgyLogin(profile, "helena");
    expect(helena.counter.checks).toBeGreaterThan(0);
    expect(lead.counter.checks + helena.counter.checks).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect("an agent leaves its login when its instance closes", () =>
  Effect.gen(function* () {
    const profile = "/profiles/leave";
    const lead = member({ passes: true, signedOut: false });
    const scope = yield* Scope.make();
    yield* joinAgyLogin(profile, "lead", lead.member).pipe(Scope.provide(scope));
    yield* Scope.close(scope, Exit.void);
    expect(yield* checkAgyLogin(profile, "lead")).toBe(false);
    expect(lead.counter.checks).toBe(0);
  }),
);
