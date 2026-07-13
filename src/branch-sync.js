function branchSyncState(branch, remoteHash = null) {
  const tracking = branch.tracking || { state: branch.upstream ? 'up-to-date' : 'local', ahead: 0, behind: 0 };
  const upstream = branch.upstream || '';
  if (tracking.state === 'gone') {
    return { state: 'gone', icons: ['⚠️'], tooltip: `Dépôt distant introuvable${upstream ? ` (${upstream})` : ''} : branche distante supprimée` };
  }
  if (!upstream) {
    return { state: 'local', icons: ['💻'], tooltip: 'Branche uniquement locale, sans dépôt distant associé' };
  }
  const suffix = `${tracking.ahead} commit${tracking.ahead > 1 ? 's' : ''} à pousser, ${tracking.behind} commit${tracking.behind > 1 ? 's' : ''} à récupérer`;
  if (tracking.state === 'diverged') return { state: 'diverged', icons: ['💻', '🔄'], tooltip: `Branche suivie par ${upstream}. Divergence : ${suffix}` };
  if (tracking.state === 'ahead') return { state: 'ahead', icons: ['💻'], tooltip: `Branche suivie par ${upstream}. ${suffix}` };
  if (tracking.state === 'behind') return { state: 'behind', icons: ['💻', '⬇️'], tooltip: `Branche suivie par ${upstream}. ${suffix}` };
  if (remoteHash && branch.hash === remoteHash) return { state: 'up-to-date', icons: ['💻', '☁️'], tooltip: `Branche suivie par ${upstream}, à jour avec le dépôt distant` };
  return { state: 'unknown', icons: ['💻'], tooltip: `Branche suivie par ${upstream}` };
}

if (typeof module !== 'undefined') module.exports = { branchSyncState };
if (typeof window !== 'undefined') window.ForklineBranchSync = { branchSyncState };
