// Telegram commands answered without a Segno turn, as Roo's control tower answers them
// (~/.claude/roo-channel/plugins/telegram-daemon/telegram-control-command.ts, control-tower.js
// buildTelegramContextText, heartbeatAutomationModeFromText, buildTelegramHeartbeatText):
//
//   /context              how much of Segno's context is left
//   /heartbeat on|start   Segno's heartbeat on
//   /heartbeat off|stop   off; a bare /heartbeat is off too, as in Roo
//   /segno on|off         Segno itself (intent rev 8): the way back on without the app, since a
//                         Segno that is off cannot turn itself on; a bare /segno says which it is
//
// Roo's /heartbeat switched a work session's idle shutdown; Segno's heartbeat is the clock that
// wakes it (Settings › Companion), so the command switches that setting. Only the person's own
// chat can use them; anywhere else they are ordinary words.

const SUFFIX = '(?:@[a-zA-Z0-9_]{1,32})?';
const CONTEXT = new RegExp(`^/context${SUFFIX}$`, 'i');
const HEARTBEAT = new RegExp(`^/heartbeat${SUFFIX}(?:\\s+(on|off|start|stop))?$`, 'i');
const SEGNO = new RegExp(`^/(?:segno|companion)${SUFFIX}(?:\\s+(on|off|start|stop))?$`, 'i');

/** `{ command: 'context' }`, `{ command: 'heartbeat', enable }`, or undefined for anything else. */
export function parseControlCommand(text) {
  const value = String(text ?? '').trim();
  if (CONTEXT.test(value)) return { command: 'context' };
  const heartbeat = HEARTBEAT.exec(value);
  if (heartbeat) return { command: 'heartbeat', enable: Boolean(heartbeat[1]) && /^(?:on|start)$/i.test(heartbeat[1]) };
  const segno = SEGNO.exec(value);
  if (segno) return segno[1] ? { command: 'segno', enable: /^(?:on|start)$/i.test(segno[1]) } : { command: 'segno' };
  return undefined;
}

const round1 = (value) => Math.round(value * 10) / 10;

/** Roo's context answer, from the engine's session stats (`contextUsage`). */
export function contextText({ usage, error, title = '세뇨' } = {}) {
  const percent = usage?.percent;
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    const remaining = round1(100 - percent);
    const lines = [`[Rubato] ${title} 컨텍스트`, `남은 컨텍스트: ${remaining}%`, `사용 중: ${round1(percent)}%`];
    if (Number.isFinite(usage.tokens) && Number.isFinite(usage.contextWindow))
      lines.push(`토큰: ${usage.tokens.toLocaleString('en-US')} / ${usage.contextWindow.toLocaleString('en-US')}`);
    lines.push('기준: Rubato 엔진 세션 통계');
    return lines.join('\n');
  }
  return [`[Rubato] ${title} 컨텍스트를 확인하지 못했어요.`,
    `이유: ${error || (usage ? '압축 직후라 다음 답이 나와야 알 수 있음' : '세션 상태를 읽을 수 없음')}`].join('\n');
}

/** Roo's heartbeat answer, for Segno's heartbeat. */
export function heartbeatText({ enabled, error, title = '세뇨' } = {}) {
  if (error) return [`[Rubato] ${title} heartbeat 설정을 바꾸지 못했어요.`, `이유: ${error}`].join('\n');
  return [
    `[Rubato] ${title} heartbeat: ${enabled ? '켜짐' : '꺼짐'}`,
    enabled ? `이제 정해진 간격마다 ${title}를 깨웁니다.` : `${title}를 깨우는 heartbeat를 멈춥니다.`,
    enabled ? '끄려면 /heartbeat off' : '다시 켜려면 /heartbeat on',
  ].join('\n');
}

/** Segno itself on or off, or which it is now. */
export function segnoText({ enabled, changed = true, error, title = '세뇨', command = 'segno' } = {}) {
  if (error) return [`[Rubato] ${title}를 켜고 끄지 못했어요.`, `이유: ${error}`].join('\n');
  const head = `[Rubato] ${title}: ${enabled ? '켜짐' : '꺼짐'}`;
  if (!changed) return [head, enabled ? `끄려면 /${command} off` : `켜려면 /${command} on`].join('\n');
  return [head, enabled ? `곧 깨어나요. 끄려면 /${command} off` : `여기 오는 말은 켤 때까지 ${title}에게 가지 않아요. 켜려면 /${command} on`].join('\n');
}

/** What the messenger says to the person's message while Segno is off. */
export function companionOffText({ title = '세뇨', command = 'segno' } = {}) {
  return `[Rubato] ${title}가 지금 꺼져 있어요. /${command} on 으로 켤 수 있어요.`;
}
export const SEGNO_OFF_TEXT = companionOffText();
