import { EventEmitter } from 'events';
import { CONFIG } from '../config';

export interface TranscodeJob {
  id: string;
  videoId: string;
  sourceFilePath: string;
  outputDir: string;
  attempts: number;
  maxAttempts: number;
  priority: number;
  enqueuedAt: number;
  lockedByWorker?: string;
  lockedUntil?: number;
  lastHeartbeat?: number;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTER';
  error?: string;
}

export class PriorityJobQueue extends EventEmitter {
  private queue: TranscodeJob[] = [];
  private deadLetterQueue: TranscodeJob[] = [];
  private activeJobs = new Map<string, TranscodeJob>();
  private reaperInterval?: NodeJS.Timeout;

  constructor() {
    super();
    this.startReaper();
  }

  /**
   * Enqueues a new transcoding job.
   */
  public enqueue(jobData: Omit<TranscodeJob, 'attempts' | 'maxAttempts' | 'enqueuedAt' | 'status'>): TranscodeJob {
    const job: TranscodeJob = {
      ...jobData,
      attempts: 0,
      maxAttempts: CONFIG.MAX_RETRY_ATTEMPTS,
      enqueuedAt: Date.now(),
      status: 'QUEUED'
    };

    // Insert sorted by priority (higher number = higher priority)
    const insertIdx = this.queue.findIndex(item => item.priority < job.priority);
    if (insertIdx === -1) {
      this.queue.push(job);
    } else {
      this.queue.splice(insertIdx, 0, job);
    }

    this.emit('job:enqueued', job);
    return job;
  }

  /**
   * Leases the next job to an available worker.
   */
  public acquireJob(workerId: string): TranscodeJob | null {
    if (this.queue.length === 0) {
      return null;
    }

    const job = this.queue.shift()!;
    job.attempts += 1;
    job.status = 'PROCESSING';
    job.lockedByWorker = workerId;
    job.lockedUntil = Date.now() + CONFIG.WORKER_LEASE_TIMEOUT_MS;
    job.lastHeartbeat = Date.now();

    this.activeJobs.set(job.id, job);
    this.emit('job:acquired', { jobId: job.id, workerId });
    return job;
  }

  /**
   * Worker calls this periodically to extend its lease lock.
   */
  public heartbeat(jobId: string, workerId: string): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job || job.lockedByWorker !== workerId) {
      return false;
    }

    job.lastHeartbeat = Date.now();
    job.lockedUntil = Date.now() + CONFIG.WORKER_LEASE_TIMEOUT_MS;
    return true;
  }

  /**
   * Marks a job as completed.
   */
  public complete(jobId: string): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.status = 'COMPLETED';
      this.activeJobs.delete(jobId);
      this.emit('job:completed', job);
    }
  }

  /**
   * Marks a job as failed, auto-retrying or routing to Dead Letter Queue (DLQ).
   */
  public fail(jobId: string, error: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    this.activeJobs.delete(jobId);
    job.error = error;

    if (job.attempts < job.maxAttempts) {
      job.status = 'QUEUED';
      job.lockedByWorker = undefined;
      job.lockedUntil = undefined;
      this.queue.push(job); // re-queue
      this.emit('job:retry', job);
    } else {
      job.status = 'DEAD_LETTER';
      this.deadLetterQueue.push(job);
      this.emit('job:deadletter', job);
    }
  }

  /**
   * Background reaper: identifies abandoned or hung worker leases
   * and rescues them to prevent DB deadlocks and perpetual 'processing' states.
   */
  private startReaper(): void {
    this.reaperInterval = setInterval(() => {
      const now = Date.now();
      for (const [jobId, job] of this.activeJobs.entries()) {
        if (job.lockedUntil && now > job.lockedUntil) {
          console.warn(`[REAPER] Worker lease expired for Job #${jobId}. Reclaiming job.`);
          this.fail(jobId, 'Worker lease expired (heartbeat timeout).');
        }
      }
    }, 5000);
  }

  public getStats() {
    return {
      queued: this.queue.length,
      active: this.activeJobs.size,
      deadLetter: this.deadLetterQueue.length,
      activeJobDetails: Array.from(this.activeJobs.values()).map(j => ({
        id: j.id,
        videoId: j.videoId,
        worker: j.lockedByWorker,
        attempts: j.attempts,
        lastHeartbeatAgoSec: j.lastHeartbeat ? Math.round((Date.now() - j.lastHeartbeat) / 1000) : null
      }))
    };
  }

  public stop(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
    }
  }
}

export const jobQueue = new PriorityJobQueue();
