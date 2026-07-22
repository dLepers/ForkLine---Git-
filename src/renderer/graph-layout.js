(function exposeGraphLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ForklineGraph = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function newLane(lanes) {
    const freeLane = lanes.findIndex((value) => value == null);
    return freeLane === -1 ? lanes.length : freeLane;
  }

  function compactLanes(lanes, laneColors, laneVisibility, laneLineColors) {
    const transitions = [];
    const transitionColors = [];
    let target = 0;
    for (let source = 0; source < lanes.length; source += 1) {
      if (lanes[source] == null) continue;
      while (target < source && lanes[target] != null) target += 1;
      if (target < source) {
        transitions.push({ from: source, to: target, hash: lanes[source] });
        transitionColors.push(laneLineColors[source] ?? laneColors[source]);
        lanes[target] = lanes[source];
        laneColors[target] = laneColors[source];
        laneVisibility[target] = laneVisibility[source];
        laneLineColors[target] = laneLineColors[source];
        lanes[source] = null;
        laneColors[source] = null;
        laneVisibility[source] = false;
        laneLineColors[source] = null;
      }
      target += 1;
    }
    while (lanes.length && lanes[lanes.length - 1] == null) {
      lanes.pop();
      laneColors.pop();
      laneVisibility.pop();
      laneLineColors.pop();
    }
    return { transitions, transitionColors };
  }

  function branchNamesForHash(branches, hash) {
    return (branches || [])
        .filter((branch) => branch.hash === hash)
        .map((branch) => branch.name)
        .filter(Boolean);
  }

  function laneState(lanes, branches) {
    return lanes.map((hash, lane) => `Lane ${lane} -> ${hash ? (branchNamesForHash(branches, hash).join(', ') || hash.slice(0, 10)) : 'free'}`);
  }

  function debugLog(enabled, event, data) {
    if (!enabled || typeof console === 'undefined') return;
    console.log(`GRAPH_LAYOUT ${event} ${JSON.stringify(data)}`);
  }

  function filterGraphVisibility(commits, branches, options = {}) {
    const graphCommits = (commits || []).filter((commit) => !commit.stashRef);
    const graphBranches = branches || [];
    const hiddenBranchNames = new Set(options.hiddenBranchNames || []);
    const soloBranch = options.soloBranchName
      ? graphBranches.find((branch) => !branch.remote && branch.name === options.soloBranchName)
      : null;
    const hiddenLocalBranches = graphBranches.filter((branch) => !branch.remote && hiddenBranchNames.has(branch.name));
    const hiddenRemoteNames = new Set();
    hiddenLocalBranches.forEach((localBranch) => {
      if (localBranch.upstream) hiddenRemoteNames.add(localBranch.upstream);
      graphBranches.filter((branch) => branch.remote && branch.hash === localBranch.hash && branch.name.split('/').slice(1).join('/') === localBranch.name)
        .forEach((branch) => hiddenRemoteNames.add(branch.name));
    });
    const visibleBranches = soloBranch
      ? graphBranches.filter((branch) => branch === soloBranch || (branch.remote && (
        branch.name === soloBranch.upstream
        || (!soloBranch.upstream && branch.hash === soloBranch.hash && branch.name.split('/').slice(1).join('/') === soloBranch.name)
      )))
      : graphBranches.filter((branch) => (branch.remote ? !hiddenRemoteNames.has(branch.name) : !hiddenBranchNames.has(branch.name)));

    if (!soloBranch && hiddenBranchNames.size === 0) return { commits: graphCommits, branches: visibleBranches };

    const commitsByHash = new Map(graphCommits.map((commit) => [commit.hash, commit]));
    const reachable = new Set();
    const pending = [...new Set(visibleBranches.filter((branch) => !branch.symbolic).map((branch) => branch.hash).filter(Boolean))];
    while (pending.length) {
      const hash = pending.pop();
      if (reachable.has(hash)) continue;
      reachable.add(hash);
      const commit = commitsByHash.get(hash);
      if (commit) pending.push(...commit.parents);
    }

    return {
      commits: reachable.size ? graphCommits.filter((commit) => reachable.has(commit.hash)) : graphCommits,
      branches: visibleBranches,
    };
  }

  function stashDisplayIndex(commits, stash, baseIndex) {
    const safeBaseIndex = Math.max(0, Math.min(Number(baseIndex) || 0, Math.max(0, commits.length - 1)));
    const stashTime = Date.parse(stash?.date || '');
    if (!Number.isFinite(stashTime)) return safeBaseIndex;

    const chronologicalIndex = commits.findIndex((commit) => {
      const commitTime = Date.parse(commit.committerDate || commit.date || '');
      return Number.isFinite(commitTime) && commitTime <= stashTime;
    });
    if (chronologicalIndex < 0) return safeBaseIndex;
    return Math.min(chronologicalIndex, safeBaseIndex);
  }

  function stashVisibilityAfterAction(hiddenHashes, action, stashHash, allHashes) {
    const knownHashes = new Set(allHashes || []);
    const hidden = new Set((hiddenHashes || []).filter((hash) => knownHashes.has(hash)));
    if (action === 'toggle-visibility' && stashHash && knownHashes.has(stashHash)) {
      if (hidden.has(stashHash)) hidden.delete(stashHash);
      else hidden.add(stashHash);
    } else if (action === 'hide-all') {
      knownHashes.forEach((hash) => hidden.add(hash));
    } else if (action === 'show-all') {
      hidden.clear();
    }
    return [...hidden];
  }

  function layoutCommitGraph(commits, options = {}) {
    const lanes = [];
    const laneColors = [];
    const laneVisibility = [];
    const laneLineColors = [];
    const rows = [];
    let laneCount = 1;
    let nextColor = 0;
    const debug = options.debug === true;
    const branches = options.branches || [];
    const children = new Map();
    const assignedLanes = new Map();
    const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
    const activeFirstParentChain = new Set();

    let activeHash = options.headHash;
    while (activeHash && !activeFirstParentChain.has(activeHash)) {
      activeFirstParentChain.add(activeHash);
      activeHash = commitsByHash.get(activeHash)?.parents?.[0] || null;
    }

    commits.forEach((commit) => {
      commit.parents.forEach((parent) => {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(commit);
      });
    });

    debugLog(debug, 'ORDER', options.orderDebug || {
      finalDisplayOrder: 'date-order',
      dateOrderCommitCount: commits.length,
      firstDifference: null,
    });

    // La copie de travail et la branche active conservent toujours la lane 0.
    // Si une branche est en avance sur HEAD, sa chaîne reste dans une lane
    // parallèle jusqu'au commit HEAD, où elle rejoint la ligne active. C'est
    // la géométrie de GitKraken : le WIP reste aligné avec la branche active.
    if (options.headHash && commits.some((commit) => commit.hash === options.headHash)) {
      lanes[0] = options.headHash;
      laneColors[0] = nextColor;
      laneVisibility[0] = false;
      laneLineColors[0] = null;
      nextColor += 1;
    }

    for (const commit of commits) {
      const rowIndex = rows.length;
      let lane = lanes.indexOf(commit.hash);
      const previousLane = lane;
      const startsHere = lane === -1;
      let decision = 'Commit déjà présent dans une lane existante';

      if (startsHere) {
        // Une nouvelle tête réutilise la colonne libre la plus à gauche, mais
        // reçoit toujours une nouvelle couleur afin de rester identifiable.
        lane = newLane(lanes);
        lanes[lane] = commit.hash;
        laneColors[lane] = nextColor;
        laneVisibility[lane] = true;
        laneLineColors[lane] = nextColor;
        nextColor += 1;
        decision = "Création d'une nouvelle lane (tête de branche)";
      }

      const before = [...lanes];
      const beforeColors = [...laneColors];
      const beforeVisible = [...laneVisibility];
      const beforeLineColors = [...laneLineColors];
      const laneColor = laneColors[lane];

      // La lane du commit courant se libère : elle sera immédiatement
      // réoccupée ci-dessous par le premier parent (même colonne, ligne droite).
      lanes[lane] = null;
      laneColors[lane] = null;
      laneVisibility[lane] = false;
      laneLineColors[lane] = null;
      const connections = [];
      const joins = [];

      commit.parents.forEach((parent, parentIndex) => {
        let target = lanes.indexOf(parent);
        if (parentIndex === 0 && lane === 0 && activeFirstParentChain.has(commit.hash) && target > 0) {
          const joiningColor = laneColors[target];
          lanes[target] = null;
          laneColors[target] = null;
          laneVisibility[target] = false;
          laneLineColors[target] = null;
          lanes[lane] = parent;
          laneColors[lane] = laneColor;
          laneVisibility[lane] = true;
          laneLineColors[lane] = laneColor;
          connections.push({ from: lane, to: lane, parentIndex, fromColor: laneColor, toColor: laneColor, color: laneColor });
          joins.push({ from: target, to: lane, hash: parent, color: joiningColor });
          return;
        }
        if (target === -1) {
          if (parentIndex === 0) {
            // Le parent principal continue EXACTEMENT dans la même colonne :
            // c'est ce qui garde les branches actives bien droites.
            target = lane;
            lanes[target] = parent;
            laneColors[target] = laneColor;
            laneVisibility[target] = true;
            laneLineColors[target] = laneColor;
          } else {
            // Le parent secondaire utilise la colonne libre la plus proche.
            target = newLane(lanes);
            lanes[target] = parent;
            laneColors[target] = nextColor;
            laneVisibility[target] = true;
            laneLineColors[target] = nextColor;
            nextColor += 1;
          }
        }
        const connectionColor = parentIndex === 0
          ? laneColor
          : (laneLineColors[target] ?? laneColors[target]);
        laneVisibility[target] = true;
        laneLineColors[target] = connectionColor;
        connections.push({
          from: lane,
          to: target,
          parentIndex,
          fromColor: laneColor,
          toColor: laneColors[target],
          color: connectionColor,
        });
      });

      // Une connexion oblique doit atteindre sa lane parente avant toute
      // compaction. La déplacer sur la même frontière produirait un crochet
      // sans signification topologique. La compaction est reportée à la
      // prochaine ligne ne portant que des continuités verticales.
      const canCompact = connections.every(({ from, to }) => from === to);
      const { transitions, transitionColors } = canCompact
        ? compactLanes(lanes, laneColors, laneVisibility, laneLineColors)
        : { transitions: [], transitionColors: [] };
      transitions.forEach((transition) => debugLog(debug, 'LANE_MOVE', {
        row: rowIndex,
        hash: transition.hash,
        from: transition.from,
        to: transition.to,
        reason: 'compaction après libération de lane',
      }));

      laneCount = Math.max(laneCount, before.length, lanes.length, lane + 1);

      const after = [...lanes];
      const afterColors = [...laneColors];
      const afterVisible = [...laneVisibility];
      const afterLineColors = [...laneLineColors];
      const nextLane = commit.parents.length ? after.indexOf(commit.parents[0]) : -1;
      const parentLanes = commit.parents.map((parent) => ({ hash: parent, lane: after.indexOf(parent) }));
      const childLanes = (children.get(commit.hash) || []).map((child) => ({
        hash: child.hash,
        lane: assignedLanes.has(child.hash) ? assignedLanes.get(child.hash) : 'pending',
      }));

      const event = [
        commit.parents.length > 1 ? 'merge' : null,
        startsHere ? 'branch start' : null,
        commit.parents.length === 0 ? 'branch end' : null,
      ].filter(Boolean);

      debugLog(debug, 'COMMIT', {
        row: rowIndex,
        commit: commit.hash,
        message: commit.subject,
        authorDate: commit.authorDate || commit.date || null,
        committerDate: commit.committerDate || commit.date || null,
        topologicalRank: commit.topologicalRank ?? rowIndex,
        finalDisplayIndex: commit.finalDisplayIndex ?? rowIndex,
        dateOrderIndex: commit.dateOrderIndex ?? null,
        laneCurrent: lane,
        laneColor,
        lanePrevious: previousLane,
        laneNext: nextLane,
        parents: parentLanes,
        children: childLanes,
        branches: branchNamesForHash(branches, commit.hash),
        event: event.length ? event : ['normal'],
        columnsBefore: laneState(before, branches),
        columnsAfter: laneState(after, branches),
        decision,
      });
      debugLog(debug, 'ROW_LANES', { row: rowIndex, lanes: laneState(after, branches) });
      assignedLanes.set(commit.hash, lane);

      rows.push({
        lane,
        laneColor,
        startsHere,
        hasVisibleChild: childLanes.length > 0,
        before,
        beforeColors,
        beforeVisible,
        beforeLineColors,
        after,
        afterColors,
        afterVisible,
        afterLineColors,
        transitions,
        transitionColors,
        connections,
        joins,
        anchorHash: commit.hash,
      });
    }

    const headIndex = options.headHash ? commits.findIndex((commit) => commit.hash === options.headHash) : -1;
    const workingTreeNode = options.showWorkingTree && headIndex >= 0
        ? { type: 'WorkingTreeNode', lane: 0, commitIndex: headIndex, position: 'top' }
        : null;

    return { rows, laneCount, workingTreeNode };
  }

  return { filterGraphVisibility, layoutCommitGraph, stashDisplayIndex, stashVisibilityAfterAction };
}));
