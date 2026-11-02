import path from 'path';
import fs from 'fs';

// Try to resolve @ffmpeg-installer and @ffprobe-installer paths
let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller && ffmpegInstaller.path) {
    ffmpegPath = ffmpegInstaller.path;
  }
} catch {
  // Use system ffmpeg
}

try {
  const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  if (ffprobeInstaller && ffprobeInstaller.path) {
    ffprobePath = ffprobeInstaller.path;
  }
} catch {
  // Use system ffprobe
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Storage Directories
  MASTER_STORAGE_DIR: process.env.MASTER_STORAGE_PATH || path.join(process.cwd(), 'storage_master'),
  PROCESSED_STORAGE_DIR: process.env.PROCESSED_STORAGE_PATH || path.join(process.cwd(), 'storage_processed'),
  
  // Chunking parameters (8 MB chunks per standard S3 multipart recommendations)
  CHUNK_SIZE_BYTES: 8 * 1024 * 1024,
  
  // Binary Paths
  FFMPEG_PATH: process.env.FFMPEG_PATH || ffmpegPath,
  FFPROBE_PATH: process.env.FFPROBE_PATH || ffprobePath,
  
  // Transcoding profiles
  HLS_SEGMENT_DURATION: 2, // 2-second segments
  KEYFRAME_INTERVAL: 48,   // 2s * 24fps
  
  // Worker & Lease parameters
  WORKER_HEARTBEAT_INTERVAL_MS: 10_000,
  WORKER_LEASE_TIMEOUT_MS: 30_000,
  MAX_RETRY_ATTEMPTS: 3
};

// Ensure directories exist
if (!fs.existsSync(CONFIG.MASTER_STORAGE_DIR)) {
  fs.mkdirSync(CONFIG.MASTER_STORAGE_DIR, { recursive: true });
}
if (!fs.existsSync(CONFIG.PROCESSED_STORAGE_DIR)) {
  fs.mkdirSync(CONFIG.PROCESSED_STORAGE_DIR, { recursive: true });
}
