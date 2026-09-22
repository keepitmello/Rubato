import test from 'node:test';
import assert from 'node:assert/strict';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { EventProjection } from '../src/events.mjs';

// 앱의 스레드 제목은 Pi 세션이 지은 이름에서 온다. 그 이름이 T3 로 건너가는
// 통로가 두 개다 — 살아 있는 세션이 이름을 바꿀 때 오는 session_info_changed,
// 그리고 세션을 붙일 때 이미 이름이 스레드 제목과 갈라져 있는 경우. 둘 다
// thread.metadata.updated 로 나가야 T3 가 그 제목을 받는다.
function projection(events) {
  return new EventProjection({ threadId: 'title-thread', sessionId: 'session', instanceId: 'instance',
    emit: (event) => events.push(event) });
}
const titleEvents = (events) => events.filter((event) => event.type === 'thread.metadata.updated');

test('a Pi session name change becomes a T3 thread title', () => {
  const events = [];
  const p = projection(events);
  p.project({ type: 'session_info_changed', name: 'Speed Index 설계' });
  assert.deepEqual(titleEvents(events).map((event) => event.payload), [{ name: 'Speed Index 설계' }]);
  assert.equal(titleEvents(events)[0].provider, 'rubato-pi');
  // 이름 없는 이름 변경은 제목이 아니다. T3 는 빈 제목을 스키마에서 거절한다.
  for (const name of [undefined, '', '   ']) p.project({ type: 'session_info_changed', name });
  assert.equal(titleEvents(events).length, 1);
});

test('attaching mirrors a session name that moved on from the thread title', () => {
  const events = [];
  const p = projection(events);
  const bridge = new RubatoPiBridge({ descriptorPath: '/none' });
  // 세션을 만들 때 Pi 의 이름은 스레드 제목으로 시작한다. 그대로면 알릴 것이 없다.
  bridge.mirrorSessionTitle({ projection: p }, 'Speed Index 설계', 'Speed Index 설계');
  assert.equal(titleEvents(events).length, 0);
  // 제목 확장이 주제를 보고 새로 지었거나, 앱이 꺼져 있는 사이에 지어졌다.
  bridge.mirrorSessionTitle({ projection: p }, 'Speed Index 설계', 'speed index 재설계하는 루바토 세션인데 왜…');
  assert.deepEqual(titleEvents(events).map((event) => event.payload), [{ name: 'Speed Index 설계' }]);
  // 이름이 아직 없으면 스레드 제목을 지우지 않는다.
  bridge.mirrorSessionTitle({ projection: p }, undefined, '첫 메시지');
  assert.equal(titleEvents(events).length, 1);
  return bridge.close();
});
