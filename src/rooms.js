import { nanoid } from 'nanoid';

/**
 * In-Memory Ephemeral Storage
 * rooms: Map<roomId, roomObject>
 * roomObject: {
 *   id: string,
 *   ownerSocketId: string,
 *   maxParticipants: number,
 *   allowChat: boolean,
 *   allowSpeaking: boolean,
 *   participants: Map<socketId, { socketId, username, isOwner, isMuted, isChatMuted }>
 * }
 */
export const rooms = new Map();

/**
 * Helper to serialize room state for clients (converts participants Map to Array)
 */
export function serializeRoom(room) {
  if (!room) return null;
  return {
    id: room.id,
    ownerSocketId: room.ownerSocketId,
    maxParticipants: room.maxParticipants,
    allowChat: room.allowChat,
    allowSpeaking: room.allowSpeaking,
    participants: Array.from(room.participants.values())
  };
}

/**
 * Generate a friendly alphanumeric room ID (e.g. "echo-7f2a")
 */
export function generateRoomId() {
  const code = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  return `echo-${code}`;
}

/**
 * Create a new ephemeral voice room
 */
export function createRoom(ownerSocketId, username, maxParticipants = 10) {
  const parsedMax = Math.min(Math.max(parseInt(maxParticipants, 10) || 10, 2), 10);
  const roomId = generateRoomId();

  const hostParticipant = {
    socketId: ownerSocketId,
    username: username || 'Host',
    isOwner: true,
    isMuted: false,
    isChatMuted: false
  };

  const participants = new Map();
  participants.set(ownerSocketId, hostParticipant);

  const room = {
    id: roomId,
    ownerSocketId,
    maxParticipants: parsedMax,
    allowChat: true,
    allowSpeaking: true,
    participants
  };

  rooms.set(roomId, room);

  return {
    room,
    participant: hostParticipant
  };
}

/**
 * Get room by ID
 */
export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

/**
 * Join an existing room
 */
export function joinRoom(roomId, socketId, username) {
  const room = rooms.get(roomId);
  if (!room) {
    return { error: 'Room not found' };
  }

  if (room.participants.size >= room.maxParticipants) {
    return { error: 'Room is full' };
  }

  const newParticipant = {
    socketId,
    username: username || `User_${socketId.slice(0, 4)}`,
    isOwner: room.ownerSocketId === socketId,
    isMuted: !room.allowSpeaking,
    isChatMuted: !room.allowChat
  };

  room.participants.set(socketId, newParticipant);

  return {
    room,
    participant: newParticipant
  };
}

/**
 * Leave a room and handle ownership succession or room deletion
 */
export function leaveRoom(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const user = room.participants.get(socketId);
  room.participants.delete(socketId);

  let newOwnerId = null;
  let roomDeleted = false;

  if (room.participants.size === 0) {
    rooms.delete(roomId);
    roomDeleted = true;
  } else if (room.ownerSocketId === socketId) {
    // Reassign ownership to the oldest participant in the Map
    const oldestSocketId = room.participants.keys().next().value;
    room.ownerSocketId = oldestSocketId;
    const newOwner = room.participants.get(oldestSocketId);
    if (newOwner) {
      newOwner.isOwner = true;
    }
    newOwnerId = oldestSocketId;
  }

  return {
    roomId,
    user,
    newOwnerId,
    roomDeleted,
    remainingCount: room.participants.size
  };
}

/**
 * Find which room a socket currently belongs to
 */
export function findRoomBySocketId(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.has(socketId)) {
      return { roomId, room };
    }
  }
  return null;
}

/**
 * Handle disconnect for a socket
 */
export function handleSocketDisconnect(socketId) {
  const found = findRoomBySocketId(socketId);
  if (!found) return null;

  return leaveRoom(found.roomId, socketId);
}

/**
 * Kick a participant (moderation)
 */
export function kickUser(roomId, requesterSocketId, targetSocketId) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Room not found' };

  if (room.ownerSocketId !== requesterSocketId) {
    return { error: 'Unauthorized: Only the room owner can kick users' };
  }

  if (targetSocketId === requesterSocketId) {
    return { error: 'Owner cannot kick themselves' };
  }

  if (!room.participants.has(targetSocketId)) {
    return { error: 'Target user is not in this room' };
  }

  const result = leaveRoom(roomId, targetSocketId);
  return { success: true, result };
}

/**
 * Update room settings (moderation)
 */
export function updateRoomSettings(roomId, requesterSocketId, settings) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Room not found' };

  if (room.ownerSocketId !== requesterSocketId) {
    return { error: 'Unauthorized: Only the room owner can update settings' };
  }

  if (typeof settings.maxParticipants === 'number') {
    room.maxParticipants = Math.min(Math.max(settings.maxParticipants, 2), 10);
  }
  if (typeof settings.allowChat === 'boolean') {
    room.allowChat = settings.allowChat;
  }
  if (typeof settings.allowSpeaking === 'boolean') {
    room.allowSpeaking = settings.allowSpeaking;
  }

  return {
    success: true,
    roomSettings: {
      id: room.id,
      ownerSocketId: room.ownerSocketId,
      maxParticipants: room.maxParticipants,
      allowChat: room.allowChat,
      allowSpeaking: room.allowSpeaking
    }
  };
}

/**
 * Mute user speaking or chat (moderation)
 */
export function muteUser(roomId, requesterSocketId, targetSocketId, muteSpeaking, muteChat) {
  const room = rooms.get(roomId);
  if (!room) return { error: 'Room not found' };

  if (room.ownerSocketId !== requesterSocketId) {
    return { error: 'Unauthorized: Only the room owner can mute participants' };
  }

  const target = room.participants.get(targetSocketId);
  if (!target) {
    return { error: 'Participant not found' };
  }

  if (typeof muteSpeaking === 'boolean') {
    target.isMuted = muteSpeaking;
  }
  if (typeof muteChat === 'boolean') {
    target.isChatMuted = muteChat;
  }

  return {
    success: true,
    target: { ...target }
  };
}

/**
 * Check if user can send a message
 */
export function canSendMessage(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return { allowed: false, reason: 'Room does not exist' };
  if (!room.allowChat) return { allowed: false, reason: 'Chat is currently disabled in this room' };

  const participant = room.participants.get(socketId);
  if (!participant) return { allowed: false, reason: 'You are not in this room' };
  if (participant.isChatMuted) return { allowed: false, reason: 'You have been muted from chat by the host' };

  return { allowed: true, username: participant.username };
}
