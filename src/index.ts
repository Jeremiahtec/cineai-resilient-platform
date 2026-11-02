import express from 'express';
import cors from 'cors';
import path from 'path';
import { CONFIG } from './config';
import { uploadRouter } from './api/upload.routes';
import { playbackRouter } from './api/playback.routes';
import { transcodeWorker } from './worker/transcoder';
import { jobQueue } from './queue/job-queue';

const app = express();

// Enable CORS
app.use(cors());

// Parse JSON metadata payloads only (Note: video chunks stream directly via req without JSON buffering!)
app.use(express.json({ limit: '1mb' }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Mount API Routers
app.use('/api/v1/uploads', uploadRouter);
app.use('/', playbackRouter);

// Start Server
const server = app.listen(CONFIG.PORT, () => {
  console.log(`================================================================`);
  console.log(`🚀 CineAI Resilient Streaming Platform running on port ${CONFIG.PORT}`);
  console.log(`📡 Ingestion Engine: Direct-to-storage resumable streaming`);
  console.log(`⚙️  Transcoder Fleet: Two-pass FFmpeg with CFR A/V normalization`);
  console.log(`📺 Frontend UI: http://localhost:${CONFIG.PORT}`);
  console.log(`================================================================`);

  // Start background transcoding worker
  transcodeWorker.start();
});

// Graceful Shutdown
function shutdown() {
  console.log('\n[CineAI] Initiating graceful shutdown...');
  transcodeWorker.stop();
  jobQueue.stop();
  server.close(() => {
    console.log('[CineAI] All services closed safely.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
