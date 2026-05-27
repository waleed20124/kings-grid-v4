import express from "express";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import { createInitialState, makeMove, placeWall, PLAYERS } from "./src/rules/quoridor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_TIME_MINUTES = 5;
const ROOM_TTL_MS = 2 * 60 * 1000;

const app = express();
const httpServer = createHttpServer(app);
const io = new Server(httpServer);
const rooms = new Map();

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "dist")));
  app.use((_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true, host: "127.0.0.1" },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

io.on("connection", (socket) => {
  socket.on("joinRoom", (payload = {}, reply) => {
    const username = cleanText(payload.username, "Player");
    const roomId = cleanRoomId(payload.roomId);
    const timeControlMinutes = normalizeTimeControl(payload.timeControlMinutes);
    const room = getOrCreateRoom(roomId, timeControlMinutes);
    const existingColor = findPlayerColor(room, username);
    const openColor = existingColor ?? findOpenColor(room);

    if (!openColor) {
      reply?.({ ok: false, message: "Room is full. Use another Room ID." });
      return;
    }

    socket.data.roomId = roomId;
    socket.data.color = openColor;
    socket.data.username = username;
    socket.join(roomId);

    room.players[openColor] = {
      username,
      color: openColor,
      socketId: socket.id,
      connected: true,
      disconnectedAt: null,
    };

    if (room.started && room.paused && bothPlayersConnected(room) && !room.state.winner) {
      room.paused = false;
      room.lastTickAt = Date.now();
      room.state = withMessage(room.state, `${PLAYERS[room.state.currentPlayer].label} to move.`);
    }

    reply?.({ ok: true, roomId, color: openColor, state: buildClientRoom(room, openColor) });
    emitRoomState(room);

    if (!room.started && room.players.white && room.players.black) {
      startRoom(room);
    }
  });

  socket.on("move", ({ row, col } = {}) => {
    const room = roomForSocket(socket);
    if (!canAct(room, socket)) return;

    commitClock(room);
    const next = makeMove(room.state, Number(row), Number(col));
    if (next.messageType === "error") {
      socket.emit("syncState", buildClientRoom(room, socket.data.color, next));
      return;
    }

    room.state = next;
    room.lastTickAt = Date.now();
    finishTurn(room);
  });

  socket.on("placeWall", ({ row, col, orientation } = {}) => {
    const room = roomForSocket(socket);
    if (!canAct(room, socket)) return;

    commitClock(room);
    const next = placeWall(room.state, Number(row), Number(col), orientation);
    if (next.messageType === "error") {
      socket.emit("syncState", buildClientRoom(room, socket.data.color, next));
      return;
    }

    room.state = next;
    room.lastTickAt = Date.now();
    finishTurn(room);
  });

  socket.on("syncState", () => {
    const room = roomForSocket(socket);
    if (room) socket.emit("syncState", buildClientRoom(room, socket.data.color));
  });

  socket.on("disconnect", () => {
    const room = roomForSocket(socket);
    if (!room) return;

    const color = socket.data.color;
    if (room.players[color]?.socketId === socket.id) {
      room.players[color].socketId = null;
      room.players[color].connected = false;
      room.players[color].disconnectedAt = Date.now();
    }

    if (room.started && !room.state.winner) {
      commitClock(room);
      room.paused = true;
      room.state = withMessage(room.state, `${PLAYERS[color].label} disconnected. Waiting for reconnection.`);
      socket.to(room.id).emit("opponentDisconnected", { color, username: room.players[color]?.username });
      emitRoomState(room);
    }

    scheduleRoomCleanup(room);
  });
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`King's Grid online server running at http://127.0.0.1:${PORT}`);
});

function getOrCreateRoom(roomId, timeControlMinutes) {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const timeMs = timeControlMinutes * 60 * 1000;
  const room = {
    id: roomId,
    started: false,
    paused: false,
    state: createInitialState(),
    players: { white: null, black: null },
    timers: { white: timeMs, black: timeMs },
    timeControlMinutes,
    lastTickAt: null,
    timerInterval: null,
    cleanupTimer: null,
  };
  rooms.set(roomId, room);
  return room;
}

function startRoom(room) {
  room.started = true;
  room.paused = false;
  room.state = createInitialState();
  room.state = withMessage(room.state, "Both players are in. White begins.");
  room.lastTickAt = Date.now();
  room.timerInterval = setInterval(() => tickRoom(room), 1000);
  io.to(room.id).emit("startGame", buildClientRoom(room));
  emitRoomState(room);
}

function finishTurn(room) {
  if (room.state.winner) {
    endRoom(room, room.state.winner, "goal");
    return;
  }

  emitRoomState(room);
  emitTimer(room);
}

function tickRoom(room) {
  if (!room.started || room.paused || room.state.winner) return;
  commitClock(room);
  const active = room.state.currentPlayer;

  if (room.timers[active] <= 0) {
    room.timers[active] = 0;
    endRoom(room, opponentOf(active), "timeout");
    return;
  }

  emitTimer(room);
}

function commitClock(room) {
  if (!room.started || room.paused || room.state.winner || !room.lastTickAt) return;
  const now = Date.now();
  const elapsed = now - room.lastTickAt;
  room.lastTickAt = now;
  room.timers[room.state.currentPlayer] = Math.max(0, room.timers[room.state.currentPlayer] - elapsed);
}

function endRoom(room, winner, reason) {
  room.state = {
    ...room.state,
    winner,
    message: reason === "timeout" ? `${PLAYERS[opponentOf(winner)].label} ran out of time.` : room.state.message,
    messageType: "success",
  };
  emitRoomState(room);
  io.to(room.id).emit("gameOver", { winner, reason, state: buildClientRoom(room) });
}

function emitRoomState(room) {
  for (const color of ["white", "black"]) {
    const socketId = room.players[color]?.socketId;
    if (socketId) io.to(socketId).emit("syncState", buildClientRoom(room, color));
  }
}

function emitTimer(room) {
  io.to(room.id).emit("updateTimer", {
    timers: roundedTimers(room.timers),
    currentPlayer: room.state.currentPlayer,
    paused: room.paused,
  });
}

function buildClientRoom(room, viewerColor = null, stateOverride = null) {
  return {
    roomId: room.id,
    started: room.started,
    paused: room.paused,
    viewerColor,
    state: stateOverride ?? room.state,
    players: {
      white: publicPlayer(room.players.white),
      black: publicPlayer(room.players.black),
    },
    timers: roundedTimers(room.timers),
    timeControlMinutes: room.timeControlMinutes,
  };
}

function publicPlayer(player) {
  if (!player) return null;
  return {
    username: player.username,
    color: player.color,
    connected: player.connected,
  };
}

function roundedTimers(timers) {
  return {
    white: Math.max(0, Math.ceil(timers.white / 1000)),
    black: Math.max(0, Math.ceil(timers.black / 1000)),
  };
}

function roomForSocket(socket) {
  return socket.data.roomId ? rooms.get(socket.data.roomId) : null;
}

function canAct(room, socket) {
  if (!room || !room.started || room.paused || room.state.winner) return false;
  return socket.data.color === room.state.currentPlayer;
}

function findPlayerColor(room, username) {
  return ["white", "black"].find((color) => room.players[color]?.username.toLowerCase() === username.toLowerCase()) ?? null;
}

function findOpenColor(room) {
  return ["white", "black"].find((color) => !room.players[color] || !room.players[color].connected) ?? null;
}

function bothPlayersConnected(room) {
  return Boolean(room.players.white?.connected && room.players.black?.connected);
}

function scheduleRoomCleanup(room) {
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (room.players.white?.connected || room.players.black?.connected) return;
    clearInterval(room.timerInterval);
    rooms.delete(room.id);
  }, ROOM_TTL_MS);
}

function withMessage(state, message) {
  return { ...state, message, messageType: "neutral" };
}

function opponentOf(color) {
  return color === "white" ? "black" : "white";
}

function normalizeTimeControl(value) {
  const minutes = Number(value);
  return [5, 10].includes(minutes) ? minutes : DEFAULT_TIME_MINUTES;
}

function cleanRoomId(value) {
  const text = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return text.slice(0, 18) || "KINGSGRID";
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.slice(0, 22) || fallback;
}
