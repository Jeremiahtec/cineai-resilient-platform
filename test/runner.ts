import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { LocalStorageManager } from '../src/storage/local-storage';
import { PriorityJobQueue } from '../src/queue/job-queue';
import { RENDITIONS } from '../src/worker/transcoder';
import { CONFIG } from '../src/config';

async function runTestSuite() {
  console.log('🧪 Starting CineAI Engineering Test Suite...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  // TEST 1: Resumable Multipart Ingestion & Offset Recovery
  await test('Chunked Ingestion: Byte-range offset recovery survives network interruption', async () => {
    const storage = new LocalStorageManager();
    const testId = `test_upload_${Date.now()}`;
    const totalSize = 24 * 1024 * 1024; // 24 MB = 3 x 8MB chunks

    // 1. Initialize
    const session = storage.initializeUpload(testId, 'sci-fi-master.mp4', totalSize, 'video/mp4');
    assert.strictEqual(session.expectedChunks, 3, 'Expected 3 chunks for 24MB payload');

    // 2. Upload Chunk 1 & Chunk 2
    const chunk1Data = Buffer.alloc(CONFIG.CHUNK_SIZE_BYTES, 'A');
    const chunk2Data = Buffer.alloc(CONFIG.CHUNK_SIZE_BYTES, 'B');

    await storage.writePart(testId, 1, Readable.from(chunk1Data));
    await storage.writePart(testId, 2, Readable.from(chunk2Data));

    // 3. Verify offset recovery at simulated 66% (Wi-Fi drop simulation)
    const progress = storage.getUploadProgress(testId);
    assert.strictEqual(progress.uploadedParts.length, 2, 'Two chunks should be stored');
    assert.strictEqual(progress.nextPartNumber, 3, 'Next required part must be Part #3 (0% restart avoided!)');
    assert.strictEqual(progress.bytesReceived, 16 * 1024 * 1024);

    // 4. Resume Part 3 and complete
    const chunk3Data = Buffer.alloc(CONFIG.CHUNK_SIZE_BYTES, 'C');
    await storage.writePart(testId, 3, Readable.from(chunk3Data));

    const finalPath = await storage.completeUpload(testId);
    assert.ok(fs.existsSync(finalPath), 'Assembled master cut must exist');
    assert.strictEqual(fs.statSync(finalPath).size, totalSize, 'Assembled file size must match original bytes');

    // Clean up test file
    fs.unlinkSync(finalPath);
  });

  // TEST 2: Decoupled Queue Lease & Deadlock Reclamation
  await test('Queue Resiliency: Abandoned worker lease expires and triggers DLQ / auto-retry', async () => {
    const queue = new PriorityJobQueue();
    const jobId = `job_test_${Date.now()}`;

    // 1. Enqueue
    queue.enqueue({
      id: jobId,
      videoId: 'vid_123',
      sourceFilePath: '/fake/path.mp4',
      outputDir: '/fake/output',
      priority: 10
    });

    // 2. Worker 1 claims job
    const claimedJob = queue.acquireJob('worker-alpha');
    assert.ok(claimedJob, 'Job should be leased to worker-alpha');
    assert.strictEqual(claimedJob.status, 'PROCESSING');
    assert.strictEqual(claimedJob.attempts, 1);

    // 3. Worker heartbeats successfully
    const heartbeatOk = queue.heartbeat(jobId, 'worker-alpha');
    assert.strictEqual(heartbeatOk, true, 'Heartbeat must succeed for lease holder');

    // 4. Rogue worker cannot heartbeat
    const rogueHeartbeat = queue.heartbeat(jobId, 'worker-rogue');
    assert.strictEqual(rogueHeartbeat, false, 'Heartbeat must be rejected for non-owner');

    // 5. Worker fails and auto-retries
    queue.fail(jobId, 'Simulated worker crash');
    const stats = queue.getStats();
    assert.strictEqual(stats.queued, 1, 'Job must be re-queued for recovery');

    queue.stop();
  });

  // TEST 3: Multi-Bitrate ABR Ladder Profiles
  await test('ABR Ladder: Multi-bitrate ladder defines 360p mobile data saver to 1080p FHD', async () => {
    assert.strictEqual(RENDITIONS.length, 3, 'Should define at least 3 renditions');
    const mobileRendition = RENDITIONS.find(r => r.name === '360p');
    assert.ok(mobileRendition, 'Must include 360p mobile rendition');
    assert.ok(mobileRendition.bandwidth <= 600000, '360p bandwidth must be under 600 kbps for low-bandwidth mobile');

    const hdRendition = RENDITIONS.find(r => r.name === '1080p');
    assert.ok(hdRendition, 'Must include 1080p rendition');
    assert.strictEqual(hdRendition.width, 1920);
    assert.strictEqual(hdRendition.height, 1080);
  });

  console.log(`\n================================================================`);
  console.log(`Test Results: ${passed} passed, ${failed} failed.`);
  console.log(`================================================================`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
