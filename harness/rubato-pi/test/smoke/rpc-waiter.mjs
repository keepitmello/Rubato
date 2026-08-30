/**
 * RPC 레코드 대기 큐. `direct-real.mjs` 가 세션과 주고받는 유일한 창구다.
 *
 * 별도 모듈인 이유: 러너 본체는 import 즉시 `main()` 을 돌려 실 vendor 를 때린다. 그래서
 * 시험이 러너를 import 할 수 없다. 그런데 **러너 자신이 검증 도구**이므로 이 큐가 틀리면
 * 모든 gate 판정이 흔들린다 — 실제로 Kiro 가 통과하는데 FAIL 로 적혔다. 그 자리를 시험이
 * 겨눌 수 있어야 한다.
 *
 * 두 가지를 동시에 지켜야 한다. 하나만 지키면 각각 반대 방향으로 틀린다.
 *
 * 1. **백로그를 먼저 본다.** 구독은 구독 이후의 레코드만 받는다. 앞선 대기가 시간을 넘겨
 *    fallback 으로 넘어가면 그 사이 흘러간 응답을 영원히 기다린다. Kiro 가 멈춘 자리다.
 * 2. **집은 것은 소비한다.** `promptTurn` 은 id 없는 `agent_end` 를 매치하므로, 소비하지
 *    않으면 2턴째가 1턴의 종료를 즉시 집어 3턴 이어짐 gate 가 **거짓 통과**한다.
 */
export function createRpcWaiter() {
  const waiters = [];
  const records = [];

  /** 한 줄씩 들어온 레코드를 대기자에게 넘기거나 백로그에 쌓는다. */
  const push = (rec) => {
    // 대기자에게 바로 건넨 레코드는 백로그에 남기지 않는다. 남기면 같은 레코드가 두 번
    // 소비되어(라이브 한 번, 백로그 한 번) 다음 턴이 앞 턴의 종료를 집는다.
    for (const waiter of [...waiters]) {
      if (waiter.match(rec)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(rec);
        return;
      }
    }
    records.push(rec);
  };

  const wait = (match, timeoutMs, label = "event") =>
    new Promise((resolve, reject) => {
      const hit = records.findIndex((rec) => match(rec));
      if (hit >= 0) {
        const [already] = records.splice(hit, 1);
        resolve(already);
        return;
      }
      const waiter = { match, resolve };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      const orig = waiter.resolve;
      waiter.resolve = (rec) => {
        clearTimeout(timer);
        orig(rec);
      };
    });

  wait.records = records;
  wait.push = push;
  return wait;
}

/** 줄 단위 NDJSON 을 잘라 `push` 로 넘기는 소비자. 부분 줄을 버리지 않는다. */
export function createLineReader(push) {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        push(JSON.parse(line));
      } catch {
        // 러너는 사람이 읽는 로그가 아니라 NDJSON 만 본다. 깨진 줄은 버린다.
      }
    }
  };
}
