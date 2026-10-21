import { nanoid } from 'nanoid';
import yts from 'yt-search';
import {
  rooms,
  serializeRoom,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  handleSocketDisconnect,
  findRoomBySocketId,
  kickUser,
  updateRoomSettings,
  muteUser,
  canSendMessage,
  getAllActiveRoomsSummary,
  registerBrowserSession,
  updateParticipantMedia
} from './rooms.js';

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Register all Socket.io events
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerSocketHandlers(io, socket) {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  const broadcastActiveRooms = () => {
    io.emit('active-rooms-updated', getAllActiveRoomsSummary());
  };

  /**
   * Enforce 1 active room per browser session
   * Kicks / cleans up any previous room connection in the same browser (or another tab)
   */
  const handleSingleBrowserSession = (browserId, currentSocket, newRoomId) => {
    // 1. If this same socket was already in another room, clean it up
    const existing = findRoomBySocketId(currentSocket.id);
    if (existing && existing.roomId !== newRoomId) {
      currentSocket.leave(existing.roomId);
      const leaveRes = leaveRoom(existing.roomId, currentSocket.id);
      if (leaveRes) {
        io.to(existing.roomId).emit('user-left', { socketId: currentSocket.id });
        if (leaveRes.newOwnerId) {
          io.to(existing.roomId).emit('owner-updated', { newOwnerId: leaveRes.newOwnerId });
        }
      }
    }

    // 2. If another tab with the same browserId was in a room, disconnect it
    if (browserId) {
      const prevSession = registerBrowserSession(browserId, currentSocket.id, newRoomId);
      if (prevSession && prevSession.socketId !== currentSocket.id) {
        console.log(`[Browser Session Replaced] Browser ID: ${browserId} moved to new room. Kicking socket: ${prevSession.socketId}`);
        const prevSocket = io.sockets.sockets.get(prevSession.socketId);
        if (prevSocket) {
          prevSocket.leave(prevSession.roomId);
          prevSocket.emit('kicked', {
            reason: 'You joined another room from another tab in this browser. Only one active room per browser is allowed.'
          });
        }
        const leaveRes = leaveRoom(prevSession.roomId, prevSession.socketId);
        if (leaveRes) {
          io.to(prevSession.roomId).emit('user-left', { socketId: prevSession.socketId });
          if (leaveRes.newOwnerId) {
            io.to(prevSession.roomId).emit('owner-updated', { newOwnerId: leaveRes.newOwnerId });
          }
        }
      }
    }
  };

  // Send current active rooms immediately on connection
  socket.emit('active-rooms-updated', getAllActiveRoomsSummary());

  // get-active-rooms
  socket.on('get-active-rooms', (callback) => {
    const list = getAllActiveRoomsSummary();
    if (typeof callback === 'function') {
      callback({ success: true, rooms: list });
    }
    socket.emit('active-rooms-updated', list);
  });

  // --------------------------------------------------------------------------
  // 1. Room Lifecycle
  // --------------------------------------------------------------------------

  // create-room: { username, maxParticipants, browserId }
  socket.on('create-room', ({ username, maxParticipants, browserId }, callback) => {
    try {
      const clientBrowserId = browserId || socket.handshake.auth?.browserId;
      handleSingleBrowserSession(clientBrowserId, socket, null);

      const { room, participant } = createRoom(socket.id, username, maxParticipants, clientBrowserId);
      socket.join(room.id);
      registerBrowserSession(clientBrowserId, socket.id, room.id);

      console.log(`[Room Created] Room ID: ${room.id} by ${username} (${socket.id})`);

      const responsePayload = {
        roomId: room.id,
        participantId: socket.id,
        roomSettings: {
          id: room.id,
          ownerSocketId: room.ownerSocketId,
          maxParticipants: room.maxParticipants,
          allowChat: room.allowChat,
          allowSpeaking: room.allowSpeaking
        },
        participants: Array.from(room.participants.values()),
        iceServers: STUN_SERVERS
      };

      if (typeof callback === 'function') {
        callback({ success: true, ...responsePayload });
      }

      socket.emit('room-created', responsePayload);
      broadcastActiveRooms();
    } catch (err) {
      console.error('[create-room error]', err);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Failed to create room' });
      }
    }
  });

  // join-room: { roomId, username, browserId }
  socket.on('join-room', ({ roomId, username, browserId }, callback) => {
    try {
      const cleanRoomId = (roomId || '').trim().toLowerCase();
      const clientBrowserId = browserId || socket.handshake.auth?.browserId;
      handleSingleBrowserSession(clientBrowserId, socket, cleanRoomId);

      const result = joinRoom(cleanRoomId, socket.id, username, clientBrowserId);

      if (result.error) {
        if (typeof callback === 'function') {
          callback({ success: false, error: result.error });
        }
        socket.emit('join-error', { message: result.error });
        return;
      }

      const { room, participant } = result;
      registerBrowserSession(clientBrowserId, socket.id, cleanRoomId);
      socket.join(cleanRoomId);

      console.log(`[User Joined] ${participant.username} (${socket.id}) -> Room: ${cleanRoomId}`);

      const responsePayload = {
        roomId: cleanRoomId,
        participantId: socket.id,
        roomSettings: {
          id: room.id,
          ownerSocketId: room.ownerSocketId,
          maxParticipants: room.maxParticipants,
          allowChat: room.allowChat,
          allowSpeaking: room.allowSpeaking
        },
        participants: Array.from(room.participants.values()),
        iceServers: STUN_SERVERS
      };

      if (typeof callback === 'function') {
        callback({ success: true, ...responsePayload });
      }

      // Send to joining socket
      socket.emit('room-joined', responsePayload);

      // Notify all other sockets in the room
      socket.to(cleanRoomId).emit('user-joined', {
        socketId: socket.id,
        username: participant.username,
        isOwner: participant.isOwner,
        isMuted: participant.isMuted,
        isChatMuted: participant.isChatMuted
      });

      broadcastActiveRooms();
    } catch (err) {
      console.error('[join-room error]', err);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Failed to join room' });
      }
    }
  });

  // leave-room: { roomId }
  socket.on('leave-room', ({ roomId } = {}, callback) => {
    try {
      const found = roomId ? { roomId, room: getRoom(roomId) } : findRoomBySocketId(socket.id);
      if (!found || !found.roomId) {
        if (typeof callback === 'function') callback({ success: true });
        return;
      }

      const currentRoomId = found.roomId;
      const leaveResult = leaveRoom(currentRoomId, socket.id);
      socket.leave(currentRoomId);

      if (leaveResult) {
        console.log(`[User Left] ${socket.id} left room ${currentRoomId}. Remaining: ${leaveResult.remainingCount}`);
        socket.to(currentRoomId).emit('user-left', { socketId: socket.id });

        if (leaveResult.newOwnerId) {
          console.log(`[Owner Updated] New owner for ${currentRoomId}: ${leaveResult.newOwnerId}`);
          io.to(currentRoomId).emit('owner-updated', { newOwnerId: leaveResult.newOwnerId });
        }

        broadcastActiveRooms();
      }

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (err) {
      console.error('[leave-room error]', err);
    }
  });

  // --------------------------------------------------------------------------
  // 2. Raw WebRTC Signaling Relay (1-to-1 routing via target socket IDs)
  // --------------------------------------------------------------------------

  // signal-offer: { targetId, sdp }
  socket.on('signal-offer', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('signal-offer', {
      callerId: socket.id,
      targetId,
      sdp
    });
  });

  // signal-answer: { targetId, sdp }
  socket.on('signal-answer', ({ targetId, sdp }) => {
    if (!targetId || !sdp) return;
    io.to(targetId).emit('signal-answer', {
      callerId: socket.id,
      targetId,
      sdp
    });
  });

  // signal-ice-candidate: { targetId, candidate }
  socket.on('signal-ice-candidate', ({ targetId, candidate }) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit('signal-ice-candidate', {
      callerId: socket.id,
      targetId,
      candidate
    });
  });

  // --------------------------------------------------------------------------
  // 3. Room Owner Admin & Moderation Controls
  // --------------------------------------------------------------------------

  // kick-user: { roomId, targetId }
  socket.on('kick-user', ({ roomId, targetId }, callback) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
        return;
      }

      const res = kickUser(activeRoom.id, socket.id, targetId);
      if (res.error) {
        if (typeof callback === 'function') callback({ success: false, error: res.error });
        return;
      }

      // Force target socket to leave socket.io room
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.leave(activeRoom.id);
        targetSocket.emit('kicked', {
          reason: 'You have been removed from the room by the host'
        });
      }

      // Broadcast user-left to remaining peers
      io.to(activeRoom.id).emit('user-left', { socketId: targetId });
      broadcastActiveRooms();

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (err) {
      console.error('[kick-user error]', err);
    }
  });

  // update-room-settings: { roomId, maxParticipants, allowChat, allowSpeaking }
  socket.on('update-room-settings', ({ roomId, maxParticipants, allowChat, allowSpeaking }, callback) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
        return;
      }

      const res = updateRoomSettings(activeRoom.id, socket.id, {
        maxParticipants,
        allowChat,
        allowSpeaking
      });

      if (res.error) {
        if (typeof callback === 'function') callback({ success: false, error: res.error });
        return;
      }

      // Broadcast room settings update to all participants in the room
      io.to(activeRoom.id).emit('room-settings-updated', res.roomSettings);
      broadcastActiveRooms();

      if (typeof callback === 'function') {
        callback({ success: true, settings: res.roomSettings });
      }
    } catch (err) {
      console.error('[update-room-settings error]', err);
    }
  });

  // mute-user: { roomId, targetId, muteSpeaking, muteChat }
  socket.on('mute-user', ({ roomId, targetId, muteSpeaking, muteChat }, callback) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
        return;
      }

      const res = muteUser(activeRoom.id, socket.id, targetId, muteSpeaking, muteChat);
      if (res.error) {
        if (typeof callback === 'function') callback({ success: false, error: res.error });
        return;
      }

      // Notify the room of moderation mute
      io.to(activeRoom.id).emit('user-muted', {
        targetId,
        muteSpeaking,
        muteChat
      });

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } catch (err) {
      console.error('[mute-user error]', err);
    }
  });

  // Client voluntary mic toggle (self mute/unmute state broadcast)
  socket.on('toggle-audio-state', ({ roomId, isMuted }) => {
    const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
    if (!activeRoom) return;

    const participant = activeRoom.participants.get(socket.id);
    if (participant) {
      participant.isMuted = Boolean(isMuted);
      socket.to(activeRoom.id).emit('user-audio-state-changed', {
        socketId: socket.id,
        isMuted: participant.isMuted
      });
    }
  });

  // --------------------------------------------------------------------------
  // YouTube Watch Together & Synchronized Playback Relay
  // --------------------------------------------------------------------------

  // broadcast-youtube-state: { roomId, videoId, title, currentTime, isPlaying }
  socket.on('broadcast-youtube-state', ({ roomId, videoId, title, currentTime, isPlaying }) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) return;

      const mediaState = updateParticipantMedia(activeRoom.id, socket.id, {
        broadcasterId: socket.id,
        videoId,
        title: title || 'YouTube Video',
        currentTime: Number(currentTime) || 0,
        isPlaying: Boolean(isPlaying)
      });

      if (mediaState) {
        socket.to(activeRoom.id).emit('peer-youtube-updated', {
          socketId: socket.id,
          mediaState
        });
      }
    } catch (err) {
      console.error('[broadcast-youtube-state error]', err);
    }
  });

  // youtube-player-action: { roomId, action, currentTime } ('play' | 'pause' | 'seek')
  socket.on('youtube-player-action', ({ roomId, action, currentTime }) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) return;

      const participant = activeRoom.participants.get(socket.id);
      if (participant && participant.mediaState) {
        participant.mediaState.currentTime = Number(currentTime) || 0;
        participant.mediaState.updatedAt = Date.now();
        if (action === 'play') participant.mediaState.isPlaying = true;
        if (action === 'pause') participant.mediaState.isPlaying = false;
      }

      socket.to(activeRoom.id).emit('peer-youtube-action', {
        broadcasterId: socket.id,
        action,
        currentTime: Number(currentTime) || 0,
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('[youtube-player-action error]', err);
    }
  });

  // stop-youtube: { roomId }
  socket.on('stop-youtube', ({ roomId }) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) return;

      updateParticipantMedia(activeRoom.id, socket.id, null);

      io.to(activeRoom.id).emit('peer-youtube-stopped', {
        socketId: socket.id
      });
    } catch (err) {
      console.error('[stop-youtube error]', err);
    }
  });

  // search-youtube: { query }, callback({ success, videos, error })
  socket.on('search-youtube', async ({ query }, callback) => {
    try {
      if (!query || typeof query !== 'string' || !query.trim()) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Query string is required', videos: [] });
        }
        return;
      }

      const searchResults = await yts(query.trim());
      const rawVideos = searchResults?.videos || [];

      const videos = rawVideos.slice(0, 15).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        thumbnail: v.thumbnail || v.image,
        duration: v.timestamp || '',
        seconds: v.seconds || 0,
        views: v.views ? Number(v.views).toLocaleString() : '',
        author: v.author?.name || 'YouTube Creator',
        ago: v.ago || ''
      }));

      if (typeof callback === 'function') {
        callback({ success: true, videos });
      }
    } catch (err) {
      console.error('[search-youtube error]', err);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Failed to search YouTube videos', videos: [] });
      }
    }
  });

  // --------------------------------------------------------------------------
  // 4. Ephemeral Text Chat Relay
  // --------------------------------------------------------------------------

  // send-message: { roomId, text }
  socket.on('send-message', ({ roomId, text }, callback) => {
    try {
      const activeRoom = roomId ? getRoom(roomId) : findRoomBySocketId(socket.id)?.room;
      if (!activeRoom) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
        return;
      }

      const check = canSendMessage(activeRoom.id, socket.id);
      if (!check.allowed) {
        if (typeof callback === 'function') callback({ success: false, error: check.reason });
        socket.emit('chat-error', { message: check.reason });
        return;
      }

      const trimmedText = (text || '').trim();
      if (!trimmedText) return;

      const messagePayload = {
        id: nanoid(),
        senderId: socket.id,
        username: check.username,
        text: trimmedText.slice(0, 1000), // Protect against oversize payloads
        timestamp: Date.now()
      };

      // Broadcast to all participants in room including sender
      io.to(activeRoom.id).emit('new-message', messagePayload);

      if (typeof callback === 'function') {
        callback({ success: true, message: messagePayload });
      }
    } catch (err) {
      console.error('[send-message error]', err);
    }
  });

  // --------------------------------------------------------------------------
  // 5. Disconnect Cleanup
  // --------------------------------------------------------------------------

  socket.on('disconnecting', () => {
    handleLeaveAll();
  });

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
  });

  function handleLeaveAll() {
    const found = findRoomBySocketId(socket.id);
    if (!found) return;

    const currentRoomId = found.roomId;
    const leaveResult = leaveRoom(currentRoomId, socket.id);

    if (leaveResult) {
      console.log(`[Disconnect Cleanup] ${socket.id} removed from ${currentRoomId}`);
      socket.to(currentRoomId).emit('user-left', { socketId: socket.id });

      if (leaveResult.newOwnerId) {
        io.to(currentRoomId).emit('owner-updated', { newOwnerId: leaveResult.newOwnerId });
      }

      broadcastActiveRooms();
    }
  }
}
