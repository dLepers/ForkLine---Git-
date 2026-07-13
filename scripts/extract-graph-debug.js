const fs = require('node:fs');

const input = process.argv[2] || '/tmp/forkline-debug.log';
const output = process.argv[3] || 'graph-layout-debug.json';
const source = fs.readFileSync(input, 'utf8');
const commitsByRow = new Map();
const svgsByRow = new Map();
const movesByRow = new Map();
let displayOrder = null;

function parseEvent(line, event) {
  const marker = `GRAPH_LAYOUT ${event} `;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  const jsonEnd = line.indexOf(' (file://', jsonStart);
  if (jsonEnd < 0) return null;
  try {
    return JSON.parse(line.slice(jsonStart, jsonEnd));
  } catch {
    return null;
  }
}

for (const line of source.split('\n')) {
  const order = parseEvent(line, 'ORDER');
  if (order && !displayOrder) displayOrder = order;

  const commit = parseEvent(line, 'COMMIT');
  if (commit && !commitsByRow.has(commit.row)) commitsByRow.set(commit.row, commit);

  const svg = parseEvent(line, 'SVG');
  if (svg && !svgsByRow.has(svg.row)) svgsByRow.set(svg.row, svg);

  const move = parseEvent(line, 'MOVE');
  if (move) {
    if (!movesByRow.has(move.row)) movesByRow.set(move.row, []);
    movesByRow.get(move.row).push(move);
  }
}

const selectedHashes = new Set([
  'deaafcfddef10f03d65546396d2c0bf8461f3a1b',
  '0a0c5f9b6561346156bd2a56224ca9e32458c2d4',
  'abd6f0fe1250116c48e00c2c06eee9b08ae7ded3',
  '306251663e5c09ff6037f76013102d5cfa425fc9',
  'b94bef3b5894b52cab6f238b3caf2ba0121b10a9',
]);

function normalize(commit) {
  const svg = svgsByRow.get(commit.row);
  return {
    row: commit.row,
    commit: commit.commit,
    shortCommit: commit.commit.slice(0, 7),
    message: commit.message,
    authorDate: commit.authorDate,
    committerDate: commit.committerDate,
    topologicalRank: commit.topologicalRank,
    finalDisplayIndex: commit.finalDisplayIndex,
    dateOrderIndex: commit.dateOrderIndex,
    parents: commit.parents,
    children: commit.children,
    branches: commit.branches,
    laneBefore: commit.lanePrevious,
    laneCurrent: commit.laneCurrent,
    laneColor: commit.laneColor,
    laneAfter: commit.laneNext,
    activeLanesBefore: commit.columnsBefore,
    activeLanesAfterRaw: commit.columnsAfterRaw,
    activeLanesAfter: commit.columnsAfter,
    events: commit.event,
    decision: commit.decision,
    edges: commit.parents.map((parent) => ({ from: commit.laneCurrent, to: parent.lane, commit: parent.hash })),
    moves: movesByRow.get(commit.row) || [],
    svgPaths: svg?.paths || [],
  };
}

const allRows = [...commitsByRow.values()].sort((a, b) => a.row - b.row);
const selected = allRows.filter((commit) => selectedHashes.has(commit.commit)).map(normalize);
const firstRow = Math.min(...selected.map((commit) => commit.row));
const lastRow = Math.max(...selected.map((commit) => commit.row));
const windowRows = allRows.filter((commit) => commit.row >= firstRow && commit.row <= lastRow).map(normalize);

const result = {
  sourceLog: input,
  displayOrder,
  focusOrder: selected.map((commit) => ({ row: commit.row, commit: commit.commit, message: commit.message })),
  focusCommits: selected,
  window: { firstRow, lastRow, commits: windowRows },
};

fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, focusRows: selected.map((commit) => commit.row), focusCount: selected.length, windowCount: windowRows.length }, null, 2));
