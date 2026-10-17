// The words of an episode. Every episode first reads in plain English built from its
// numbers, so the page never waits; a cheap model rewrites it as a short story in the
// person's language when one answers (service.mjs writes those in the background).

/** "1h 57m", "58m": how long, as a person reads it. */
export function duration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

const where = (episode) => `“${episode.title ?? episode.project}”`;
const quote = (text, max = 120) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * A provider error as a person reads it. Errors often arrive as JSON wrapped in JSON
 * ({"error":{"message":"{\\"error\\":…"}}); the innermost message is the readable part.
 */
export function readableError(text) {
  const raw = String(text ?? '');
  const messages = [...raw.matchAll(/\\*"message\\*"\s*:\s*\\*"((?:[^"\\]|\\(?!"))+)/g)].map((match) => match[1]);
  return (messages.at(-1) ?? raw).replace(/\\+/g, '').trim();
}

/** The English headline and story an episode shows until (or unless) a model rewrites it. */
export function fallbackStory(episode) {
  const f = episode.facts;
  switch (episode.kind) {
    case 'mind':
      return {
        headline: `Second-guessed itself ${f.hesitations} times in one thought`,
        story: `Working on ${where(episode)}, it kept stopping to doubt itself: ${f.hesitations} hmms, waits and actuallys in ${f.chars.toLocaleString('en-US')} characters of thinking.`,
      };
    case 'cost':
      return {
        headline: `One message, $${f.usd.toFixed(2)}`,
        story: `“${quote(f.message)}” set it off. It worked on its own for ${duration(f.seconds)}, $${f.usd.toFixed(2)} at API prices, the priciest turn in this period.`,
      };
    case 'swarm':
      return {
        headline: `${f.agents} subagents in one session`,
        story: `Working on ${where(episode)}, it handed work to subagents ${f.agents} times${f.teams ? ` and formed ${f.teams} ${f.teams === 1 ? 'team' : 'teams'}` : ''}.`,
      };
    case 'night':
      return {
        headline: `${f.messages} messages before dawn`,
        story: `Between midnight and 6 AM you traded ${f.messages} messages on ${where(episode)}.`,
      };
    case 'outage':
      return {
        headline: `${f.failures} failed calls in a row`,
        story: `For ${duration(f.seconds)} on ${where(episode)}, call after call failed.${f.error ? ` The last error: “${quote(readableError(f.error), 90)}”.` : ''}`,
      };
    case 'solo':
      return {
        headline: `${f.calls.toLocaleString('en-US')} calls without a word from you`,
        story: `It kept going on ${where(episode)} for ${duration(f.seconds)} without stopping once for you.`,
      };
    case 'first':
      return {
        headline: 'Where it all started',
        story: `“${quote(f.message)}” was the first thing you typed, ${episode.value} days ago.`,
      };
    default:
      return { headline: episode.kind, story: '' };
  }
}

/** What each kind is about, for the model: the facts alone do not say why it is a moment. */
export const EPISODE_BRIEFS = Object.freeze({
  mind: 'The agent second-guessed itself more in this one thinking block than anywhere else. Its private reasoning is below.',
  cost: 'The single most expensive turn: one message from the person set off this much work. Cost is at API list prices.',
  swarm: 'The session where the agent handed the most work to subagents.',
  night: 'The night with the most messages between midnight and 6 AM.',
  outage: 'The longest run of model calls that failed back to back.',
  solo: 'The longest stretch the agent kept calling the model without a message from the person.',
  first: 'The very first message the person typed to Rubato.',
});
