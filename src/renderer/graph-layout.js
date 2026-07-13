(function exposeGraphLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ForklineGraph = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function newLane(lanes) {
    const freeLane = lanes.findIndex((value) => value == null);
    return freeLane === -1 ? lanes.length : freeLane;
  }

  function compactLanes(lanes, laneColors) {
    const transitions = [];
    const transitionColors = [];
    let target = 0;
    for (let source = 0; source < lanes.length; source += 1) {
      if (lanes[source] == null) continue;
      while (target < source && lanes[target] != null) target += 1;
      if (target < source) {
        transitions.push({ from: source, to: target, hash: lanes[source] });
        transitionColors.push(laneColors[source]);
        lanes[target] = lanes[source];
        laneColors[target] = laneColors[source];
        lanes[source] = null;
        laneColors[source] = null;
      }
      target += 1;
    }
    while (lanes.length && lanes[lanes.length - 1] == null) {
      lanes.pop();
      laneColors.pop();
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

  function layoutCommitGraph(commits, options = {}) {
    const lanes = [];
    const laneColors = [];
    const rows = [];
    let laneCount = 1;
    let nextColor = 0;
    const debug = options.debug === true;
    const branches = options.branches || [];
    const children = new Map();
    const assignedLanes = new Map();

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

    // Seul le HEAD obtient une lane pré-réservée en lane 0. Toute autre
    // branche ne doit prendre une colonne qu'au moment où son commit est
    // réellement atteint par le parcours (sinon des colonnes apparaissent
    // "à vide" au sommet du graphe, avant même que le commit correspondant
    // n'existe dans l'historique affiché — ce que GitKraken ne fait jamais).
    if (options.headHash && commits.some((commit) => commit.hash === options.headHash)) {
      lanes[0] = options.headHash;
      laneColors[0] = nextColor;
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
        nextColor += 1;
        decision = "Création d'une nouvelle lane (tête de branche)";
      }

      const before = [...lanes];
      const beforeColors = [...laneColors];
      const laneColor = laneColors[lane];

      // La lane du commit courant se libère : elle sera immédiatement
      // réoccupée ci-dessous par le premier parent (même colonne, ligne droite).
      lanes[lane] = null;
      laneColors[lane] = null;
      const connections = [];

      commit.parents.forEach((parent, parentIndex) => {
        let target = lanes.indexOf(parent);
        if (target === -1) {
          if (parentIndex === 0) {
            // Le parent principal continue EXACTEMENT dans la même colonne :
            // c'est ce qui garde les branches actives bien droites.
            target = lane;
            lanes[target] = parent;
            laneColors[target] = laneColor;
          } else {
            // Le parent secondaire utilise la colonne libre la plus proche.
            target = newLane(lanes);
            lanes[target] = parent;
            laneColors[target] = nextColor;
            nextColor += 1;
          }
        }
        connections.push({ from: lane, to: target, parentIndex, fromColor: laneColor, toColor: laneColors[target] });
      });

      const { transitions, transitionColors } = compactLanes(lanes, laneColors);
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
        before,
        beforeColors,
        after,
        afterColors,
        transitions,
        transitionColors,
        connections,
        anchorHash: commit.hash,
      });
    }

    const headIndex = options.headHash ? commits.findIndex((commit) => commit.hash === options.headHash) : -1;
    const workingTreeNode = options.showWorkingTree && headIndex >= 0
        ? { type: 'WorkingTreeNode', lane: 0, commitIndex: headIndex, position: 'top' }
        : null;

    return { rows, laneCount, workingTreeNode };
  }

  return { layoutCommitGraph };
}));
