export const MATRIX_SIZE = 17;
export const BOARD_CELLS = 9;

export const PLAYERS = {
  white: {
    label: "White",
    start: { row: 16, col: 8 },
    goalRow: 0,
  },
  black: {
    label: "Black",
    start: { row: 0, col: 8 },
    goalRow: 16,
  },
};

const DIRECTIONS = [
  { dr: -2, dc: 0, wr: -1, wc: 0 },
  { dr: 2, dc: 0, wr: 1, wc: 0 },
  { dr: 0, dc: -2, wr: 0, wc: -1 },
  { dr: 0, dc: 2, wr: 0, wc: 1 },
];

export const CELL_SPOTS = new Map(
  Array.from({ length: BOARD_CELLS }, (_, boardRow) =>
    Array.from({ length: BOARD_CELLS }, (_, boardCol) => {
      const row = boardRow * 2;
      const col = boardCol * 2;
      return [`${row}:${col}`, { row, col, boardRow, boardCol }];
    })
  ).flat()
);

export function createInitialState() {
  return {
    currentPlayer: "white",
    winner: null,
    message: "White begins. Move your pawn or place a wall.",
    messageType: "neutral",
    players: {
      white: { position: { ...PLAYERS.white.start }, walls: 10 },
      black: { position: { ...PLAYERS.black.start }, walls: 10 },
    },
    walls: [],
  };
}

export function getLegalMoves(state, playerColor) {
  const player = state.players[playerColor];
  const opponent = state.players[opponentOf(playerColor)];
  const moves = [];

  for (const direction of DIRECTIONS) {
    const nextRow = player.position.row + direction.dr;
    const nextCol = player.position.col + direction.dc;
    if (!inBounds(nextRow, nextCol) || hasWallBetween(state, player.position, direction)) {
      continue;
    }

    if (nextRow === opponent.position.row && nextCol === opponent.position.col) {
      const jumpRow = opponent.position.row + direction.dr;
      const jumpCol = opponent.position.col + direction.dc;
      if (inBounds(jumpRow, jumpCol) && !hasWallBetween(state, opponent.position, direction)) {
        moves.push({ row: jumpRow, col: jumpCol });
      }
      continue;
    }

    moves.push({ row: nextRow, col: nextCol });
  }

  return moves;
}

export function makeMove(state, row, col) {
  const legal = getLegalMoves(state, state.currentPlayer).some((move) => move.row === row && move.col === col);
  if (!legal) {
    return {
      ...state,
      message: "That pawn move is blocked.",
      messageType: "error",
    };
  }

  const players = copyPlayers(state.players);
  players[state.currentPlayer].position = { row, col };
  const winner = row === PLAYERS[state.currentPlayer].goalRow ? state.currentPlayer : null;
  const nextPlayer = winner ? state.currentPlayer : opponentOf(state.currentPlayer);

  return {
    ...state,
    players,
    currentPlayer: nextPlayer,
    winner,
    message: winner ? `${PLAYERS[winner].label} reaches the far rank.` : `${PLAYERS[nextPlayer].label} to move.`,
    messageType: winner ? "success" : "neutral",
  };
}

export function placeWall(state, row, col, orientation) {
  const validation = validateWall(state, row, col, orientation);
  if (!validation.ok) {
    return {
      ...state,
      message: validation.reason,
      messageType: "error",
    };
  }

  const players = copyPlayers(state.players);
  players[state.currentPlayer].walls -= 1;
  const nextPlayer = opponentOf(state.currentPlayer);

  return {
    ...state,
    players,
    currentPlayer: nextPlayer,
    walls: [...state.walls, { row, col, orientation }],
    message: `${PLAYERS[state.currentPlayer].label} placed a ${orientation} wall.`,
    messageType: "neutral",
  };
}

export function getWallPreview(state, row, col, orientation) {
  const validation = validateWall(state, row, col, orientation);
  return {
    row,
    col,
    orientation,
    segments: wallSegments(row, col, orientation),
    valid: validation.ok,
    reason: validation.reason,
  };
}

export function getWallSegments(row, col, orientation) {
  return wallSegments(row, col, orientation);
}

export function canUseWallAnchor(row, col, orientation) {
  return isWallAnchor(row, col, orientation);
}

function validateWall(state, row, col, orientation) {
  if (state.players[state.currentPlayer].walls <= 0) {
    return { ok: false, reason: `${PLAYERS[state.currentPlayer].label} has no walls left.` };
  }

  if (!isWallAnchor(row, col, orientation)) {
    return { ok: false, reason: "Select a valid wall slot." };
  }

  const segments = wallSegments(row, col, orientation);
  const occupied = new Set(state.walls.flatMap((wall) => wallSegments(wall.row, wall.col, wall.orientation).map(asKey)));
  if (segments.some((segment) => occupied.has(asKey(segment)))) {
    return { ok: false, reason: "Walls cannot overlap or cross." };
  }

  const candidate = { ...state, walls: [...state.walls, { row, col, orientation }] };
  if (!hasPathToGoal(candidate, "white") || !hasPathToGoal(candidate, "black")) {
    return { ok: false, reason: "That wall would block every possible path." };
  }

  return { ok: true, reason: "" };
}

export function hasPathToGoal(state, playerColor) {
  const start = state.players[playerColor].position;
  const goalRow = PLAYERS[playerColor].goalRow;
  const visited = Array.from({ length: MATRIX_SIZE }, () => Array(MATRIX_SIZE).fill(false));
  const queue = [{ row: start.row, col: start.col }];
  visited[start.row][start.col] = true;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.row === goalRow) return true;

    for (const direction of DIRECTIONS) {
      const nextRow = current.row + direction.dr;
      const nextCol = current.col + direction.dc;
      if (!inBounds(nextRow, nextCol)) continue;
      if (visited[nextRow][nextCol]) continue;
      if (hasWallBetween(state, current, direction)) continue;

      visited[nextRow][nextCol] = true;
      queue.push({ row: nextRow, col: nextCol });
    }
  }

  return false;
}

function hasWallBetween(state, position, direction) {
  const wallPoint = { row: position.row + direction.wr, col: position.col + direction.wc };
  return state.walls.some((wall) => wallSegments(wall.row, wall.col, wall.orientation).some((segment) => samePoint(segment, wallPoint)));
}

function isWallAnchor(row, col, orientation) {
  if (orientation === "horizontal") {
    return row % 2 === 1 && col % 2 === 0 && row > 0 && row < MATRIX_SIZE - 1 && col >= 0 && col < MATRIX_SIZE - 2;
  }

  return col % 2 === 1 && row % 2 === 0 && col > 0 && col < MATRIX_SIZE - 1 && row >= 0 && row < MATRIX_SIZE - 2;
}

function wallSegments(row, col, orientation) {
  if (orientation === "horizontal") {
    return [
      { row, col },
      { row, col: col + 1 },
      { row, col: col + 2 },
    ];
  }

  return [
    { row, col },
    { row: row + 1, col },
    { row: row + 2, col },
  ];
}

function copyPlayers(players) {
  return {
    white: { walls: players.white.walls, position: { ...players.white.position } },
    black: { walls: players.black.walls, position: { ...players.black.position } },
  };
}

function opponentOf(playerColor) {
  return playerColor === "white" ? "black" : "white";
}

function inBounds(row, col) {
  return row >= 0 && row < MATRIX_SIZE && col >= 0 && col < MATRIX_SIZE;
}

function samePoint(a, b) {
  return a.row === b.row && a.col === b.col;
}

function asKey(point) {
  return `${point.row}:${point.col}`;
}
