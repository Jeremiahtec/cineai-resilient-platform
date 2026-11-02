import { Router, Request, Response } from 'express';
import { storageManager } from '../storage/local-storage';
import { jobQueue } from '../queue/job-queue';
import { CONFIG } from '../config';

export const uploadRouter = Router();

/**
 * 1. Initialize Upload Ticket.
 * Issues chunking configuration and allocates direct storage partition.
 */
uploadRouter.post('/initialize', (req: Request, res: Response) => {
  const { filename, sizeBytes, mimeType } = req.body;

  if (!filename || !sizeBytes) {
    res.status(400).json({ error: 'filename and sizeBytes are required.' });
    return;
  }

  const uploadId = `vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const session = storageManager.initializeUpload(uploadId, filename, Number(sizeBytes), mimeType || 'video/mp4');

  res.status(201).json({
    uploadId: session.id,
    chunkSizeBytes: CONFIG.CHUNK_SIZE_BYTES,
    expectedChunks: session.expectedChunks,
    directUploadEndpoint: `/api/v1/uploads/${session.id}/part`
  });
});

/**
 * 2. Upload Chunk (Direct Streaming).
 * Writes incoming bytes directly to disk via stream pipe.
 * Zero buffering in process heap memory.
 */
uploadRouter.put('/:id/part/:partNumber', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const partNum = parseInt(String(req.params.partNumber), 10);

  if (isNaN(partNum) || partNum < 1) {
    res.status(400).json({ error: 'Invalid part number.' });
    return;
  }

  try {
    const result = await storageManager.writePart(id, partNum, req);
    res.status(200).json({
      success: true,
      partNumber: result.partNumber,
      sizeBytes: result.sizeBytes
    });
  } catch (err: any) {
    console.error(`[UPLOAD] Error streaming part #${partNum} for upload ${id}:`, err);
    res.status(500).json({ error: err.message || 'Failed to stream chunk.' });
  }
});

/**
 * 3. Offset Discovery & Recovery.
 * Allows client to query exactly which chunks were acknowledged,
 * preventing restart from byte zero when network drops at 85%.
 */
uploadRouter.get('/:id/offset', (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const progress = storageManager.getUploadProgress(id);
    res.status(200).json(progress);
  } catch (err: any) {
    res.status(404).json({ error: err.message || 'Session not found.' });
  }
});

/**
 * 4. Complete Upload.
 * Assembles chunks into single master file and triggers async transcoding queue.
 */
uploadRouter.post('/:id/complete', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const masterFilePath = await storageManager.completeUpload(id);

    // Enqueue transcoding job into decoupled worker queue
    const session = storageManager.getSession(id);
    if (session) {
      session.status = 'QUEUED';
    }

    const job = jobQueue.enqueue({
      id: `job_${id}`,
      videoId: id,
      sourceFilePath: masterFilePath,
      outputDir: CONFIG.PROCESSED_STORAGE_DIR,
      priority: 10
    });

    res.status(200).json({
      success: true,
      message: 'Upload assembled and queued for ABR transcoding.',
      jobId: job.id,
      status: 'QUEUED'
    });
  } catch (err: any) {
    console.error(`[COMPLETE] Failed to finalize upload ${id}:`, err);
    res.status(500).json({ error: err.message || 'Failed to complete upload.' });
  }
});

/**
 * 5. Status Endpoint.
 */
uploadRouter.get('/:id/status', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const session = storageManager.getSession(id);

  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }

  res.status(200).json({
    id: session.id,
    filename: session.filename,
    status: session.status,
    hlsMasterUrl: session.hlsMasterUrl,
    error: session.error,
    updatedAt: session.updatedAt
  });
});
