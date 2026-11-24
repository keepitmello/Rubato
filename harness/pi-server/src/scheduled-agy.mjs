// This entry is written with the session header, before inventory can open the thread.
export const SCHEDULED_AGY_ENTRY = 'rubato.scheduled-agy';
export const SCHEDULED_ACCOUNT_ERROR = 'Could not open scheduled Antigravity account';

export function scheduledAgy(model, thinking) {
  if (!/^rubato-agy-(cli|profile)\//.test(model ?? '')) return null;
  const [provider, instanceId, slug, ...extra] = model.split('/');
  if (extra.length || !/^[\w.:-]+$/.test(instanceId) ||
      !/^gemini-(?:[4-9]|[1-9]\d+)(?:[.-][\w.-]+)?$/.test(slug ?? '') ||
      (thinking != null && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'].includes(thinking)))
    throw new Error(`Invalid scheduled Antigravity selection: ${model}`);
  return { provider, instanceId, model: slug, isolated: provider.endsWith('-profile'), thinking: thinking ?? null };
}
