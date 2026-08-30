// Antigravity 대화 state. bridge 의 module-global `sessions` 를 대체한다.
//
// bridge 는 `Map<fxSessionId, session>` 하나를 module scope 에 두었다. 그것을 그대로
// 옮기면 세 가지가 동시에 깨진다:
//
//   1. **branch**. Senpi 세션은 tree 다. 같은 `sessionId` 로 두 branch 를 오가면
//      `lastExecutionId` 와 `stepIndex` 가 서로의 것을 물려받는다 — 상류는 그것을
//      "이 대화의 이전 turn" 으로 읽으므로, 다른 branch 의 continuation 이 된다.
//   2. **profile**. 한 프로세스가 여러 profile 을 볼 수 있고(`*_CODING_AGENT_DIR`),
//      module-global 은 그 경계를 모른다.
//   3. **수명**. module scope 는 프로세스가 죽을 때까지 자란다.
//
// 그래서 key 는 `{profileId, providerId, modelId, sessionId, branchId,
// conversationGeneration}` 이고, 상한과 TTL 과 직렬화가 이 파일의 계약이다.
//
// 이 tracker 는 **module-global 이 아니다**. `providerOverlay(pi, …)` 호출마다 하나씩
// 만들어 provider 에 넘긴다. AsyncLocalStorage 로 provider scope 를 흉내내지 않는다 —
// stream 은 호출자의 async context 밖에서도 계속 돌기 때문에 그 축은 신뢰할 수 없다.
import { randomBytes, randomUUID } from "node:crypto";

/** profile 하나가 들고 있을 수 있는 최대 state 수. */
export const ANTIGRAVITY_PROFILE_STATE_CAP = 64;

/** 한 lineage family(profile/provider/model/session) 안의 최대 branch·generation 수. */
export const ANTIGRAVITY_LINEAGE_STATE_CAP = 4;

/** idle TTL. 마지막 사용에서 이만큼 지난 state 는 죽은 것으로 본다. */
export const ANTIGRAVITY_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * branch 를 모를 때 쓰는 표지. **fail-safe generation 이고, root 가 아니다.**
 *
 * 모르는 branch 를 root 로 추측하면 두 개의 서로 다른 lineage 가 하나의
 * `lastExecutionId` 를 공유한다. 그래서 별도 축으로 격리하고, 나중에 실제 branch 를
 * 알게 되어도 그 known branch 로 **합치지 않는다**.
 */
export const ANTIGRAVITY_UNKNOWN_BRANCH = "unknown";

function stateKey({ profileId, providerId, modelId, sessionId, branchId, conversationGeneration }) {
  return JSON.stringify([profileId, providerId, modelId, sessionId, branchId, conversationGeneration]);
}

function lineageKey({ profileId, providerId, modelId, sessionId }) {
  return JSON.stringify([profileId, providerId, modelId, sessionId]);
}

function newEnvelopeState(now) {
  return {
    // bridge 와 같은 모양. 상류는 `sessionId` 를 10진 정수 문자열로 받는다.
    sessionId: randomBytes(8).readBigInt64BE().toString(),
    agentId: randomUUID(),
    trajectoryId: randomUUID(),
    stepIndex: 1,
    lastExecutionId: undefined,
    createdAtMs: now,
    lastUsedAtMs: now,
    // 지금 `fn` 을 실행 중인 호출 수. lease 라고 부른다.
    live: 0,
    // 자기 차례를 기다리는 예약 수. **TTL·cap 회수에서 live 와 같게 보호된다** —
    // 기다리는 호출이 있는 state 를 지우면 그 호출은 깨어나서 남의 state 를 잡는다.
    waiters: 0,
    // 등록부에서 빠질 예정. 새 호출을 **받지 않는다**(fail closed).
    closing: false,
    queue: Promise.resolve(),
  };
}

/**
 * 다음 요청 envelope. bridge `nextAntigravityEnvelope` 와 같은 wire 계약이다.
 *
 * `stepIndex` 를 먼저 올리고 **직전** 값을 `last_step_index` 로 싣는다. 이 순서가
 * bridge 가 검증한 순서다.
 */
export function nextAntigravityEnvelope(state, now = Date.now()) {
  state.stepIndex += 1;
  const labels = {
    last_step_index: String(state.stepIndex - 1),
    trajectory_id: state.trajectoryId,
    used_claude: "false",
    used_claude_conservative: "false",
  };
  if (state.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
  return {
    sessionId: state.sessionId,
    requestId: `agent/${state.agentId}/${now}/${state.trajectoryId}/${state.stepIndex}`,
    labels,
  };
}

/**
 * 상한 초과. **id 를 싣지 않는다** — 사유와 상한만 남긴다.
 *
 * state 를 추측해 재사용하지 않는다. 잘못 고른 state 는 다른 대화의 continuation 을
 * 만들고, 그것은 조용히 틀린 답이 된다. 열린 오류가 낫다.
 */
export class AntigravityStateCapError extends Error {
  constructor(scope, cap) {
    super(`antigravity: ${scope} conversation state cap (${cap}) reached; cannot allocate a new lineage state`);
    this.name = "AntigravityStateCapError";
    this.scope = scope;
    this.cap = cap;
  }
}

/**
 * 닫히는 중인 lineage 에 새 호출이 들어왔다. **id 를 싣지 않는다.**
 *
 * 여기서 새 state 를 만들면 안 된다. 그러면 shutdown·세대 교체가 진행 중인 lineage 에서
 * 옛 live 호출과 새 호출이 **같은 상류 대화를 두 객체로** 밀게 된다 — `stepIndex` 가
 * 겹치고 `last_execution_id` 가 서로를 지운다. 그래서 받지 않는다.
 */
export class AntigravityStateClosedError extends Error {
  constructor() {
    super("antigravity: this conversation lineage is shutting down; no new request is admitted");
    this.name = "AntigravityStateClosedError";
  }
}

/** 취소를 호출자의 사유 그대로 세운다. 없으면 표준 AbortError 를 만든다. */
function abortReason(signal) {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * 앞선 호출을 기다린다. **취소되면 즉시 빠져나온다.**
 *
 * signal 없이 `await previous` 만 하면, 같은 lineage 에 줄 서 있던 호출은 사용자가
 * 중단한 뒤에도 앞 호출이 끝날 때까지 살아 있다가 `fn` 을 실행한다 — 중단한 턴의
 * 요청이 상류로 나가고 `stepIndex` 가 올라간다. 그래서 대기 자체를 취소 가능하게 둔다.
 *
 * 앞 호출의 실패는 전파하지 않는다. 순서는 유지하되 남의 오류로 죽지 않는다.
 */
async function waitForTurn(previous, signal) {
  if (!signal) {
    await previous.catch(() => {});
    return;
  }
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    // `throwIfAborted()` 와 이 등록 사이에 abort 가 들어올 수 있다. 이미 abort 된
    // signal 에 달은 listener 는 **절대 불리지 않으므로**, 등록 직후에 한 번 더 본다.
    if (signal.aborted) reject(abortReason(signal));
  });
  // race 에서 지면 이 promise 는 아무도 안 보는 rejection 이 된다.
  aborted.catch(() => {});
  try {
    await Promise.race([previous.catch(() => {}), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 한 overlay 호출이 소유하는 lineage tracker.
 *
 * `branchOf(sessionId)` 와 `generationOf(sessionId)` 는 extension lifecycle 이 갱신한다
 * (`antigravity-route.mjs` 가 `session_tree`/`session_before_fork`/`session_start` 를
 * 구독해 넘긴다). tracker 는 그 값을 추측하지 않는다.
 */
export function createAntigravityStateStore({
  now = () => Date.now(),
  profileStateCap = ANTIGRAVITY_PROFILE_STATE_CAP,
  lineageStateCap = ANTIGRAVITY_LINEAGE_STATE_CAP,
  ttlMs = ANTIGRAVITY_STATE_TTL_MS,
} = {}) {
  /** profileId -> Map<stateKey, state> */
  const byProfile = new Map();

  function profileStates(profileId) {
    let states = byProfile.get(profileId);
    if (!states) {
      states = new Map();
      byProfile.set(profileId, states);
    }
    return states;
  }

  /** 지금 이 state 를 붙잡고 있는 호출이 있는가. 실행 중 + 대기 중 모두 센다. */
  function busy(state) {
    return state.live > 0 || state.waiters > 0;
  }

  /**
   * 죽은 state 를 지운다. **붙잡고 있는 호출이 있으면 절대 지우지 않는다.**
   *
   * 실행 중(live)만 보호하면 부족하다. 줄 서서 기다리는 호출(waiters)의 state 를
   * 회수하면 그 호출은 깨어나 새 state 를 만들고, 같은 lineage 가 두 객체로 갈라진다.
   */
  function sweep(profileId, at) {
    const states = byProfile.get(profileId);
    if (!states) return 0;
    let removed = 0;
    for (const [key, state] of states) {
      if (busy(state)) continue;
      if (state.closing) {
        states.delete(key);
        removed += 1;
        continue;
      }
      if (at - state.lastUsedAtMs < ttlMs) continue;
      states.delete(key);
      removed += 1;
    }
    if (states.size === 0) byProfile.delete(profileId);
    return removed;
  }

  /** 닫히는 state 를 마지막 사용자가 놓았을 때 등록부에서 뺀다. */
  function retireIfDrained(profileId, id, state) {
    if (!state.closing || busy(state)) return false;
    const states = byProfile.get(profileId);
    if (!states || states.get(id) !== state) return false;
    states.delete(id);
    if (states.size === 0) byProfile.delete(profileId);
    return true;
  }

  /**
   * 닫는다. 붙잡고 있는 호출이 없으면 바로 빼고, 있으면 tombstone 으로 남긴다.
   *
   * tombstone 은 두 가지를 동시에 지킨다: 진행 중인 호출은 자기 state 로 끝까지 가고,
   * 새 호출은 그 lineage 에 **들어오지 못한다**.
   */
  function close(profileId, id, state) {
    state.closing = true;
    return retireIfDrained(profileId, id, state);
  }

  function lineageSize(states, key) {
    const family = lineageKey(key);
    let count = 0;
    for (const [, state] of states) {
      if (state.lineage === family) count += 1;
    }
    return count;
  }

  function acquire(key) {
    const at = now();
    sweep(key.profileId, at);
    const states = profileStates(key.profileId);
    const id = stateKey(key);
    let state = states.get(id);
    if (state?.closing) throw new AntigravityStateClosedError();
    if (!state) {
      if (states.size >= profileStateCap) throw new AntigravityStateCapError("profile", profileStateCap);
      if (lineageSize(states, key) >= lineageStateCap) {
        throw new AntigravityStateCapError("session lineage", lineageStateCap);
      }
      state = newEnvelopeState(at);
      state.lineage = lineageKey(key);
      states.set(id, state);
    }
    state.lastUsedAtMs = at;
    return { id, state };
  }

  return {
    /**
     * 한 lineage 의 stateful 구간 전체를 직렬화해 실행한다.
     *
     * envelope 할당부터 `lastExecutionId` 갱신까지가 한 구간이다. 그 사이를 쪼개면
     * 같은 lineage 의 두 요청이 같은 `stepIndex` 를 받는다. 다른 branch 는 다른
     * state 이므로 서로 기다리지 않는다.
     *
     * **정상 종료는 state 를 버리지 않는다.** 버리는 것은 `lastExecutionId` 와
     * `stepIndex` 를 버리는 것이고, 그러면 다음 turn 이 continuation 이 아니라 새 대화가
     * 된다 — 3턴 이어짐이 그 자리에서 깨진다. 매 terminal 에서 놓는 것은 **lease**
     * (`live`)뿐이고, 영속 state 는 shutdown·세대 교체·오류/abort 오염·TTL·명시적
     * 폐기에서만 사라진다.
     */
    async run(key, fn, { signal } = {}) {
      const { id, state } = acquire(key);
      const previous = state.queue;
      let release;
      state.queue = new Promise((resolve) => { release = resolve; });
      // 대기도 이 state 를 붙잡은 것으로 센다 — sweep/cap 이 회수하지 못한다.
      state.waiters += 1;
      const openGate = () => {
        release();
        retireIfDrained(key.profileId, id, state);
      };
      try {
        await waitForTurn(previous, signal);
      } catch (error) {
        // 취소된 대기는 `fn` 을 실행하지 않는다. 호출자는 **지금** 사유를 받지만,
        // 우리 뒤에 줄 선 호출의 문은 `previous` 가 정착한 뒤에만 열린다.
        //
        // 여기서 바로 `release()` 하면 이렇다: A 가 아직 돌고 B 가 취소되었는데, B 의
        // gate 가 여기서 열려 C 가 A 와 **나란히** 실행된다 — 직렬화가 깨진다.
        state.waiters -= 1;
        previous.then(openGate, openGate);
        throw error;
      }
      state.waiters -= 1;
      state.live += 1;
      try {
        return await fn(state);
      } finally {
        state.live -= 1;
        state.lastUsedAtMs = now();
        openGate();
      }
    },

    /**
     * 이 lineage 의 영속 state 를 버린다.
     *
     * 부르는 자리는 정해져 있다: 세대 교체·fork 패자·오류/abort 로 state 가 오염됐을 수
     * 있는 경우·명시적 폐기. **정상 turn terminal 은 부르지 않는다.**
     *
     * 진행 중인 호출이 있으면 tombstone 으로 남긴다. 그 호출은 자기 객체로 끝까지 가고,
     * 새 호출은 `AntigravityStateClosedError` 로 막힌다 — 같은 lineage 를 두 객체가
     * 동시에 미는 상태를 만들지 않는다.
     */
    drop(key) {
      const states = byProfile.get(key.profileId);
      if (!states) return false;
      const id = stateKey(key);
      const state = states.get(id);
      if (!state) return false;
      close(key.profileId, id, state);
      return true;
    },

    /**
     * 한 세션(모든 branch/generation)의 state 를 버린다. shutdown 경로가 쓴다.
     *
     * 등록부에서 즉시 지우지 않는다. 지우면 같은 key 의 새 요청이 **아직 살아 있는**
     * 옛 객체와 나란히 새 state 를 잡는다. 닫아서 새 admission 을 먼저 막고, 마지막
     * 사용자가 놓을 때 빠진다.
     */
    dropSession({ profileId, sessionId }) {
      const states = byProfile.get(profileId);
      if (!states) return 0;
      let closed = 0;
      for (const [id, state] of [...states]) {
        if (JSON.parse(id)[3] !== sessionId) continue;
        close(profileId, id, state);
        closed += 1;
      }
      return closed;
    },

    /**
     * 모든 state 를 닫는다. tracker dispose 경로.
     *
     * live state 를 Map 에서 즉시 지우지 않는다. 지우면 같은 provider 객체를 아직 쥔
     * 호출이 끝나기 전에 새 호출이 같은 key 로 두 번째 state 를 만들 수 있다.
     */
    clear() {
      for (const [profileId, states] of [...byProfile]) {
        for (const [id, state] of [...states]) close(profileId, id, state);
      }
    },

    /** 관측용. 값이 아니라 개수만 돌려준다. tombstone 도 자리를 차지하므로 함께 센다. */
    size(profileId) {
      return profileId === undefined
        ? [...byProfile.values()].reduce((total, states) => total + states.size, 0)
        : (byProfile.get(profileId)?.size ?? 0);
    },

    /** 이 key 가 새 호출을 받는가. 진단과 테스트용. */
    admits(key) {
      const state = byProfile.get(key.profileId)?.get(stateKey(key));
      return state === undefined || state.closing !== true;
    },

    /** 테스트와 진단용 sweep. 지운 개수만 돌려준다. */
    sweep(profileId) {
      return sweep(profileId, now());
    },
  };
}

/**
 * extension lifecycle 이 채우는 lineage tracker.
 *
 * branch 는 session tree 의 leaf entry id 다(`session_tree.newLeafId`). generation 은
 * fork/compaction/session 교체마다 오른다 — 그 사건들은 "같은 sessionId 의 다른
 * 대화" 를 만들기 때문이다.
 *
 * `pi.on` 이 없거나(비대화형 host) 이벤트가 오지 않으면 branch 는
 * `ANTIGRAVITY_UNKNOWN_BRANCH` 로 남는다. 그것은 별도 격리 축이며, 나중에 known
 * branch 를 알게 되어도 그 state 로 합치지 않는다.
 */
export function createAntigravityLineageTracker() {
  /** sessionId -> { branchId, generation } */
  const lineages = new Map();

  function entry(sessionId) {
    let value = lineages.get(sessionId);
    if (!value) {
      value = { branchId: ANTIGRAVITY_UNKNOWN_BRANCH, generation: 0 };
      lineages.set(sessionId, value);
    }
    return value;
  }

  return {
    /** session_start 시 실제 session/leaf 로 초기화한다. reload 는 같은 세대다. */
    seed(sessionId, leafId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
      const value = entry(sessionId);
      value.branchId = typeof leafId === "string" && leafId.length > 0
        ? leafId
        : ANTIGRAVITY_UNKNOWN_BRANCH;
      return value;
    },

    /** 현재 branch. 모르면 fail-safe 축. */
    branchOf(sessionId) {
      return lineages.get(sessionId)?.branchId ?? ANTIGRAVITY_UNKNOWN_BRANCH;
    },

    generationOf(sessionId) {
      return lineages.get(sessionId)?.generation ?? 0;
    },

    /**
     * tree 이동. leaf 가 바뀌면 branch 가 바뀐다.
     *
     * `newLeafId` 가 `null` 이면 host 는 root 로 갔지만 우리에게 식별자를 주지
     * 않았다. root 라고 **이름 붙이지 않는다** — unknown 축으로 보내고 generation 을
     * 올려 이전 상태와 격리한다.
     */
    onTree(sessionId, newLeafId) {
      const value = entry(sessionId);
      const next = typeof newLeafId === "string" && newLeafId.length > 0 ? newLeafId : ANTIGRAVITY_UNKNOWN_BRANCH;
      if (next === value.branchId) return value;
      value.branchId = next;
      value.generation += 1;
      return value;
    },

    /** fork/compaction/session 교체. 같은 branch 라도 다른 대화다. */
    onGenerationChange(sessionId) {
      const value = entry(sessionId);
      value.generation += 1;
      return value;
    },

    /** 세션이 사라졌다. */
    forget(sessionId) {
      return lineages.delete(sessionId);
    },

    clear() {
      lineages.clear();
    },

    size() {
      return lineages.size;
    },
  };
}
