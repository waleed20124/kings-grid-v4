import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, DoorOpen, Radio, Volume2, VolumeX } from "lucide-react";
import { io } from "socket.io-client";
import {
  CELL_SPOTS,
  MATRIX_SIZE,
  PLAYERS,
  canUseWallAnchor,
  createInitialState,
  getLegalMoves,
  getWallSegments,
  getWallPreview,
} from "./rules/quoridor.js";
import "./styles.css";

const socket = io("https://kings-grid-v4.onrender.com");

function useGameAudio(enabled) {
  const contextRef = useRef(null);

  return (type) => {
    if (!enabled) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const context = contextRef.current ?? new AudioContext();
    contextRef.current = context;

    const tone = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const palette = {
      move: [360, 0.045],
      wall: [180, 0.055],
      error: [96, 0.06],
      win: [520, 0.14],
      join: [440, 0.08],
    };
    const [frequency, duration] = palette[type] ?? palette.move;

    tone.type = type === "error" ? "sawtooth" : "triangle";
    tone.frequency.setValueAtTime(frequency, now);
    tone.frequency.exponentialRampToValueAtTime(frequency * 1.22, now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(type === "win" ? 0.1 : 0.055, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    tone.connect(gain).connect(context.destination);
    tone.start(now);
    tone.stop(now + duration + 0.02);
  };
}

function App() {
  const [phase, setPhase] = useState("lobby");
  const [joinError, setJoinError] = useState("");
  const [room, setRoom] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [orientation, setOrientation] = useState("horizontal");
  const [hoveredWall, setHoveredWall] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const lastTurnRef = useRef(null);
  const lastWinnerRef = useRef(null);
  const playSound = useGameAudio(soundEnabled);

  useEffect(() => {
    function handleSync(nextRoom) {
      setRoom(nextRoom);
      setChatMessages(nextRoom.messages ?? []);
      setPhase(nextRoom.started ? "game" : "waiting");

      if (lastTurnRef.current && lastTurnRef.current !== nextRoom.state.currentPlayer) {
        playSound("move");
      }
      if (nextRoom.state.messageType === "error") {
        playSound("error");
      }
      if (nextRoom.state.winner && lastWinnerRef.current !== nextRoom.state.winner) {
        playSound("win");
      }

      lastTurnRef.current = nextRoom.state.currentPlayer;
      lastWinnerRef.current = nextRoom.state.winner;
    }

    function handleStart(nextRoom) {
      setRoom(nextRoom);
      setChatMessages(nextRoom.messages ?? []);
      setPhase("game");
      playSound("join");
    }

    function handleGameOver({ state }) {
      setRoom(state);
      setChatMessages(state.messages ?? []);
      setPhase("game");
      playSound("win");
    }

    function handleMessage(message) {
      setChatMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]));
    }

    socket.on("syncState", handleSync);
    socket.on("startGame", handleStart);
    socket.on("gameOver", handleGameOver);
    socket.on("receiveMessage", handleMessage);
    return () => {
      socket.off("syncState", handleSync);
      socket.off("startGame", handleStart);
      socket.off("gameOver", handleGameOver);
      socket.off("receiveMessage", handleMessage);
    };
  }, [playSound]);

  function joinGame(payload) {
    setJoinError("");
    setPhase("joining");
    socket.emit("joinRoom", payload, (response) => {
      if (!response?.ok) {
        setJoinError(response?.message ?? "Could not join that room.");
        setPhase("lobby");
        return;
      }

      setRoom(response.state);
      setChatMessages(response.state.messages ?? []);
      setPhase(response.state.started ? "game" : "waiting");
    });
  }

  function leaveRoom() {
    window.location.reload();
  }

  if (phase === "lobby" || phase === "joining") {
    return <Lobby onJoin={joinGame} joining={phase === "joining"} error={joinError} />;
  }

  return (
    <OnlineGame
      room={room}
      chatMessages={chatMessages}
      orientation={orientation}
      hoveredWall={hoveredWall}
      soundEnabled={soundEnabled}
      onOrientation={setOrientation}
      onWallHover={setHoveredWall}
      onSoundToggle={() => setSoundEnabled((value) => !value)}
      onLeave={leaveRoom}
    />
  );
}

function Lobby({ onJoin, joining, error }) {
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState(makeRoomId());

  function submit(event) {
    event.preventDefault();
    onJoin({ username, roomId });
  }

  return (
    <main className="lobby-shell">
      <form className="lobby-panel" onSubmit={submit}>
        <div className="brand-block">
          <p className="eyebrow">King's Grid Online</p>
          <h1>Quoridor</h1>
          <p className="subtitle">Enter a name, share a room, and race across the board in real time.</p>
        </div>

        <label className="field-group">
          <span>Username</span>
          <input value={username} maxLength={22} onChange={(event) => setUsername(event.target.value)} required />
        </label>

        <label className="field-group">
          <span>Room ID</span>
          <div className="room-input-row">
            <input value={roomId} maxLength={18} onChange={(event) => setRoomId(event.target.value.toUpperCase())} required />
            <button className="icon-button" type="button" onClick={() => navigator.clipboard?.writeText(roomId)} title="Copy Room ID">
              <Copy size={18} />
            </button>
          </div>
        </label>

        {error && <div className="message-bar error">{error}</div>}

        <button className="primary-button" type="submit" disabled={joining}>
          <Radio size={18} />
          {joining ? "Joining..." : "Play"}
        </button>
      </form>
    </main>
  );
}

function OnlineGame({ room, chatMessages, orientation, hoveredWall, soundEnabled, onOrientation, onWallHover, onSoundToggle, onLeave }) {
  const state = room?.state ?? createInitialState();
  const myColor = room?.viewerColor;
  const opponentColor = myColor === "white" ? "black" : "white";
  const myTurn = room?.started && !room?.paused && state.currentPlayer === myColor && !state.winner;
  const legalMoves = useMemo(() => (myTurn ? getLegalMoves(state, state.currentPlayer) : []), [state, myTurn]);
  const legalMoveKeys = useMemo(() => new Set(legalMoves.map((move) => `${move.row}:${move.col}`)), [legalMoves]);
  const preview = hoveredWall && myTurn ? getWallPreview(state, hoveredWall.row, hoveredWall.col, hoveredWall.orientation) : null;
  const previewKeys = new Set(preview?.segments.map((segment) => `${segment.row}:${segment.col}`) ?? []);
  const activePlayer = PLAYERS[state.currentPlayer];
  const opponent = room?.players?.[opponentColor];
  const waiting = !room?.started;

  function handleMove(row, col) {
    if (!myTurn) return;
    socket.emit("move", { row, col });
  }

  function handleWall(row, col) {
    if (!myTurn) return;
    socket.emit("placeWall", { row, col, orientation });
  }

  function handleSendMessage(message) {
    socket.emit("chatMessage", { message });
  }

  return (
    <main className="app-shell">
      <section className="game-stage online" aria-label="Online Quoridor game">
        <aside className="side-panel">
          <div className="brand-block">
            <p className="eyebrow">Room {room?.roomId}</p>
            <h1>King's Grid</h1>
            <p className="subtitle">{waiting ? "Waiting for a second player to join." : "Live online match in progress."}</p>
          </div>

          <PlayerCard
            color={myColor ?? "white"}
            title="You"
            username={room?.players?.[myColor]?.username ?? "You"}
            walls={state.players[myColor ?? "white"].walls}
            active={state.currentPlayer === myColor && !state.winner}
            connected
          />
          <PlayerCard
            color={opponentColor}
            title="Opponent"
            username={opponent?.username ?? "Waiting..."}
            walls={state.players[opponentColor].walls}
            active={state.currentPlayer === opponentColor && !state.winner}
            connected={Boolean(opponent?.connected)}
          />

          <div className="tool-panel" aria-label="Wall orientation">
            <div className="tool-title">
              <span>Wall stance</span>
              <strong>{state.players[state.currentPlayer].walls} left</strong>
            </div>
            <div className="segmented">
              <button className={orientation === "horizontal" ? "selected" : ""} type="button" onClick={() => onOrientation("horizontal")}>
                Horizontal
              </button>
              <button className={orientation === "vertical" ? "selected" : ""} type="button" onClick={() => onOrientation("vertical")}>
                Vertical
              </button>
            </div>
          </div>

          <div className={`message-bar ${state.messageType}`}>
            <span>{waiting ? "Share the Room ID with your opponent." : state.message}</span>
          </div>

          <div className="action-row">
            <button className="icon-button" type="button" onClick={onSoundToggle} aria-label={soundEnabled ? "Mute sound" : "Enable sound"} title={soundEnabled ? "Mute sound" : "Enable sound"}>
              {soundEnabled ? <Volume2 size={19} /> : <VolumeX size={19} />}
            </button>
            <button className="icon-button" type="button" onClick={onLeave} aria-label="Leave room" title="Leave room">
              <DoorOpen size={19} />
            </button>
          </div>
        </aside>

        <section className="board-zone">
          <div className={`turn-ribbon ${myTurn ? "mine" : ""}`}>
            <span className={`turn-dot ${state.currentPlayer}`} />
            <span>{getStatusText({ room, state, myTurn, waiting, activePlayer })}</span>
          </div>
          <GameBoard
            state={state}
            legalMoveKeys={legalMoveKeys}
            orientation={orientation}
            preview={preview}
            previewKeys={previewKeys}
            canAct={myTurn}
            onMove={handleMove}
            onWall={handleWall}
            onWallHover={onWallHover}
            flipped={myColor === "black"}
          />
          <div className="goal-labels">
            <span>{PLAYERS.black.label} goal</span>
            <span>{PLAYERS.white.label} goal</span>
          </div>
        </section>

        <aside className="match-panel fixed-info">
          <div className="stat-tile">
            <span>Your color</span>
            <strong>{labelFor(myColor)}</strong>
          </div>
          <div className="stat-tile">
            <span>Opponent color</span>
            <strong>{labelFor(opponentColor)}</strong>
          </div>
          <div className="stat-tile">
            <span>Game status</span>
            <strong>{myTurn ? "Your turn" : state.winner ? `${labelFor(state.winner)} wins` : room?.paused ? "Paused" : "Opponent turn"}</strong>
          </div>
          <div className="rule-card">
            <strong>Server synced</strong>
            <p>Moves, walls, turns, and wins are validated by the Node.js room server.</p>
          </div>
          <ChatPanel messages={chatMessages} myColor={myColor} onSend={handleSendMessage} />
        </aside>
      </section>

      {state.winner && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="winner-title">
          <div className="winner-card">
            <p className="eyebrow">Game complete</p>
            <h2 id="winner-title">{state.winner === myColor ? "You win" : `${labelFor(state.winner)} wins`}</h2>
            <p>{state.message}</p>
            <button type="button" onClick={onLeave}>
              Back to lobby
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function PlayerCard({ color, title, username, walls, active, connected }) {
  return (
    <article className={`player-card ${color} ${active ? "active" : ""}`}>
      <div className={`portrait ${color}`}>
        <span />
      </div>
      <div>
        <p>{title}</p>
        <strong>{username}</strong>
        <span>{labelFor(color)} - {walls} walls - {connected ? "online" : "offline"}</span>
      </div>
    </article>
  );
}

function GameBoard({ state, legalMoveKeys, orientation, preview, previewKeys, canAct, onMove, onWall, onWallHover, flipped }) {
  const placedSegmentKeys = new Set(
    state.walls.flatMap((wall) =>
      getWallSegments(wall.row, wall.col, wall.orientation).map((segment) => `${segment.row}:${segment.col}`)
    )
  );

  return (
    <div className={`board-frame ${flipped ? "flipped" : ""}`}>
      <div className="board-grid" aria-label="9 by 9 Quoridor board">
        {Array.from({ length: MATRIX_SIZE }, (_, row) =>
          Array.from({ length: MATRIX_SIZE }, (_, col) => {
            const key = `${row}:${col}`;
            const spot = CELL_SPOTS.get(key);
            const slotType = getSlotType(row, col);
            const pawn = spot && findPawnAt(state, row, col);
            const isLegal = spot && legalMoveKeys.has(key);
            const isAnchor = canAct && canUseWallAnchor(row, col, orientation);
            const previewActive = preview?.row === row && preview?.col === col && preview?.orientation === orientation;
            const isPreviewSegment = previewKeys.has(key);
            const isPlaced = placedSegmentKeys.has(key);

            if (!spot) {
              return (
                <button
                  className={`matrix-slot ${slotType} ${isPlaced ? "placed" : ""} ${
                    isPreviewSegment ? (preview?.valid ? "preview-valid" : "preview-invalid") : ""
                  } ${isAnchor ? "wall-target" : ""} ${previewActive ? "anchor-preview" : ""}`}
                  disabled={!isAnchor || Boolean(state.winner)}
                  key={key}
                  type="button"
                  onClick={() => onWall(row, col)}
                  onMouseEnter={() => isAnchor && onWallHover({ row, col, orientation })}
                  onMouseLeave={() => onWallHover(null)}
                  aria-label={isAnchor ? `${orientation} wall slot` : undefined}
                />
              );
            }

            return (
              <button
                className={`board-cell ${getTileTone(row, col)} ${isLegal ? "legal" : ""}`}
                disabled={!isLegal || Boolean(state.winner)}
                key={key}
                type="button"
                onClick={() => onMove(row, col)}
                aria-label={`Board square ${spot.boardRow + 1}, ${spot.boardCol + 1}`}
              >
                {isLegal && <span className="move-target" />}
                {pawn && <Pawn color={pawn} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function ChatPanel({ messages, myColor, onSend }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  function submit(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    onSend(message);
    setDraft("");
  }

  return (
    <section className="chat-panel" aria-label="Room chat">
      <div className="chat-header">
        <span>Chat</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="chat-empty">No messages yet.</p>
        ) : (
          messages.map((item) => (
            <article className={`chat-message ${item.color === myColor ? "mine" : ""}`} key={item.id}>
              <strong>{item.username}</strong>
              <p>{item.message}</p>
            </article>
          ))
        )}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          aria-label="Chat message"
          maxLength={280}
          placeholder="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}

function Pawn({ color }) {
  return (
    <span className={`pawn ${color}`}>
      <span className="pawn-crown" />
    </span>
  );
}

function findPawnAt(state, row, col) {
  if (state.players.white.position.row === row && state.players.white.position.col === col) return "white";
  if (state.players.black.position.row === row && state.players.black.position.col === col) return "black";
  return null;
}

function getTileTone(row, col) {
  const file = Math.floor(col / 2);
  const rank = Math.floor(row / 2);
  return (file + rank) % 2 === 0 ? "light" : "dark";
}

function getSlotType(row, col) {
  if (row % 2 === 1 && col % 2 === 0) return "horizontal";
  if (row % 2 === 0 && col % 2 === 1) return "vertical";
  return "crossing";
}

function getStatusText({ room, state, myTurn, waiting, activePlayer }) {
  if (waiting) return "Waiting for opponent";
  if (state.winner) return `${labelFor(state.winner)} wins`;
  if (room?.paused) return "Opponent disconnected";
  return myTurn ? "Your turn" : `${activePlayer.label} to move`;
}

function labelFor(color) {
  return PLAYERS[color]?.label ?? "Unassigned";
}

function makeRoomId() {
  return `ROOM-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

createRoot(document.getElementById("root")).render(<App />);
