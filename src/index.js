import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { registerSocketHandlers } from './socketHandlers.js';
import { rooms, serializeRoom, getAllActiveRoomsSummary } from './rooms.js';

dotenv.config();

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const app = express();

// Determine CORS origins
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, capacitor, postman)
    if (!origin) return callback(null, true);

    if (CLIENT_ORIGIN === '*' || CLIENT_ORIGIN === origin) {
      return callback(null, true);
    }

    // Support comma-separated list of allowed origins in CLIENT_ORIGIN
    const allowedList = CLIENT_ORIGIN.split(',').map((o) => o.trim());
    if (allowedList.includes(origin) || allowedList.includes('*')) {
      return callback(null, true);
    }

    // Default allow for local development
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Basic health check for Render / Cloud monitoring
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'EchoMesh Signaling Server',
    uptime: process.uptime(),
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Ephemeral room list summary (for debugging or stats, does not leak sensitive data)
app.get('/api/stats', (req, res) => {
  let totalParticipants = 0;
  for (const room of rooms.values()) {
    totalParticipants += room.participants.size;
  }
  res.status(200).json({
    totalActiveRooms: rooms.size,
    totalActiveParticipants: totalParticipants
  });
});

// List all active rooms with participant counts and metadata
app.get('/api/rooms', (req, res) => {
  const activeRooms = getAllActiveRoomsSummary();
  res.status(200).json({
    success: true,
    count: activeRooms.length,
    rooms: activeRooms
  });
});

// Check if a specific room exists
app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId?.toLowerCase());
  if (!room) {
    return res.status(404).json({ exists: false, error: 'Room not found' });
  }
  res.status(200).json({
    exists: true,
    room: {
      id: room.id,
      participantCount: room.participants.size,
      maxParticipants: room.maxParticipants,
      allowChat: room.allowChat,
      allowSpeaking: room.allowSpeaking
    }
  });
});

const server = http.createServer(app);

// Socket.io initialization with decoupled CORS support
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (CLIENT_ORIGIN === '*' || CLIENT_ORIGIN === origin) return callback(null, true);
      const allowedList = CLIENT_ORIGIN.split(',').map((o) => o.trim());
      if (allowedList.includes(origin) || allowedList.includes('*')) return callback(null, true);
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return callback(null, true);
      return callback(null, true); // Fallback allow for WebRTC signaling clients
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

io.on('connection', (socket) => {
  registerSocketHandlers(io, socket);
});

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🎙️  EchoMesh Signaling Server running on :${PORT}`);
  console.log(`🌐 Allowed Origins: ${CLIENT_ORIGIN}`);
  console.log(`📡 In-Memory Ephemeral Room State Active`);
  console.log(`===============================================`);
});
