import * as NetService from "@t3tools/shared/Net";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeRootHolder,
  readTailscaleServeRoutesTo,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";

/** The root Serve route the server publishes: its loopback port and how Serve dials it. */
export interface TailscaleServeRootRoute {
  readonly localPort: number;
  /** The bind host as a URL host, bracketed for IPv6. */
  readonly urlHost: string;
  /** The bind host without brackets. */
  readonly localHost: string;
  readonly servePort: number;
}

/**
 * How often a running server re-checks the root of its Serve port. After a reboot the Mac
 * Tailscale app can come up disconnected, so the start's one `tailscale serve` fails; the phone
 * reconnects within this long of Tailscale coming up. Each check is one `serve status` call.
 */
export const TAILSCALE_SERVE_RECHECK_INTERVAL = Duration.seconds(15);

type HoldState = "ours" | "other" | "failed";

/**
 * Keeps the root of the Serve port pointed at this server for as long as it runs: re-adds it
 * when it is missing or left on a dead loopback port, leaves it to another live server or app,
 * and keeps retrying while Tailscale is stopped. Logs on change only.
 */
export const holdTailscaleServe = (
  route: TailscaleServeRootRoute,
  interval: Duration.Input = TAILSCALE_SERVE_RECHECK_INTERVAL,
): Effect.Effect<never, never, ChildProcessSpawner.ChildProcessSpawner | NetService.NetService> =>
  Effect.suspend(() => {
    const context = { localPort: route.localPort, servePort: route.servePort };
    let previous: HoldState | undefined;
    const settle = (next: HoldState, log: Effect.Effect<void>) => {
      const changed = previous !== next;
      previous = next;
      return changed ? log : Effect.void;
    };
    const check = readTailscaleServeRootHolder(route.servePort, {
      host: route.localHost,
      port: route.localPort,
    }).pipe(
      Effect.flatMap((holder) =>
        holder === "none" || holder === "dead"
          ? ensureTailscaleServe({
              localPort: route.localPort,
              servePort: route.servePort,
              localHost: route.urlHost,
            }).pipe(
              Effect.andThen(() => {
                previous = "ours";
                return Effect.logInfo("Tailscale Serve configured", context);
              }),
            )
          : holder === "ours"
            ? settle("ours", Effect.void)
            : settle(
                "other",
                Effect.logInfo("Tailscale Serve left to another server or app on its port", context),
              ),
      ),
      Effect.catch((cause) =>
        settle(
          "failed",
          Effect.logWarning("Tailscale Serve unavailable; retrying", { cause, ...context }),
        ),
      ),
    );
    return Effect.forever(Effect.sleep(interval).pipe(Effect.andThen(check)));
  });

/**
 * Upstream's release step, unchanged: turns off the root route only when it is provably this
 * server's. Lifted here so the hold and the release run, and are tested, as one lifecycle.
 */
export const releaseTailscaleServe = (
  configured: TailscaleServeRootRoute,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.all(
    [
      readTailscaleServeRoutesTo({
        host: configured.localHost,
        port: configured.localPort,
      }),
      readTailscaleStatus,
    ],
    { concurrency: 2 },
  ).pipe(
    // Another service may hold the root route by now, or it may sit under a
    // former name, where `off` would act on the current one; only ours goes.
    Effect.map(([routes, status]) =>
      routes.some(
        (route) =>
          route.servePort === configured.servePort &&
          route.mount === "/" &&
          route.owner === undefined &&
          route.ambiguous === undefined &&
          route.host?.toLowerCase() === status.magicDnsName?.toLowerCase(),
      ),
    ),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((ours) =>
      ours
        ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
            Effect.tap(() =>
              Effect.logInfo("Tailscale Serve disabled", {
                servePort: configured.servePort,
              }),
            ),
          )
        : Effect.logInfo("Tailscale Serve left on; its root route is not known to be ours", {
            servePort: configured.servePort,
          }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to disable Tailscale Serve", {
        cause,
        servePort: configured.servePort,
      }),
    ),
  );

/**
 * Publishes the root route `start` sets up, holds it while the scope is open, and releases it when
 * the scope closes. The hold fiber is forked after the release is registered, so the scope stops it
 * first and a late re-add cannot follow the release. `start` yields null when there is no route.
 */
export const serveTailscaleRoot = <E, R>(
  start: Effect.Effect<TailscaleServeRootRoute | null, E, R>,
  interval: Duration.Input = TAILSCALE_SERVE_RECHECK_INTERVAL,
): Effect.Effect<
  TailscaleServeRootRoute | null,
  E,
  R | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | NetService.NetService
> =>
  Effect.acquireRelease(start, (configured) =>
    configured === null ? Effect.void : releaseTailscaleServe(configured),
  ).pipe(
    Effect.tap((configured) =>
      configured === null
        ? Effect.void
        : holdTailscaleServe(configured, interval).pipe(Effect.forkScoped),
    ),
  );
