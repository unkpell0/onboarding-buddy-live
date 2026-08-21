// api/ask.js
// Serverless proxy for Onboarding Buddy's query pipeline.
// Ports the two Langflow prompt steps (condensation + answer generation)
// directly, so this runs standalone without needing Langflow hosted anywhere.
//
// Required environment variables (set these in your hosting provider's dashboard,
// NEVER commit them to a file or write them into the frontend):
//
//   GOOGLE_API_KEY              - your Gemini API key
//   ASTRA_DB_API_ENDPOINT       - e.g. https://<db-id>-<region>.apps.astra.datastax.com
//   ASTRA_DB_APPLICATION_TOKEN  - your AstraDB application token
//   ASTRA_DB_NAMESPACE          - usually "default_keyspace"
//   ASTRA_DB_COLLECTION         - e.g. "hr_documents"
//
// Optional:
//   CONTENT_FIELD               - field name holding chunk text (default: "text")
//   GEMINI_EMBED_MODEL          - default: "gemini-embedding-001"
//   GEMINI_CONDENSE_MODEL       - default: "gemini-2.5-flash"
//   GEMINI_ANSWER_MODEL         - default: "gemini-2.5-flash-lite"
//
// IMPORTANT: verify GEMINI_CONDENSE_MODEL / GEMINI_ANSWER_MODEL against whatever
// model names you actually have API access to (the Langflow flow used
// "gemini-3.5-flash" and "gemini-3-flash-lite" — set env vars to match if those
// are your real available model IDs).

const SIMILARITY_THRESHOLD = 0.7;
const MAX_RESULTS = 4;
const MAX_QUESTION_LENGTH = 400;

// --- very basic in-memory rate limiter ---------------------------------
// NOTE: serverless functions can run on multiple instances, so this is a
// best-effort guard against a single hammering client, not a hard limit.
// For real protection under real traffic, swap this for Upstash Redis or
// Vercel's own rate-limiting middleware.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 12;
const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// --- Gemini helpers -------------------------------------------------------

async function embedText(text) {
  const model = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${process.env.GOOGLE_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!resp.ok) throw new Error(`Embedding request failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.embedding.values;
}

async function generateText(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  if (!resp.ok) throw new Error(`Generation request failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from model');
  return text.trim();
}

// --- prompt templates, ported directly from the Langflow flow -------------

function buildCondensePrompt(chatHistory, question) {
  return `Ubah pertanyaan lanjutan menjadi pertanyaan mandiri yang SPESIFIK, dengan mempertahankan topik
persis dari pertanyaan sebelumnya (bukan topik umum). Contoh: jika pertanyaan sebelumnya tentang
'visi perusahaan' dan pertanyaan lanjutan adalah 'jelaskan lebih lanjut', hasilnya harus
'jelaskan lebih lanjut tentang visi perusahaan', bukan 'jelaskan lebih lanjut tentang perusahaan'.

Riwayat percakapan:
${chatHistory}

Pertanyaan lanjutan:
${question}

Pertanyaan mandiri:`;
}

function buildAnswerPrompt({ chatHistory, context, question }) {
  return `Anda adalah "Onboarding Buddy" - asisten virtual yang membantu karyawan baru selama masa orientasi mereka.

Gaya komunikasi Anda: suportif, proaktif, profesional, dan ringkas. Hindari basa-basi berlebihan; utamakan jawaban yang jelas dan actionable.

Riwayat percakapan sebelumnya:
${chatHistory}

Konteks (sumber informasi resmi):
${context}
---

ATURAN JAWABAN:
1. Jawab HANYA berdasarkan Konteks di atas. Dilarang menambahkan asumsi, alasan, atau kebijakan yang tidak tertulis secara eksplisit di Konteks — termasuk saran umum yang terdengar masuk akal namun tidak ada sumbernya.
2. Jika informasi yang ditanyakan tidak tersedia di Konteks, katakan dengan jujur bahwa Anda tidak memiliki informasi tersebut, dan arahkan karyawan untuk menghubungi tim HR. Jangan mengarang jawaban.
3. Gunakan Riwayat percakapan hanya untuk menjaga konteks alur diskusi (misalnya memahami pertanyaan lanjutan seperti "jelaskan lebih detail"). Jangan jadikan riwayat percakapan sebagai sumber fakta perusahaan — fakta harus selalu berasal dari Konteks di atas.
4. Jika Konteks relevan tersedia, strukturkan jawaban Anda: (a) jawaban langsung terhadap pertanyaan, (b) langkah praktis jika berlaku, (c) tawaran bantuan lanjutan yang singkat.
5. Jaga jawaban tetap ringkas — maksimal 3-4 paragraf pendek atau poin-poin, hindari pengulangan informasi.

Pertanyaan:
${question}

Jawaban:`;
}

// --- AstraDB ---------------------------------------------------------------

async function searchAstra(vector) {
  const endpoint = process.env.ASTRA_DB_API_ENDPOINT.replace(/\/+$/, '');
  const namespace = process.env.ASTRA_DB_NAMESPACE || 'default_keyspace';
  const collection = process.env.ASTRA_DB_COLLECTION;
  const contentField = process.env.CONTENT_FIELD || 'text';

  const url = `${endpoint}/api/json/v1/${namespace}/${collection}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Token': process.env.ASTRA_DB_APPLICATION_TOKEN,
    },
    body: JSON.stringify({
      find: {
        sort: { $vector: vector },
        options: { limit: MAX_RESULTS, includeSimilarity: true },
      },
    }),
  });

  if (!resp.ok) throw new Error(`AstraDB request failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const documents = data?.data?.documents || [];

  return documents
    .filter(doc => (doc.$similarity ?? 0) >= SIMILARITY_THRESHOLD)
    .map(doc => ({
      text: doc[contentField] || '',
      similarity: doc.$similarity,
      filePath: doc.file_path || null,
    }));
}

// --- handler ----------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    return;
  }

  const { question, history } = req.body || {};

  if (!question || typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ error: 'Missing question' });
    return;
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({ error: `Question too long (max ${MAX_QUESTION_LENGTH} characters)` });
    return;
  }

  const chatHistoryText = Array.isArray(history) && history.length
    ? history.map(h => `${h.role === 'user' ? 'User' : 'AI'}: ${h.content}`).join('\n')
    : '(tidak ada riwayat sebelumnya)';

  try {
    let standaloneQuestion = question.trim();

    if (Array.isArray(history) && history.length) {
      const condenseModel = process.env.GEMINI_CONDENSE_MODEL || 'gemini-2.5-flash';
      standaloneQuestion = await generateText(
        condenseModel,
        buildCondensePrompt(chatHistoryText, question.trim())
      );
    }

    const vector = await embedText(standaloneQuestion);
    const matches = await searchAstra(vector);
    const context = matches.length
      ? matches.map(m => m.text).join('\n\n---\n\n')
      : '(tidak ada dokumen relevan ditemukan)';

    const answerModel = process.env.GEMINI_ANSWER_MODEL || 'gemini-2.5-flash-lite';
    const answer = await generateText(
      answerModel,
      buildAnswerPrompt({ chatHistory: chatHistoryText, context, question: standaloneQuestion })
    );

    res.status(200).json({
      answer,
      condensedQuery: standaloneQuestion,
      matchedChunks: matches.length,
    });
  } catch (err) {
    console.error('ask.js error:', err);
    res.status(500).json({
      error: 'Something went wrong reaching the database or model. If this is the first request in a while, AstraDB may be waking up from hibernation — please try again in about a minute.',
    });
  }
};
