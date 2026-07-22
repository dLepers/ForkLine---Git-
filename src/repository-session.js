function uniqueRepositories(repositories = []) {
  const seen = new Set();
  return repositories.filter((repository) => {
    if (typeof repository !== 'string' || !repository.trim() || seen.has(repository)) return false;
    seen.add(repository);
    return true;
  });
}

function normalizeRepositorySession(state = {}) {
  const legacyRepository = typeof state.lastRepository === 'string' ? state.lastRepository : null;
  const repositories = uniqueRepositories(Array.isArray(state.openRepositories)
    ? state.openRepositories
    : legacyRepository ? [legacyRepository] : []);
  const requestedActive = state.activeRepository || legacyRepository;
  return {
    repositories,
    activeRepository: repositories.includes(requestedActive) ? requestedActive : repositories.at(-1) || null,
  };
}

function openRepositoryInSession(session, repository) {
  const repositories = uniqueRepositories([...(session?.repositories || []), repository]);
  return { repositories, activeRepository: repository };
}

function closeRepositoryInSession(session, repository) {
  const repositories = uniqueRepositories(session?.repositories || []);
  const closedIndex = repositories.indexOf(repository);
  if (closedIndex === -1) return { repositories, activeRepository: session?.activeRepository || null };
  const remaining = repositories.filter((candidate) => candidate !== repository);
  const activeRepository = session?.activeRepository === repository
    ? remaining[Math.min(closedIndex, remaining.length - 1)] || null
    : session?.activeRepository;
  return { repositories: remaining, activeRepository: remaining.includes(activeRepository) ? activeRepository : remaining.at(-1) || null };
}

module.exports = { normalizeRepositorySession, openRepositoryInSession, closeRepositoryInSession };
