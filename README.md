# EchoMesh - Signaling & Moderation Server

Production-ready, decoupled WebRTC signaling and real-time moderation backend for **EchoMesh** (Audio-Only Raw WebRTC P2P Mesh).

## 🚀 Features
- **Pure JavaScript (ES Modules):** Clean modern JavaScript with no build steps or transpilation required.
- **In-Memory Ephemeral Storage:** Absolutely zero database persistence. Rooms and participants live in memory and are deleted immediately once empty.
- **Raw WebRTC 1-to-1 Signaling Relay:** Offer, answer, and ICE candidate exchange via Socket.io targeting specific peer socket IDs.
- **Moderation Protocol:** Host privileges for kicking users, room setting toggles (speaking/chat toggles, capacity limit), and individual muting.
- **Zero-Persistence Ephemeral Text Chat:** Real-time text broadcast relay without server storage.
- **Decoupled Architecture:** Readily serves web browsers, React Native, Flutter, and Capacitor clients.

## 🛠️ Stack
- Node.js (ESM `type: "module"`)
- Express
- Socket.io
- CORS, Dotenv, Nanoid

## 📦 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Default configuration:
```env
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
```

### 3. Start the Server
```bash
# Production mode
npm start

# Development mode with auto-reload
npm run dev
```

Server listens on `http://localhost:5000` (or `PORT`). Health check is available at `GET /health`.