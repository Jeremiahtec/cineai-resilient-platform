// State Variables
let currentFile = null;
let currentUploadId = null;
let uploadAbortController = null;
let isUploadPaused = false;
let hlsInstance = null;
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

// DOM Elements
const navTabs = document.querySelectorAll('.nav-tab');
const tabContents = document.querySelectorAll('.tab-content');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const btnSimulateDrop = document.getElementById('btnSimulateDrop');
const btnResume = document.getElementById('btnResume');
const progressSection = document.getElementById('progressSection');
const progressBarFill = document.getElementById('progressBarFill');
const uploadStatusText = document.getElementById('uploadStatusText');
const uploadPercentText = document.getElementById('uploadPercentText');
const statTransferred = document.getElementById('statTransferred');
const statTotal = document.getElementById('statTotal');
const chunkGrid = document.getElementById('chunkGrid');
const uploadConsole = document.getElementById('uploadConsole');

// Metrics DOM
const metricHeap = document.getElementById('metricHeap');
const metricQueue = document.getElementById('metricQueue');

// Player DOM
const videoPlayer = document.getElementById('videoPlayer');
const qualitySelect = document.getElementById('qualitySelect');
const btnReloadStreams = document.getElementById('btnReloadStreams');
const videoLibraryList = document.getElementById('videoLibraryList');
const telemetryRendition = document.getElementById('telemetryRendition');
const telemetryBandwidth = document.getElementById('telemetryBandwidth');
const telemetryBuffer = document.getElementById('telemetryBuffer');

// 1. Navigation Tab Switching
navTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    navTabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'cinema') {
      loadVideoLibrary();
    }
  });
});

// 2. Metrics Polling
async function pollMetrics() {
  try {
    const res = await fetch('/api/v1/system/metrics');
    if (!res.ok) return;
    const data = await res.json();
    metricHeap.textContent = `${data.memory.heapUsedMB} MB`;
    metricQueue.textContent = `${data.queue.active} active / ${data.queue.queued} queued`;

    const heapBarFill = document.getElementById('heapBarFill');
    if (heapBarFill) {
      const heapPct = Math.min(100, Math.round((data.memory.heapUsedMB / 250) * 100));
      heapBarFill.style.width = `${Math.max(8, heapPct)}%`;
    }

    // Update lease monitor
    const workerLeaseList = document.getElementById('workerLeaseList');
    if (workerLeaseList) {
      if (data.queue.activeJobDetails.length === 0) {
        workerLeaseList.innerHTML = '<p class="text-muted">No active transcoding jobs at this moment.</p>';
      } else {
        workerLeaseList.innerHTML = data.queue.activeJobDetails.map(j => `
          <div class="video-item">
            <div>
              <strong>Video #${j.videoId}</strong>
              <div class="text-muted font-mono" style="font-size:11px">Worker: ${j.worker} | Attempts: ${j.attempts}</div>
            </div>
            <span class="badge badge-gold">Heartbeat: ${j.lastHeartbeatAgoSec ?? 0}s ago</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    // console.error(err);
  }
}
setInterval(pollMetrics, 3000);
pollMetrics();

// 3. Console Logging Helper
function logConsole(msg, type = 'info') {
  const line = document.createElement('div');
  line.className = `console-line ${type === 'error' ? 'text-danger' : type === 'success' ? 'text-green' : ''}`;
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${msg}`;
  uploadConsole.appendChild(line);
  uploadConsole.scrollTop = uploadConsole.scrollHeight;
}

// 4. File Selection & Drag-and-Drop
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleFileSelected(e.target.files[0]);
  }
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = 'var(--gold)';
});

dropzone.addEventListener('dragleave', () => {
  dropzone.style.borderColor = 'var(--border-color)';
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = 'var(--border-color)';
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleFileSelected(e.dataTransfer.files[0]);
  }
});

function handleFileSelected(file) {
  currentFile = file;
  logConsole(`Selected video cut: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  statTotal.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;

  // Render Chunk Ledger Badges
  chunkGrid.innerHTML = '';
  for (let i = 1; i <= totalChunks; i++) {
    const badge = document.createElement('div');
    badge.className = 'chunk-badge pending font-mono';
    badge.id = `chunk-badge-${i}`;
    badge.textContent = `Part #${i}`;
    chunkGrid.appendChild(badge);
  }

  btnSimulateDrop.disabled = false;
  btnResume.disabled = true;
  startResumableUpload(file);
}

// 5. Ingestion Engine: Direct-to-Storage Resumable Upload
async function startResumableUpload(file) {
  isUploadPaused = false;
  progressSection.style.display = 'block';

  try {
    // Phase 1: Initialize Upload Ticket
    logConsole('Phase 1: Negotiating direct-to-storage upload ticket with CineAI API...');
    const initRes = await fetch('/api/v1/uploads/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'video/mp4'
      })
    });

    if (!initRes.ok) throw new Error('Failed to initialize upload ticket.');
    const initData = await initRes.json();
    currentUploadId = initData.uploadId;
    logConsole(`Upload Ticket granted: Session ID ${currentUploadId}`, 'success');

    // Begin chunk transmission
    await transmitChunks(file, currentUploadId);
  } catch (err) {
    logConsole(`Upload initialization failed: ${err.message}`, 'error');
  }
}

async function transmitChunks(file, uploadId) {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  uploadAbortController = new AbortController();

  // Check offset recovery first (in case resuming)
  const offsetRes = await fetch(`/api/v1/uploads/${uploadId}/offset`);
  const offsetData = await offsetRes.json();
  const uploadedParts = new Set(offsetData.uploadedParts || []);

  logConsole(`Offset ledger query: ${uploadedParts.size} of ${totalChunks} chunks already acknowledged.`);

  // Update UI for already uploaded chunks
  uploadedParts.forEach(partNum => {
    const badge = document.getElementById(`chunk-badge-${partNum}`);
    if (badge) {
      badge.className = 'chunk-badge uploaded font-mono';
      badge.textContent = `✓ #${partNum}`;
    }
  });

  for (let partNumber = 1; partNumber <= totalChunks; partNumber++) {
    if (isUploadPaused) {
      logConsole(`Upload halted by network drop simulation at chunk #${partNumber}.`, 'error');
      btnResume.disabled = false;
      btnSimulateDrop.disabled = true;
      return;
    }

    if (uploadedParts.has(partNumber)) {
      continue; // Skip already verified chunk
    }

    const start = (partNumber - 1) * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);

    uploadStatusText.textContent = `Streaming Chunk #${partNumber} of ${totalChunks} directly to storage...`;

    // Simulated network latency
    const isSlow = document.querySelector('input[name="networkSpeed"]:checked')?.value === 'slow';
    if (isSlow) {
      await new Promise(r => setTimeout(r, 600));
    }

    try {
      const partRes = await fetch(`/api/v1/uploads/${uploadId}/part/${partNumber}`, {
        method: 'PUT',
        body: chunkBlob,
        signal: uploadAbortController.signal
      });

      if (!partRes.ok) throw new Error(`HTTP ${partRes.status} on chunk #${partNumber}`);

      uploadedParts.add(partNumber);
      const badge = document.getElementById(`chunk-badge-${partNumber}`);
      if (badge) {
        badge.className = 'chunk-badge uploaded font-mono';
        badge.textContent = `✓ #${partNumber}`;
      }

      // Update progress bar
      const percent = Math.round((uploadedParts.size / totalChunks) * 100);
      progressBarFill.style.width = `${percent}%`;
      uploadPercentText.textContent = `${percent}%`;
      statTransferred.textContent = `${((uploadedParts.size * CHUNK_SIZE) / 1024 / 1024).toFixed(2)} MB`;

      // Check if simulated drop trigger was fired
      if (isUploadPaused) return;

    } catch (err) {
      if (isUploadPaused) return;
      logConsole(`Chunk #${partNumber} failed in transit: ${err.message}`, 'error');
      btnResume.disabled = false;
      return;
    }
  }

  // All parts uploaded!
  logConsole('All chunks verified. Finalizing master assembly and triggering ABR transcoding...', 'success');
  uploadStatusText.textContent = 'Assembling chunks into master cut...';

  const compRes = await fetch(`/api/v1/uploads/${uploadId}/complete`, { method: 'POST' });
  const compData = await compRes.json();

  if (compRes.ok) {
    logConsole('Master assembled. Transcode Job placed in priority queue.', 'success');
    btnSimulateDrop.disabled = true;
    btnResume.disabled = true;
    pollTranscodeStatus(uploadId);
  } else {
    logConsole(`Assembly error: ${compData.error}`, 'error');
  }
}

// 6. Simulate Wi-Fi Drop (Freeze at ~85%)
btnSimulateDrop.addEventListener('click', () => {
  isUploadPaused = true;
  if (uploadAbortController) {
    uploadAbortController.abort();
  }
  logConsole('⚠️ [NETWORK DROP SIMULATION] Wi-Fi connection collapsed at current byte offset!', 'error');
  uploadStatusText.textContent = 'Upload FROZEN due to simulated network disconnect.';
  btnSimulateDrop.disabled = true;
  btnResume.disabled = false;
});

// 7. Resume from Offset
btnResume.addEventListener('click', async () => {
  if (!currentFile || !currentUploadId) return;
  isUploadPaused = false;
  btnResume.disabled = true;
  btnSimulateDrop.disabled = false;

  logConsole('🔄 Resuming upload... Querying offset discovery endpoint...');
  await transmitChunks(currentFile, currentUploadId);
});

// 8. Poll Transcode Status
function pollTranscodeStatus(uploadId) {
  let loggedProcessing = false;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/api/v1/uploads/${uploadId}/status`);
      const data = await res.json();
      uploadStatusText.textContent = `Status: ${data.status}`;

      if (data.status === 'PROCESSING' && !loggedProcessing) {
        loggedProcessing = true;
        logConsole('⚙️ Worker claimed job: Transcoding multi-bitrate HLS ladder (360p, 720p, 1080p)...');
      }

      if (data.status === 'PUBLISHED') {
        clearInterval(timer);
        logConsole(`🎉 Film successfully normalized and published! Ready for HLS streaming.`, 'success');
        uploadStatusText.textContent = 'PUBLISHED & READY TO STREAM';
        loadVideoLibrary();
      } else if (data.status === 'FAILED') {
        clearInterval(timer);
        logConsole(`Transcode error: ${data.error}`, 'error');
      }
    } catch (e) {
      // ignore
    }
  }, 1200);
}

// 9. Audience Cinema Player & ABR Streaming
async function loadVideoLibrary() {
  try {
    const res = await fetch('/api/v1/videos');
    const videos = await res.json();

    if (videos.length === 0) {
      videoLibraryList.innerHTML = '<p class="placeholder-text">No videos published yet. Upload a video cut in Tab 1!</p>';
      return;
    }

    videoLibraryList.innerHTML = videos.map(v => `
      <div class="video-item" onclick="playVideo('${v.id}', '${v.hlsMasterUrl || ''}', '${v.status}', '${v.filename}')">
        <div>
          <div class="video-meta-title">🎬 ${v.filename}</div>
          <div class="video-meta-sub font-mono">Session ID: ${v.id} · Size: ${(v.sizeBytes / 1024 / 1024).toFixed(1)} MB</div>
        </div>
        <span class="chip ${v.status === 'PUBLISHED' ? 'chip-gold' : 'chip-cyan'}">${v.status}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error(err);
  }
}

window.playVideo = function(videoId, hlsMasterUrl, status, filename = 'Active Film') {
  if (status !== 'PUBLISHED' || !hlsMasterUrl) {
    alert(`Video #${videoId} is currently ${status}. Please wait for ABR transcoding to finish.`);
    return;
  }

  logConsole(`Loading HLS master manifest: ${hlsMasterUrl}`);
  const playerResolutionBadge = document.getElementById('playerResolutionBadge');
  if (playerResolutionBadge) playerResolutionBadge.textContent = 'Buffering ABR...';

  if (Hls.isSupported()) {
    if (hlsInstance) {
      hlsInstance.destroy();
    }

    hlsInstance = new Hls({
      capLevelToPlayerSize: true,
      startLevel: -1 // Auto ABR
    });

    hlsInstance.loadSource(hlsMasterUrl);
    hlsInstance.attachMedia(videoPlayer);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      videoPlayer.play().catch(() => {});
      telemetryRendition.textContent = `Auto (${data.levels.length} ABR levels detected)`;
      if (playerResolutionBadge) playerResolutionBadge.textContent = `Auto (${data.levels.length} tiers)`;
    });

    hlsInstance.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const level = hlsInstance.levels[data.level];
      telemetryRendition.textContent = `${level.height}p (${Math.round(level.bitrate / 1000)} kbps)`;
      if (playerResolutionBadge) playerResolutionBadge.textContent = `${level.height}p · ${Math.round(level.bitrate / 1000)} kbps`;
    });

    // Quality selector listener
    qualitySelect.onchange = () => {
      hlsInstance.currentLevel = parseInt(qualitySelect.value, 10);
    };

  } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    // Native Safari HLS
    videoPlayer.src = hlsMasterUrl;
    videoPlayer.play();
  }
};

// Monitor Playback Buffer Health
setInterval(() => {
  if (videoPlayer && !videoPlayer.paused) {
    if (videoPlayer.buffered.length > 0) {
      const bufferEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
      const bufferLen = Math.max(0, bufferEnd - videoPlayer.currentTime);
      telemetryBuffer.textContent = `${bufferLen.toFixed(1)} s`;
    }
    if (hlsInstance && hlsInstance.bandwidthEstimate) {
      telemetryBandwidth.textContent = `${Math.round(hlsInstance.bandwidthEstimate / 1000)} kbps`;
    }
  }
}, 1000);

btnReloadStreams.addEventListener('click', loadVideoLibrary);
