// Telegram commands answered without a Segno turn, as Roo's control tower answers them
// (~/.claude/roo-channel/plugins/telegram-daemon/telegram-control-command.ts, control-tower.js
// buildTelegramContextText, heartbeatAutomationModeFromText, buildTelegramHeartbeatText):
//
//   /context              how much of Segno's context is left
//   /heartbeat on|start   Segno's heartbeat on
//   /heartbeat off|stop   off; a bare /heartbeat is off too, as in Roo
//
// Roo's /heartbeat switched a work session's idle shutdown; Segno's heartbeat is the clock that
// wakes it (Settings › Companion), so the command switches that setting. Only the person's own
// chat can use them; anywhere else they are ordinary words.

const SUFFIX = '(?:@[a-zA-Z0-9_]{1,32})?';
const CONTEXT = new RegExp(`^/context${SUFFIX}$`, 'i');
const HEARTBEAT = new RegExp(`^/heartbeat${SUFFIX}(?:\\s+(on|off|start|stop))?$`, 'i');

/** `{ command: 'context' }`, `{ command: 'heartbeat', enable }`, or undefined for anything else. */
export function parseControlCommand(text) {
  const value = String(text ?? '').trim();
  if (CONTEXT.test(value)) return { command: 'context' };
  const heartbeat = HEARTBEAT.exec(value);
  if (heartbeat) return { command: 'heartbeat', enable: Boolean(heartbeat[1]) && /^(?:on|start)$/i.test(heartbeat[1]) };
  return undefined;
}

const round1 = (value) => Math.round(value * 10) / 10;

/** Roo's context answer, from the engine's session stats (`contextUsage`). */
export function contextText({ usage, error } = {}) {
  const percent = usage?.percent;
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    const remaining = round1(100 - percent);
    const lines = ['[Rubato] 세뇨 컨텍스트', `남은 컨텍스트: ${remaining}%`, `사용 중: ${round1(percent)}%`];
    if (Number.isFinite(usage.tokens) && Number.isFinite(usage.contextWindow))
      lines.push(`토큰: ${usage.tokens.toLocaleString('en-US')} / ${usage.contextWindow.toLocaleString('en-US')}`);
    lines.push('기준: Rubato 엔진 세션 통계');
    return lines.join('\n');
  }
  return ['[Rubato] 세뇨 컨텍스트를 확인하지 못했어요.',
    `이유: ${error || (usage ? '압축 직후라 다음 답이 나와야 알 수 있음' : '세션 상태를 읽을 수 없음')}`].join('\n');
}

/** Roo's heartbeat answer, for Segno's heartbeat. */
export function heartbeatText({ enabled, error } = {}) {
  if (error) return ['[Rubato] 세뇨 heartbeat 설정을 바꾸지 못했어요.', `이유: ${error}`].join('\n');
  return [
    `[Rubato] 세뇨 heartbeat: ${enabled ? '켜짐' : '꺼짐'}`,
    enabled ? '이제 정해진 간격마다 세뇨를 깨웁니다.' : '세뇨를 깨우는 heartbeat를 멈춥니다.',
    enabled ? '끄려면 /heartbeat off' : '다시 켜려면 /heartbeat on',
  ].join('\n');
}
