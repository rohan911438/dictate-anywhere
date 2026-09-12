// Dictate Anywhere — offscreen document.
//
// Captures the microphone with the Web Audio API and hand-encodes a WAV file
// (44-byte header + 16-bit little-endian PCM). MediaRecorder is deliberately
// NOT used: it produces webm/opus, and the Dictation API needs WAV/PCM.
//
// Graph:  MediaStreamSource -> ScriptProcessorNode -> zero-gain Gain -> destination
// The zero-gain node keeps the graph "pulling" audioprocess callbacks without
// routing any microphone audio to the speakers (no feedback loop).

import {
  CHUNK_SOFT_CAP_MS,
  SILENCE_HOLD_MS,
  SILENCE_RMS_THRESHOLD,
  MIN_CHUNK_MS,
} from './shared/constants.js';

const PROCESSOR_BUFFER = 4096;

let DEBUG = false;
const log = (...a) => {
  if (DEBUG) console.log('[DictateAnywhere:offscreen]', ...a);
};

// --- capture graph ---
let audioCtx = null;
let micStream = null;
let sourceNode = null;
let processorNode = null;
let zeroGain = null;

// --- session ---
let capturing = false;
let autoChunk = false;
let seq = 0;
let sampleRate = 48_000;

// --- current (un-sent) clip ---
let frames = []; // Float32Array[]
let bufferedSamples = 0;
let sawVoice = false;
let silentRunSamples = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    DEBUG = !!msg.debug;
    autoChunk = !!msg.autoChunk;
    start();
  } else if (msg.type === 'stop') {
    stop();
  }
});

function resetClip() {
  frames = [];
  bufferedSamples = 0;
  sawVoice = false;
  silentRunSamples = 0;
}

async function start() {
  if (capturing) return;
  seq = 0;
  resetClip();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    log('getUserMedia failed:', e && e.name);
    reply({ type: 'capture-error', message: micErrorMessage(e) });
    return;
  }

  audioCtx = new AudioContext();
  // A programmatically-created context can start suspended; a suspended context
  // never fires onaudioprocess, which would hang the whole flow silently.
  try {
    await audioCtx.resume();
  } catch (_) {
    /* handled by the state check below */
  }
  if (audioCtx.state !== 'running') {
    log(`AudioContext stuck in state "${audioCtx.state}"`);
    stopGraph();
    reply({ type: 'capture-error', message: 'The audio engine could not start — try again.' });
    return;
  }
  sampleRate = audioCtx.sampleRate;

  sourceNode = audioCtx.createMediaStreamSource(micStream);
  processorNode = audioCtx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
  zeroGain = audioCtx.createGain();
  zeroGain.gain.value = 0; // no monitoring -> no audible feedback

  processorNode.onaudioprocess = onAudioProcess;
  sourceNode.connect(processorNode);
  processorNode.connect(zeroGain);
  zeroGain.connect(audioCtx.destination);

  capturing = true;
  log(`capture started @ ${sampleRate} Hz, state=${audioCtx.state}, autoChunk=${autoChunk}`);
}

function onAudioProcess(event) {
  if (!capturing) return;

  const input = event.inputBuffer.getChannelData(0);
  const frame = new Float32Array(input.length);
  frame.set(input);
  frames.push(frame);
  bufferedSamples += frame.length;

  // per-frame RMS for voice / silence tracking
  let sumSq = 0;
  for (let i = 0; i < frame.length; i += 1) sumSq += frame[i] * frame[i];
  const rms = Math.sqrt(sumSq / frame.length);
  if (rms >= SILENCE_RMS_THRESHOLD) {
    sawVoice = true;
    silentRunSamples = 0;
  } else {
    silentRunSamples += frame.length;
  }

  const bufferedMs = (bufferedSamples / sampleRate) * 1000;

  // Never let one clip exceed the API's hard cap.
  if (bufferedMs >= CHUNK_SOFT_CAP_MS) {
    log('soft cap reached — finalising');
    finalize(autoChunk ? 'chunk' : 'final');
    if (!autoChunk) stopGraph();
    return;
  }

  // Opt-in silence chunking: end a chunk after a sustained pause, keep listening.
  if (autoChunk && sawVoice) {
    const silentMs = (silentRunSamples / sampleRate) * 1000;
    if (silentMs >= SILENCE_HOLD_MS && bufferedMs >= MIN_CHUNK_MS) {
      log(`silence ${Math.round(silentMs)} ms — auto chunk`);
      finalize('chunk');
    }
  }
}

// kind: 'chunk' (keep recording) | 'final' (session ending)
// Must always reply — the background service worker waits on a 'chunk' /
// 'final' / 'stopped' message with no other way to notice this failed, so an
// uncaught throw here would leave the page stuck on "Transcribing" forever.
function finalize(kind) {
  try {
    const samples = flatten(frames, bufferedSamples);
    const hadVoice = sawVoice;
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    resetClip();

    if (!hadVoice || durationMs < MIN_CHUNK_MS) {
      log(`skipping ${kind}: hadVoice=${hadVoice} durationMs=${durationMs}`);
      if (kind === 'final') reply({ type: 'stopped' });
      return;
    }

    const wav = encodeWav(samples, sampleRate);
    const audioBase64 = arrayBufferToBase64(wav);
    const thisSeq = seq;
    seq += 1;
    log(
      `${kind} seq=${thisSeq} samples=${samples.length} durationMs=${durationMs} bytes=${wav.byteLength}`,
    );
    reply({ type: kind, seq: thisSeq, audioBase64, durationMs, bytes: wav.byteLength });
  } catch (e) {
    log('finalize failed', e);
    resetClip();
    reply({ type: 'capture-error', message: 'Could not process the recording — try again.' });
  }
}

function stop() {
  if (!capturing) {
    reply({ type: 'stopped' });
    return;
  }
  finalize('final');
  stopGraph();
}

function stopGraph() {
  capturing = false;
  try {
    if (processorNode) processorNode.onaudioprocess = null;
  } catch (_) { /* noop */ }
  try { if (sourceNode) sourceNode.disconnect(); } catch (_) { /* noop */ }
  try { if (processorNode) processorNode.disconnect(); } catch (_) { /* noop */ }
  try { if (zeroGain) zeroGain.disconnect(); } catch (_) { /* noop */ }
  try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
  try { if (audioCtx) audioCtx.close(); } catch (_) { /* noop */ }
  audioCtx = micStream = sourceNode = processorNode = zeroGain = null;
  log('capture graph torn down');
}

// --------------------------------------------------------------------------
// encoding helpers
// --------------------------------------------------------------------------
function flatten(chunks, total) {
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// mono, 16-bit signed little-endian PCM in a canonical 44-byte WAV header.
function encodeWav(float32, rate) {
  const n = float32.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true); // ChunkSize
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // NumChannels = mono
  view.setUint32(24, rate, true); // SampleRate
  view.setUint32(28, rate * 2, true); // ByteRate = rate * channels(1) * bytesPerSample(2)
  view.setUint16(32, 2, true); // BlockAlign = channels(1) * bytesPerSample(2)
  view.setUint16(34, 16, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, n * 2, true); // Subchunk2Size

  let offset = 44;
  for (let i = 0; i < n; i += 1) {
    let s = float32[i];
    if (s < -1) s = -1;
    else if (s > 1) s = 1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function reply(message) {
  chrome.runtime.sendMessage({ from: 'offscreen', ...message }).catch(() => {});
}

function micErrorMessage(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission denied. Open the extension onboarding page (or the site’s mic setting) to allow it.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone found.';
    case 'NotReadableError':
      return 'The microphone is in use by another application.';
    default:
      return 'Could not access the microphone.';
  }
}
