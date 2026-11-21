// One reply, several bubbles: where a reply's text breaks into the messages the person sees.
// The app keeps the same rule (overlay/packages/shared/src/rubatoReplyBubbles.ts) with the same cases.
import assert from 'node:assert/strict';
import test from 'node:test';
import { REPLY_BUBBLES_MAX, replyBubbleGapMs, replyBubbles } from '../home.mjs';

test('each paragraph is its own bubble; one paragraph stays one, nothing is none', () => {
  assert.deepEqual(replyBubbles('응, 봤어.\n\n저녁은 먹었어?\r\n\r\n나는 아까 라면.'), ['응, 봤어.', '저녁은 먹었어?', '나는 아까 라면.']);
  assert.deepEqual(replyBubbles('한 줄\n바로 다음 줄'), ['한 줄\n바로 다음 줄']);
  assert.deepEqual(replyBubbles('  혼자  '), ['혼자']);
  assert.deepEqual(replyBubbles(''), []);
  assert.deepEqual(replyBubbles(undefined), []);
});

test('a code block, a spread-out list, a lead-in, a heading and an indented line stay with their bubble', () => {
  const code = '이렇게 고치면 돼\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n됐지?';
  assert.deepEqual(replyBubbles(code), ['이렇게 고치면 돼', '```js\nconst a = 1;\n\nconst b = 2;\n```', '됐지?']);
  assert.deepEqual(replyBubbles('오늘 할 거:\n\n- 장보기\n\n- 빨래\n\n1. 하나\n\n2. 둘\n\n끝!'),
    ['오늘 할 거:\n\n- 장보기\n\n- 빨래\n\n1. 하나\n\n2. 둘', '끝!']);
  assert.deepEqual(replyBubbles('## 오늘\n\n맑음\n\n내일은 비'), ['## 오늘\n\n맑음', '내일은 비']);
  assert.deepEqual(replyBubbles('- 항목\n\n  이어지는 설명\n\n다음 얘기'), ['- 항목\n\n  이어지는 설명', '다음 얘기']);
  assert.deepEqual(replyBubbles('```\n열린 채로\n\n끝남'), ['```\n열린 채로\n\n끝남']);
});

test('file lines ride with the last words', () => {
  assert.deepEqual(replyBubbles('사진 봐\n\n예쁘지?\n\n![a.png](</tmp/a.png>)\n\n[b.pdf](</tmp/b.pdf>)'),
    ['사진 봐', '예쁘지?\n\n![a.png](</tmp/a.png>)\n\n[b.pdf](</tmp/b.pdf>)']);
});

test('past the cap the rest joins the last bubble', () => {
  const many = Array.from({ length: REPLY_BUBBLES_MAX + 3 }, (_, i) => `p${i}`);
  const bubbles = replyBubbles(many.join('\n\n'));
  assert.equal(bubbles.length, REPLY_BUBBLES_MAX);
  assert.deepEqual(bubbles.slice(0, -1), many.slice(0, REPLY_BUBBLES_MAX - 1));
  assert.equal(bubbles.at(-1), many.slice(REPLY_BUBBLES_MAX - 1).join('\n\n'));
});

test('the pause before a bubble grows with its words and stays short', () => {
  assert.ok(replyBubbleGapMs('응') < replyBubbleGapMs('조금 더 긴 말풍선 하나'));
  assert.equal(replyBubbleGapMs('x'.repeat(5000)), 2200);
});
