// 英文 PDF 朗讀機：PDF 抽文字 → 分句 → Kokoro 合成 → 播放 / 下載
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

// ---------- 全域狀態 ----------
const state = {
  sentences: [],     // { text, tts, page, el, skip }
  current: 0,        // 目前播放到第幾句
  playing: false,
  voice: 'af_heart',
  speed: 1,
  modelReady: false,
  fileName: 'audio',
};
const cache = new Map();    // key -> { samples, sr }
const inflight = new Map(); // key -> Promise

const keyOf = (idx, speed) => `${state.voice}|${speed}|${idx}`;

// ---------- 語音 Worker ----------
const worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
let reqId = 0;
const pending = new Map();

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    const pct = Math.round((m.loaded / m.total) * 100);
    $('modelBar').style.width = pct + '%';
    $('modelStatus').textContent = `正在下載語音引擎… ${pct}%（${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB）`;
  } else if (m.type === 'ready') {
    state.modelReady = true;
    $('modelBar').style.width = '100%';
    $('modelStatus').textContent = '✅ 語音引擎準備好了';
    setTimeout(() => $('modelCard').classList.add('hidden'), 1500);
    prefetchLoop();
  } else if (m.type === 'result') {
    pending.get(m.id)?.resolve({ samples: m.audio, sr: m.sr });
    pending.delete(m.id);
  } else if (m.type === 'error') {
    if (m.id != null) {
      pending.get(m.id)?.reject(new Error(m.message));
      pending.delete(m.id);
    } else {
      $('modelStatus').textContent = '❌ 語音引擎載入失敗：' + m.message + '（請重新整理頁面再試）';
    }
  }
};
worker.postMessage({ type: 'load' });

function synth(text, voice, speed) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'generate', id, text, voice, speed });
  });
}

// 取得某一句的音訊（有快取就直接用）
function getAudio(idx, speed = 1) {
  const key = keyOf(idx, speed);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const s = state.sentences[idx];
  const p = (s.skip ? Promise.resolve({ samples: new Float32Array(0), sr: 24000 })
                    : synth(s.tts, state.voice, speed))
    .catch((err) => {
      console.warn('合成失敗，略過這一句：', s.tts, err);
      return { samples: new Float32Array(0), sr: 24000 };
    })
    .then((a) => {
      cache.set(key, a);
      inflight.delete(key);
      updateGenProgress();
      return a;
    });
  inflight.set(key, p);
  return p;
}

// 背景預先合成：從目前位置往後，一次只排一句，讓「正要播的那句」永遠優先
let prefetchRunning = false;
async function prefetchLoop() {
  if (prefetchRunning) return;
  prefetchRunning = true;
  try {
    while (state.modelReady && state.sentences.length) {
      const idx = nextMissing();
      if (idx < 0) break;
      await getAudio(idx, 1);
    }
  } finally {
    prefetchRunning = false;
  }
}
function nextMissing() {
  const n = state.sentences.length;
  for (let k = 0; k < n; k++) {
    const i = (state.current + k) % n;
    if (!cache.has(keyOf(i, 1))) return i;
  }
  return -1;
}
function updateGenProgress() {
  const n = state.sentences.length;
  if (!n) return;
  let done = 0;
  for (let i = 0; i < n; i++) if (cache.has(keyOf(i, 1))) done++;
  $('genBar').style.width = Math.round((done / n) * 100) + '%';
  $('genStatus').textContent = done === n ? `全部 ${n} 句都準備好了` : `已準備 ${done} / ${n} 句`;
}

// ---------- PDF 解析 ----------
async function extractPages(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    $('pdfStatus').textContent = `讀取中… 第 ${p} / ${pdf.numPages} 頁`;
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = [];
    let line = '', lastY = null, prevEnd = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const x = it.transform[4], y = it.transform[5];
      const fs = it.height || Math.hypot(it.transform[2], it.transform[3]) || 10;
      // y 座標明顯改變 → 換行
      if (lastY !== null && Math.abs(y - lastY) > fs * 0.5 && line.trim()) {
        lines.push(line); line = ''; prevEnd = null;
      }
      // 同一行內，兩段文字間有空隙 → 補空白
      if (line && prevEnd !== null && x - prevEnd > fs * 0.15 &&
          !/\s$/.test(line) && !/^\s/.test(it.str)) line += ' ';
      line += it.str;
      if (it.str.trim()) { lastY = y; prevEnd = x + it.width; }
      if (it.hasEOL) { if (line.trim()) lines.push(line); line = ''; lastY = null; prevEnd = null; }
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean));
  }
  return pages;
}

// 把一行一行的文字組回段落（標題、條列、短行各自成段）
function linesToParagraphs(lines) {
  const lens = lines.map((l) => l.length).sort((a, b) => a - b);
  const typical = lens[Math.floor(lens.length * 0.8)] || 60;
  const isItem = (l) => /^([•●▪■◦\-–*]|\(?\d{1,2}[.)]\s|\(?[a-hA-H][.)]\s)/.test(l);
  const paras = [];
  let cur = '';
  lines.forEach((l, i) => {
    if (!cur) cur = l;
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(l)) cur = cur.slice(0, -1) + l; // 斷字還原
    else cur += ' ' + l;
    const next = lines[i + 1];
    const short = l.length < typical * 0.6;
    if (!next || short || isItem(next)) { paras.push(cur); cur = ''; }
  });
  if (cur) paras.push(cur);
  return paras;
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'sentence' }) : null;

function splitSentences(para) {
  let parts = segmenter
    ? Array.from(segmenter.segment(para), (s) => s.segment)
    : para.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) || [para];
  parts = parts.map((s) => s.trim()).filter(Boolean);
  // 太長的句子再依逗號 / 空白切開，避免模型吃不下
  const out = [];
  for (const s of parts) out.push(...chunkLong(s, 220));
  return out;
}
function chunkLong(s, max) {
  if (s.length <= max) return [s];
  const res = [];
  let rest = s;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max), rest.lastIndexOf(': ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    res.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) res.push(rest);
  return res;
}

// 給語音用的文字：去掉中文、底線空格等唸不出來的東西
function toTtsText(s) {
  return s
    .replace(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]+/g, ' ')
    .replace(/_{2,}/g, ' blank ')
    .replace(/[•●▪■◦]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 畫面 ----------
function renderText(pages) {
  const view = $('textView');
  view.innerHTML = '';
  state.sentences = [];
  pages.forEach((lines, pi) => {
    const title = document.createElement('div');
    title.className = 'page-title';
    title.textContent = `第 ${pi + 1} 頁`;
    view.appendChild(title);
    for (const para of linesToParagraphs(lines)) {
      const p = document.createElement('p');
      p.className = 'para';
      for (const text of splitSentences(para)) {
        const tts = toTtsText(text);
        const skip = !/[A-Za-z]/.test(tts);
        const idx = state.sentences.length;
        const span = document.createElement('span');
        span.className = 'sent' + (skip ? ' skip' : '');
        span.textContent = text + ' ';
        if (!skip) span.onclick = () => playFrom(idx);
        p.appendChild(span);
        state.sentences.push({ text, tts, page: pi + 1, el: span, skip });
      }
      view.appendChild(p);
    }
  });
}

function highlight(idx) {
  document.querySelector('.sent.active')?.classList.remove('active');
  const el = state.sentences[idx]?.el;
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---------- 播放 ----------
const audioEl = new Audio();
audioEl.preservesPitch = true; // 調速度時聲音不會變尖/變低
let playToken = 0;
let currentUrl = null;

async function playFrom(idx) {
  const n = state.sentences.length;
  // 跳過不需要唸的句子
  while (idx < n && state.sentences[idx].skip) idx++;
  if (idx >= n) { stop('🎉 唸完了！'); return; }

  const token = ++playToken;
  state.current = idx;
  state.playing = true;
  setPlayIcon();
  highlight(idx);
  if (!cache.has(keyOf(idx, 1))) {
    $('nowStatus').textContent = state.modelReady ? '⏳ 準備語音中…' : '⏳ 等待語音引擎下載完成…';
  }
  prefetchLoop();
  const a = await getAudio(idx, 1);
  if (token !== playToken || !state.playing) return;

  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(encodeWav([a.samples], a.sr));
  audioEl.src = currentUrl;
  audioEl.defaultPlaybackRate = state.speed;
  audioEl.playbackRate = state.speed;
  $('nowStatus').textContent = `第 ${state.sentences[idx].page} 頁・第 ${idx + 1} / ${n} 句`;
  try { await audioEl.play(); } catch (e) { console.warn(e); }
  updateMediaSession();
}

audioEl.onended = () => {
  if (state.playing) playFrom(state.current + 1);
};

function stop(msg) {
  state.playing = false;
  playToken++;
  audioEl.pause();
  setPlayIcon();
  if (msg) $('nowStatus').textContent = msg;
}

function togglePlay() {
  if (!state.sentences.length) return;
  if (state.playing) {
    state.playing = false;
    playToken++;
    audioEl.pause();
    setPlayIcon();
    $('nowStatus').textContent = '⏸ 已暫停';
  } else if (audioEl.src && audioEl.currentTime > 0 && !audioEl.ended) {
    // 從暫停的地方繼續
    state.playing = true;
    audioEl.playbackRate = state.speed;
    audioEl.play();
    setPlayIcon();
    $('nowStatus').textContent = `第 ${state.sentences[state.current].page} 頁・第 ${state.current + 1} / ${state.sentences.length} 句`;
  } else {
    playFrom(state.current);
  }
}

function step(delta) {
  let i = state.current + delta;
  while (i >= 0 && i < state.sentences.length && state.sentences[i].skip) i += delta;
  if (i < 0 || i >= state.sentences.length) return;
  audioEl.removeAttribute('src');
  playFrom(i);
}

function setPlayIcon() {
  $('playBtn').textContent = state.playing ? '⏸' : '▶';
}

function setSpeed(v) {
  state.speed = Math.round(Number(v) * 10) / 10;
  $('speedRange').value = state.speed;
  $('speedValue').textContent = state.speed.toFixed(1) + 'x';
  audioEl.defaultPlaybackRate = state.speed;
  audioEl.playbackRate = state.speed;
  document.querySelectorAll('.speed-presets button').forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.speed) === state.speed));
  $('downloadBtn').textContent = `⬇️ 下載音檔（${state.speed.toFixed(1)}x 速度）`;
  localStorage.setItem('speed', state.speed);
}

// 手機鎖定畫面 / 通知列的播放控制
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: state.fileName, artist: '英文 PDF 朗讀機' });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

// ---------- 下載 ----------
let downloading = false;
async function downloadAll() {
  if (downloading || !state.sentences.length) return;
  downloading = true;
  const btn = $('downloadBtn');
  btn.disabled = true;
  const speed = state.speed;
  const voice = state.voice;
  const n = state.sentences.length;
  try {
    const chunks = [];
    let sr = 24000;
    for (let i = 0; i < n; i++) {
      $('downloadStatus').textContent = speed === 1
        ? `正在組合音檔… ${i + 1} / ${n}`
        : `正在用 ${speed.toFixed(1)}x 速度重新產生… ${i + 1} / ${n}（可能需要一點時間）`;
      const a = await getAudio(i, speed);
      if (state.voice !== voice) throw new Error('下載途中更換了聲音，請重新按下載');
      if (!a.samples.length) continue;
      sr = a.sr;
      chunks.push(a.samples, new Float32Array(Math.round(sr * 0.35))); // 句子間留一點停頓
    }
    const blob = encodeWav(chunks, sr);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.fileName}_${speed.toFixed(1)}x.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('downloadStatus').textContent = `✅ 已下載（${(blob.size / 1e6).toFixed(1)} MB）`;
  } catch (err) {
    $('downloadStatus').textContent = '❌ ' + err.message;
  } finally {
    downloading = false;
    btn.disabled = false;
  }
}

// Float32 片段 → 16-bit 單聲道 WAV
function encodeWav(chunks, sr) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- 事件綁定 ----------
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stop();
  audioEl.removeAttribute('src');
  cache.clear();
  inflight.clear();
  state.current = 0;
  state.fileName = file.name.replace(/\.pdf$/i, '');
  $('uploadLabel').textContent = '📄 ' + file.name + '（點這裡換一個檔案）';
  try {
    const pages = await extractPages(file);
    renderText(pages);
    const readable = state.sentences.filter((s) => !s.skip).length;
    if (!readable) {
      $('pdfStatus').textContent = '⚠️ 這個 PDF 讀不到英文文字，可能是掃描的圖片檔（目前不支援）。';
      return;
    }
    $('pdfStatus').textContent = `共 ${pages.length} 頁、${readable} 句`;
    ['settingsCard', 'textCard', 'player'].forEach((id) => $(id).classList.remove('hidden'));
    $('nowStatus').textContent = '準備好了就按 ▶';
    updateGenProgress();
    prefetchLoop();
  } catch (err) {
    console.error(err);
    $('pdfStatus').textContent = '❌ 無法讀取這個 PDF：' + err.message;
  }
});

$('voiceSelect').addEventListener('change', (e) => {
  state.voice = e.target.value;
  localStorage.setItem('voice', state.voice);
  updateGenProgress();
  if (state.playing) playFrom(state.current);
  prefetchLoop();
});

$('speedRange').addEventListener('input', (e) => setSpeed(e.target.value));
document.querySelectorAll('.speed-presets button').forEach((b) =>
  b.addEventListener('click', () => setSpeed(b.dataset.speed)));
$('playBtn').addEventListener('click', togglePlay);
$('prevBtn').addEventListener('click', () => step(-1));
$('nextBtn').addEventListener('click', () => step(1));
$('downloadBtn').addEventListener('click', downloadAll);

// 還原上次的設定
const savedVoice = localStorage.getItem('voice');
if (savedVoice) { state.voice = savedVoice; $('voiceSelect').value = savedVoice; }
setSpeed(localStorage.getItem('speed') || 1);
