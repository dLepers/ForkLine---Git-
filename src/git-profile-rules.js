function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
}

function globMatches(value, pattern) {
  const cleanPattern = String(pattern || '').trim();
  if (!cleanPattern) return true;
  const source = escapeRegExp(cleanPattern).replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(String(value || ''));
}

function ruleSpecificity(profile) {
  return `${profile.pathPattern || ''}${profile.remotePattern || ''}`.replace(/[?*]/g, '').length;
}

function selectGitProfile(state, repository, remoteUrls = []) {
  const profiles = state.gitProfiles || [];
  const exactId = state.gitProfileAssignments?.[repository];
  const exact = profiles.find((profile) => profile.id === exactId);
  if (exact) return { profile: exact, matchType: 'exact' };

  const matches = profiles.filter((profile) => {
    const pathPattern = String(profile.pathPattern || '').trim();
    const remotePattern = String(profile.remotePattern || '').trim();
    if (!pathPattern && !remotePattern) return false;
    return (!pathPattern || globMatches(repository, pathPattern))
      && (!remotePattern || remoteUrls.some((url) => globMatches(url, remotePattern)));
  }).sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a) || a.label.localeCompare(b.label, 'fr'));

  return matches.length ? { profile: matches[0], matchType: 'rule' } : { profile: null, matchType: null };
}

module.exports = { globMatches, selectGitProfile };
