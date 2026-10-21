import { nanoid } from 'nanoid';
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
  canSendMessage
} from './rooms.js';

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Register all Socket.io events
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerSocketHandlers(io, socket) {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // --------------------------------------------------------------------------
  // 1. Room Lifecycle
  // --------------------------------------------------------------------------

  // create-room: { username, maxParticipants }
  socket.on('create-room', ({ username, maxParticipants }, callback) => {
    try {
      const { room, participant } = createRoom(socket.id, username, maxParticipants);
      socket.join(room.id);

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
    } catch (err) {
      console.error('[create-room error]', err);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Failed to create room' });
      }
    }
  });

  // join-room: { roomId, username }
  socket.on('join-room', ({ roomId, username }, callback) => {
    try {
      const cleanRoomId = (roomId || '').trim().toLowerCase();
      const result = joinRoom(cleanRoomId, socket.id, username);

      if (result.error) {
        if (typeof callback === 'function') {
          callback({ success: false, error: result.error });
        }
        socket.emit('join-error', { message: result.error });
        return;
      }

      const { room, participant } = result;
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
    }
  }
}
