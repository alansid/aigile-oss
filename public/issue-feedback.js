const URL_LIMIT = 2000;

export function issueEnvironment(userAgent, width) {
  const names = { Edg: 'Edge', EdgA: 'Edge', EdgiOS: 'Edge', OPR: 'Opera', CriOS: 'Chrome', HeadlessChrome: 'Chrome', FxiOS: 'Firefox', Version: 'Safari' };
  // Check browsers that also identify as Chrome or Safari before their fallback tokens.
  const browser = /\b(Edg|EdgA|EdgiOS|OPR|CriOS|FxiOS)\/(\d+)/.exec(userAgent)
    || /\b(Chrome|HeadlessChrome|Firefox|Version)\/(\d+)/.exec(userAgent);
  const system = [
    [/Android/, 'Android'], [/iPhone|iPad|iPod/, 'iOS'], [/Windows/, 'Windows'],
    [/CrOS/, 'ChromeOS'], [/Macintosh/, 'macOS'], [/Linux/, 'Linux'],
  ].find(([pattern]) => pattern.test(userAgent))?.[1];
  return { browser: browser ? `${names[browser[1]] || browser[1]} ${browser[2]}` : '', system, width };
}

export function buildIssueUrl(repo, type, fields) {
  const bug = type === 'bug';
  const url = new URL(`https://github.com/${repo}/issues/new`);
  url.searchParams.set('template', bug ? 'bug_report.yml' : 'feature_request.yml');
  const keys = bug ? ['title', 'steps', 'expected', 'version', 'extra'] : ['title', 'problem', 'idea', 'extra'];
  const values = keys.flatMap(key => {
    const value = String(fields[key] ?? '').trim();
    return value ? [[key, Array.from(value)]] : [];
  });
  function withLimit(maxChars) {
    for (const [key, chars] of values) url.searchParams.set(key, chars.slice(0, maxChars).join(''));
    return url.href;
  }
  const longest = Math.max(0, ...values.map(([, chars]) => chars.length));
  const full = withLimit(longest);
  if (full.length <= URL_LIMIT) return { href: full, truncated: false };

  // Cap each field at the same length so a long answer cannot consume the other fields' space.
  let low = 0, high = longest;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (withLimit(mid).length <= URL_LIMIT) low = mid;
    else high = mid;
  }
  return { href: withLimit(low), truncated: true };
}
