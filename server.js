import express from "express";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import { createInitialState, makeMove, placeWall, PLAYERS } from "./src/rules/quoridor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
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
    server: { middlewareMode: true, host: "0.0.0.0" },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

io.on("connection", (socket) => {
  socket.on("joinRoom", (payload = {}, reply) => {
    const username = cleanText(payload.username, "Player");
    const roomId = cleanRoomId(payload.roomId);
    const room = getOrCreateRoom(roomId);
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

    const next = makeMove(room.state, Number(row), Number(col));
    if (next.messageType === "error") {
      socket.emit("syncState", buildClientRoom(room, socket.data.color, next));
      return;
    }

    room.state = next;
    finishTurn(room);
  });

  socket.on("placeWall", ({ row, col, orientation } = {}) => {
    const room = roomForSocket(socket);
    if (!canAct(room, socket)) return;

    const next = placeWall(room.state, Number(row), Number(col), orientation);
    if (next.messageType === "error") {
      socket.emit("syncState", buildClientRoom(room, socket.data.color, next));
      return;
    }

    room.state = next;
    finishTurn(room);
  });

  socket.on("chatMessage", (payload = {}) => {
    const room = roomForSocket(socket);
    if (!room) return;

    const message = cleanChatMessage(payload.message);
    if (!message) return;

    const chatMessage = {
      id: `${Date.now()}-${socket.id}`,
      username: socket.data.username,
      color: socket.data.color,
      message,
      sentAt: Date.now(),
    };

    room.messages.push(chatMessage);
    room.messages = room.messages.slice(-100);
    io.to(room.id).emit("receiveMessage", chatMessage);
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
      room.paused = true;
      room.state = withMessage(room.state, `${PLAYERS[color].label} disconnected. Waiting for reconnection.`);
      socket.to(room.id).emit("opponentDisconnected", { color, username: room.players[color]?.username });
      emitRoomState(room);
    }

    scheduleRoomCleanup(room);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`King's Grid online server running on 0.0.0.0:${PORT}`);
});

function getOrCreateRoom(roomId) {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const room = {
    id: roomId,
    started: false,
    paused: false,
    state: createInitialState(),
    players: { white: null, black: null },
    messages: [],
    cleanupHandle: null,
  };
  rooms.set(roomId, room);
  return room;
}

function startRoom(room) {
  room.started = true;
  room.paused = false;
  room.state = createInitialState();
  room.state = withMessage(room.state, "Both players are in. White begins.");
  io.to(room.id).emit("startGame", buildClientRoom(room));
  emitRoomState(room);
}

function finishTurn(room) {
  if (room.state.winner) {
    endRoom(room, room.state.winner);
    return;
  }

  emitRoomState(room);
}

function endRoom(room, winner) {
  room.state = {
    ...room.state,
    winner,
    message: room.state.message,
    messageType: "success",
  };
  emitRoomState(room);
  io.to(room.id).emit("gameOver", { winner, reason: "goal", state: buildClientRoom(room) });
}

function emitRoomState(room) {
  for (const color of ["white", "black"]) {
    const socketId = room.players[color]?.socketId;
    if (socketId) io.to(socketId).emit("syncState", buildClientRoom(room, color));
  }
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
    messages: room.messages,
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
  clearTimeout(room.cleanupHandle);
  room.cleanupHandle = setTimeout(() => {
    if (room.players.white?.connected || room.players.black?.connected) return;
    rooms.delete(room.id);
  }, ROOM_TTL_MS);
}

function withMessage(state, message) {
  return { ...state, message, messageType: "neutral" };
}

function cleanRoomId(value) {
  const text = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return text.slice(0, 18) || "KINGSGRID";
}

function cleanText(value, fallback) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.slice(0, 22) || fallback;
}

function cleanChatMessage(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 280);
}
