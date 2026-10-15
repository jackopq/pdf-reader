// 語音合成 Web Worker：在背景執行 Kokoro 模型，避免畫面卡頓
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;
let loading = null;
// 用 Promise 串接，確保一次只合成一句
let chain = Promise.resolve();
// 各檔案下載進度
const files = {};

function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8', // 量化版本，約 90MB，手機也跑得動
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files[p.file] = { loaded: p.loaded, total: p.total };
            let loaded = 0, total = 0;
            for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
            postMessage({ type: 'progress', loaded, total });
          }
        },
      });
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', message: String(err?.message || err) });
    }
  })();
  return loading;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    load();
  } else if (m.type === 'generate') {
    chain = chain.then(async () => {
      try {
        await load();
        const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
        // 複製一份，避免 view 指向更大的 buffer
        const samples = new Float32Array(audio.audio);
        postMessage({ type: 'result', id: m.id, audio: samples, sr: audio.sampling_rate }, [samples.buffer]);
      } catch (err) {
        postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
      }
    });
  }
};
