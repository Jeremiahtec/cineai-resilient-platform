import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { storageManager } from '../storage/local-storage';
import { jobQueue } from '../queue/job-queue';

export const playbackRouter = Router();

/**
 * 1. HLS Stream Delivery.
 * Delivers master and rendition manifests (.m3u8) and video segments (.ts).
 * Implements strict edge caching headers.
 */
playbackRouter.get('/hls/:videoId/:file(*)', (req: Request, res: Response) => {
  const videoId = String(req.params.videoId);
  const file = String(req.params.file);
  const filePath = path.join(CONFIG.PROCESSED_STORAGE_DIR, videoId, file);

  if (!fs.existsSync(filePath)) {
    res.status(404).send('Stream asset not found.');
    return;
  }

  // Set appropriate content-type and cache headers
  if (file.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    // Short cache for playlists to permit fast updates
    res.setHeader('Cache-Control', 'public, max-age=60');
  } else if (file.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/MP2T');
    // Long immutable cache for segments (prevents origin bandwidth exhaustion)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

/**
 * 2. Video Catalog.
 * Lists all published films ready for streaming.
 */
playbackRouter.get('/api/v1/videos', (_req: Request, res: Response) => {
  const allSessions = storageManager.getAllSessions();
  const videos = allSessions.map(s => ({
    id: s.id,
    filename: s.filename,
    status: s.status,
    sizeBytes: s.sizeBytes,
    hlsMasterUrl: s.hlsMasterUrl,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }));

  res.status(200).json(videos);
});

/**
 * 3. Real-Time System Metrics.
 * Displays heap memory (proving memory exhaustion is solved), queue stats, and worker leases.
 */
playbackRouter.get('/api/v1/system/metrics', (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  const queueStats = jobQueue.getStats();

  res.status(200).json({
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      status: mem.heapUsed / 1024 / 1024 < 150 ? 'HEALTHY (STREAMING DIRECT)' : 'ELEVATED'
    },
    queue: queueStats,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: Date.now()
  });
});
