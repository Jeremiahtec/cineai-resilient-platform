import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { CONFIG } from '../config';

export interface UploadSession {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  expectedChunks: number;
  parts: Map<number, { sizeBytes: number; createdAt: number }>;
  status: 'INITIALIZING' | 'UPLOADING' | 'UPLOADED' | 'QUEUED' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  createdAt: number;
  updatedAt: number;
  error?: string;
  hlsMasterUrl?: string;
}

export class LocalStorageManager {
  private sessions = new Map<string, UploadSession>();
  private metadataFile: string;

  constructor() {
    this.ensureDirs();
    this.metadataFile = path.join(CONFIG.MASTER_STORAGE_DIR, 'sessions_metadata.json');
    this.loadFromDisk();
  }

  private ensureDirs() {
    if (!fs.existsSync(CONFIG.MASTER_STORAGE_DIR)) {
      fs.mkdirSync(CONFIG.MASTER_STORAGE_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG.PROCESSED_STORAGE_DIR)) {
      fs.mkdirSync(CONFIG.PROCESSED_STORAGE_DIR, { recursive: true });
    }
  }

  public saveToDisk(): void {
    try {
      const serializable = Array.from(this.sessions.values()).map(s => ({
        ...s,
        parts: Array.from(s.parts.entries())
      }));
      fs.writeFileSync(this.metadataFile, JSON.stringify(serializable, null, 2), 'utf8');
    } catch (e) {
      // Ignore write errors during shutdown
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.metadataFile)) {
        const raw = fs.readFileSync(this.metadataFile, 'utf8');
        const parsed = JSON.parse(raw);
        for (const item of parsed) {
          const session: UploadSession = {
            ...item,
            parts: new Map(item.parts || [])
          };
          this.sessions.set(session.id, session);
        }
      }
    } catch (e) {
      // Start clean if corrupted
    }
  }

  public getSession(uploadId: string): UploadSession | undefined {
    return this.sessions.get(uploadId);
  }

  public getAllSessions(): UploadSession[] {
    return Array.from(this.sessions.values());
  }

  public initializeUpload(id: string, filename: string, sizeBytes: number, mimeType: string): UploadSession {
    const expectedChunks = Math.max(1, Math.ceil(sizeBytes / CONFIG.CHUNK_SIZE_BYTES));
    const sessionDir = path.join(CONFIG.MASTER_STORAGE_DIR, 'parts', id);
    fs.mkdirSync(sessionDir, { recursive: true });

    const session: UploadSession = {
      id,
      filename,
      sizeBytes,
      mimeType,
      expectedChunks,
      parts: new Map(),
      status: 'INITIALIZING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.sessions.set(id, session);
    this.saveToDisk();
    return session;
  }

  /**
   * Streams a chunk directly from the HTTP request stream into storage.
   * Crucial: Zero bytes buffered in Node.js process heap memory.
   */
  public async writePart(uploadId: string, partNumber: number, inputStream: Readable): Promise<{ partNumber: number; sizeBytes: number }> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session '${uploadId}' not found.`);
    }

    const partFilePath = path.join(CONFIG.MASTER_STORAGE_DIR, 'parts', uploadId, `part_${partNumber.toString().padStart(5, '0')}.tmp`);
    const writeStream = fs.createWriteStream(partFilePath, { flags: 'w' });

    // Stream directly to disk using pipeline
    await pipeline(inputStream, writeStream);

    const stats = fs.statSync(partFilePath);
    session.parts.set(partNumber, {
      sizeBytes: stats.size,
      createdAt: Date.now()
    });
    session.status = 'UPLOADING';
    session.updatedAt = Date.now();
    this.saveToDisk();

    return { partNumber, sizeBytes: stats.size };
  }

  /**
   * Offset discovery: returns all acknowledged parts and next missing part index.
   * This allows the client to resume interrupted uploads from the exact byte offset.
   */
  public getUploadProgress(uploadId: string): {
    uploadedParts: number[];
    bytesReceived: number;
    totalBytes: number;
    percent: number;
    nextPartNumber: number;
    status: string;
  } {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session '${uploadId}' not found.`);
    }

    const uploadedParts = Array.from(session.parts.keys()).sort((a, b) => a - b);
    let bytesReceived = 0;
    for (const part of session.parts.values()) {
      bytesReceived += part.sizeBytes;
    }

    // Determine the next missing part
    let nextPart = 1;
    while (session.parts.has(nextPart)) {
      nextPart++;
    }

    const percent = session.sizeBytes > 0 
      ? Math.min(100, Math.round((bytesReceived / session.sizeBytes) * 100))
      : 0;

    return {
      uploadedParts,
      bytesReceived,
      totalBytes: session.sizeBytes,
      percent,
      nextPartNumber: nextPart,
      status: session.status
    };
  }

  /**
   * Finalizes the upload by concatenating parts into a master file.
   * Cleans up temporary chunks.
   */
  public async completeUpload(uploadId: string): Promise<string> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session '${uploadId}' not found.`);
    }

    const finalMasterPath = path.join(CONFIG.MASTER_STORAGE_DIR, `${uploadId}_${session.filename}`);
    const finalWriteStream = fs.createWriteStream(finalMasterPath, { flags: 'w' });

    const totalParts = session.parts.size;
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const partPath = path.join(CONFIG.MASTER_STORAGE_DIR, 'parts', uploadId, `part_${partNumber.toString().padStart(5, '0')}.tmp`);
      if (!fs.existsSync(partPath)) {
        throw new Error(`Missing chunk #${partNumber} during assembly.`);
      }

      const readStream = fs.createReadStream(partPath);
      await pipeline(readStream, finalWriteStream, { end: false });
    }

    finalWriteStream.end();
    await new Promise<void>((resolve) => finalWriteStream.on('finish', () => resolve()));

    // Clean up temporary parts directory
    const partsDir = path.join(CONFIG.MASTER_STORAGE_DIR, 'parts', uploadId);
    fs.rmSync(partsDir, { recursive: true, force: true });

    session.status = 'UPLOADED';
    session.updatedAt = Date.now();
    this.saveToDisk();

    return finalMasterPath;
  }
}

export const storageManager = new LocalStorageManager();
