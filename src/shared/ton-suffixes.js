export const TON_SUFFIXES = Object.freeze(['.ton', '.adnl', '.bag']);

export function isTonHost(host, explicit = false) {
  if (typeof host !== 'string' || !host) return false;
  const lower = host.toLowerCase().replace(/\.$/, '');
  return (
    TON_SUFFIXES.some((suffix) => lower.endsWith(suffix)) || (explicit && lower.endsWith('.t.me'))
  );
}
