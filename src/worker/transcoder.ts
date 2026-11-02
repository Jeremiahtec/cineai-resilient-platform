import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { CONFIG } from '../config';
import { jobQueue, TranscodeJob } from '../queue/job-queue';
import { storageManager } from '../storage/local-storage';

// Configure fluent-ffmpeg binary paths
ffmpeg.setFfmpegPath(CONFIG.FFMPEG_PATH);
ffmpeg.setFfprobePath(CONFIG.FFPROBE_PATH);

export interface RenditionProfile {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  bandwidth: number;
}

export const RENDITIONS: RenditionProfile[] = [
  {
    name: '360p',
    width: 640,
    height: 360,
    videoBitrate: '450k',
    audioBitrate: '96k',
    bandwidth: 546000
  },
  {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '1800k',
    audioBitrate: '128k',
    bandwidth: 1928000
  },
  {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '4500k',
    audioBitrate: '192k',
    bandwidth: 4692000
  }
];

export class TranscodeWorker {
  private workerId: string;
  private isRunning = false;
  private currentJob: TranscodeJob | null = null;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(workerId = `worker-${Math.random().toString(36).substring(2, 8)}`) {
    this.workerId = workerId;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[WORKER ${this.workerId}] Started. Listening for transcoding jobs...`);
    this.pollLoop();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      const job = jobQueue.acquireJob(this.workerId);
      if (job) {
        await this.processJob(job);
      } else {
        // Backoff poll
        await new Promise(res => setTimeout(res, 1000));
      }
    }
  }

  private async processJob(job: TranscodeJob): Promise<void> {
    this.currentJob = job;
    console.log(`[WORKER ${this.workerId}] Claimed Job #${job.id} for Video #${job.videoId}`);

    const session = storageManager.getSession(job.videoId);
    if (session) {
      session.status = 'PROCESSING';
      session.updatedAt = Date.now();
    }

    // Start 10-second heartbeat to extend lease
    this.heartbeatTimer = setInterval(() => {
      const ok = jobQueue.heartbeat(job.id, this.workerId);
      if (!ok) {
        console.warn(`[WORKER ${this.workerId}] Heartbeat rejected for Job #${job.id}`);
      }
    }, CONFIG.WORKER_HEARTBEAT_INTERVAL_MS);

    try {
      const outputDir = path.join(CONFIG.PROCESSED_STORAGE_DIR, job.videoId);
      fs.mkdirSync(outputDir, { recursive: true });

      // PASS 1: Normalize CFR & Align Timestamps (Fixes A/V Desync)
      const normalizedPath = path.join(outputDir, 'normalized_temp.mp4');
      await this.normalizeMedia(job.sourceFilePath, normalizedPath);

      // PASS 2: Multi-bitrate HLS ladder encoding
      for (const profile of RENDITIONS) {
        console.log(`[WORKER ${this.workerId}] Transcoding rendition: ${profile.name}`);
        await this.encodeRendition(normalizedPath, outputDir, profile);
      }

      // Generate Master HLS Playlist
      this.generateMasterPlaylist(outputDir, RENDITIONS);

      // Clean up temp normalized file
      if (fs.existsSync(normalizedPath)) {
        fs.unlinkSync(normalizedPath);
      }

      // Mark Complete
      if (session) {
        session.status = 'PUBLISHED';
        session.hlsMasterUrl = `/hls/${job.videoId}/master.m3u8`;
        session.updatedAt = Date.now();
      }

      jobQueue.complete(job.id);
      console.log(`[WORKER ${this.workerId}] Successfully transcoded Video #${job.videoId} into HLS ABR.`);
    } catch (err: any) {
      console.error(`[WORKER ${this.workerId}] Transcode failed:`, err);
      if (session) {
        session.status = 'FAILED';
        session.error = err.message || 'Transcode failed';
      }
      jobQueue.fail(job.id, err.message || 'Transcode failed');
    } finally {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.currentJob = null;
    }
  }

  /**
   * Pass 1: Probing & Normalization.
   * Forces Constant Frame Rate (CFR 24 fps), regenerates presentation timestamps (+genpts),
   * and normalizes audio to 48kHz stereo AAC.
   */
  private normalizeMedia(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vsync cfr',          // Force constant frame rate (eliminates variable framerate drift)
          '-r 24',               // Standardize to 24 FPS
          '-fflags +genpts',     // Re-generate presentation timestamps
          '-c:v libx264',
          '-preset veryfast',
          '-c:a aac',
          '-b:a 192k',
          '-ar 48000',           // 48 kHz standard audio clock
          '-ac 2'                // Stereo channels
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }

  /**
   * Pass 2: Generates HLS rendition with 2-second segments and aligned GOP keyframes.
   */
  private encodeRendition(inputPath: string, outputDir: string, profile: RenditionProfile): Promise<void> {
    const renditionDir = path.join(outputDir, profile.name);
    fs.mkdirSync(renditionDir, { recursive: true });

    const playlistPath = path.join(renditionDir, 'index.m3u8');
    const segmentPattern = path.join(renditionDir, 'seg_%03d.ts');

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .size(`${profile.width}x${profile.height}`)
        .videoBitrate(profile.videoBitrate)
        .audioBitrate(profile.audioBitrate)
        .outputOptions([
          `-g ${CONFIG.KEYFRAME_INTERVAL}`,       // 48 frames = 2.0s closed GOP
          `-keyint_min ${CONFIG.KEYFRAME_INTERVAL}`,
          '-sc_threshold 0',                      // Prevent scene cuts from inserting unaligned keyframes
          '-hls_time 2',                          // 2-second segment durations
          '-hls_playlist_type vod',
          `-hls_segment_filename ${segmentPattern}`
        ])
        .output(playlistPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }

  /**
   * Creates the root master.m3u8 manifest binding all bitrate tiers.
   */
  private generateMasterPlaylist(outputDir: string, profiles: RenditionProfile[]): void {
    const masterPath = path.join(outputDir, 'master.m3u8');
    let content = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

    for (const p of profiles) {
      content += `#EXT-X-STREAM-INF:BANDWIDTH=${p.bandwidth},RESOLUTION=${p.width}x${p.height},NAME="${p.name}"\n`;
      content += `${p.name}/index.m3u8\n\n`;
    }

    fs.writeFileSync(masterPath, content, 'utf8');
  }
}

export const transcodeWorker = new TranscodeWorker();
