#!/usr/bin/env node
// Standalone check for the AssemblyAI Dictation API — no extension required.
//
//   node test-api.js path/to/clip.wav [apiKey]
//
// Key resolution order:  CLI arg  >  $ASSEMBLYAI_API_KEY  >  dev/local-key.txt
//
// Optional env knobs (mirror the config background.js builds):
//   DICTATE_LANGS=en,es           -> language_codes
//   DICTATE_LLM="Fix grammar."    -> llm_instruction
//   DICTATE_KEYTERMS=Foo,Bar      -> keyterms_prompt

'use strict';
const fs = require('fs');
const path = require('path');

const API_ENDPOINT = 'https://dictation.assemblyai.com/transcribe';
const TIMEOUT_MS = 90_000;

function resolveKey(cliKey) {
  if (cliKey) return cliKey.trim();
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY.trim();
  const localFile = path.join(__dirname, 'dev', 'local-key.txt');
  if (fs.existsSync(localFile)) return fs.readFileSync(localFile, 'utf8').trim();
  return null;
}

function buildConfig() {
  const config = {
    language_codes: (process.env.DICTATE_LANGS || 'en')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (process.env.DICTATE_LLM) config.llm_instruction = process.env.DICTATE_LLM.slice(0, 2048);
  if (process.env.DICTATE_KEYTERMS) {
    config.keyterms_prompt = process.env.DICTATE_KEYTERMS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return config;
}

async function main() {
  const [wavPath, cliKey] = process.argv.slice(2);

  if (!wavPath) {
    console.error('Usage: node test-api.js path/to/clip.wav [apiKey]');
    console.error('Key:   CLI arg > $ASSEMBLYAI_API_KEY > dev/local-key.txt');
    process.exit(2);
  }
  if (!fs.existsSync(wavPath)) {
    console.error('File not found:', wavPath);
    process.exit(2);
  }

  const apiKey = resolveKey(cliKey);
  if (!apiKey) {
    console.error('No API key. Pass it as an argument, set $ASSEMBLYAI_API_KEY, or create dev/local-key.txt');
    process.exit(2);
  }

  const bytes = fs.readFileSync(wavPath);
  const config = buildConfig();

  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('config', JSON.stringify(config));

  console.log('POST  ', API_ENDPOINT);
  console.log('audio ', wavPath, `(${bytes.length.toLocaleString()} bytes)`);
  console.log('config', JSON.stringify(config));
  console.log('key   ', `provided (${apiKey.length} chars)`); // never print the key itself

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  let res;
  try {
    res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: apiKey }, // raw key — no "Bearer"
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    console.error('\nRequest failed:', e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS} ms` : e.message);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  const elapsed = Date.now() - started;
  console.log(`\nHTTP ${res.status} ${res.statusText}  —  ${elapsed} ms`);

  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (_) {
    console.log(bodyText);
    process.exit(res.ok ? 0 : 1);
  }

  if (!res.ok) {
    const meaning = {
      400: 'bad request',
      401: 'no credential',
      404: 'invalid API key (treat as auth failure)',
      429: 'rate limited',
      502: 'upstream timeout',
      503: 'capacity exceeded',
      504: 'upstream timeout',
    }[res.status] || 'error';
    console.error(`\n${meaning}\n`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('\n--- text (verbatim, never altered) ---');
  console.log(data.text ?? '(none)');
  console.log('\n--- llm_response (rewritten) ---');
  console.log(data.llm_response ?? '(null)');
  if (data.llm_error) console.log('\nllm_error:', data.llm_error);

  console.log('\nmeta:', JSON.stringify({
    confidence: data.confidence,
    audio_duration_ms: data.audio_duration_ms,
    request_time_ms: data.request_time_ms,
    sync_time_ms: data.sync_time_ms,
    session_id: data.session_id,
    words: Array.isArray(data.words) ? data.words.length : undefined,
  }, null, 2));
}

main();
