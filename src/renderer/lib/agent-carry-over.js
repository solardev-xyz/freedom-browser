// "Choose another model" has to start a new chat, because a conversation's
// model is fixed. The new chat must not lose what the earlier turns said, so
// the composer gets the earlier exchange as visible, editable text followed by
// the request that failed. The user sees exactly what will be sent.

// Stays well under the service's 32,000-character prompt limit, leaving room
// for the user to add to the carried text.
export const CARRY_OVER_MAX_LENGTH = 24_000;

const OMITTED_NOTE = '(Earlier messages omitted.)';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// turns: oldest first, each { userText, assistantText }. The last turn is the
// request being carried over; its answer (if any) is the failed attempt and is
// not repeated.
export function carryOverPrompt(turns, maxLength = CARRY_OVER_MAX_LENGTH) {
  const list = Array.isArray(turns) ? turns : [];
  const request = clean(list.at(-1)?.userText);
  const earlier = list.slice(0, -1)
    .map((turn) => {
      const user = clean(turn?.userText);
      const assistant = clean(turn?.assistantText);
      return [user && `User: ${user}`, assistant && `Assistant: ${assistant}`].filter(Boolean).join('\n\n');
    })
    .filter(Boolean);
  if (!earlier.length) return request;

  const head = 'Continue from this earlier conversation:';
  const tail = request ? `Request: ${request}` : '';
  const fixedLength = head.length + tail.length + OMITTED_NOTE.length + 8;
  const kept = [];
  let used = 0;
  // Keep the most recent exchanges whole; drop older ones first.
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const cost = earlier[index].length + 2;
    if (fixedLength + used + cost > maxLength) break;
    kept.unshift(earlier[index]);
    used += cost;
  }
  if (!kept.length) return request;
  const omitted = kept.length < earlier.length ? [OMITTED_NOTE] : [];
  return [head, ...omitted, ...kept, tail].filter(Boolean).join('\n\n');
}
