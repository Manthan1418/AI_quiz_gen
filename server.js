require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini SDK
let genAI = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Try the most commonly available model by default
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.MODEL_NAME || 'gemini-pro';

const app = express();
let PORT = parseInt(process.env.PORT, 10) || 3002;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve frontend files from /public

// Simple in-memory rate limiter (per IP)
const requests = new Map();
const RATE_LIMIT = 12; // requests
const RATE_WINDOW_MS = 60_000; // per minute

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = requests.get(ip) || [];
  const fresh = timestamps.filter(t => now - t < RATE_WINDOW_MS);
  fresh.push(now);
  requests.set(ip, fresh);
  return fresh.length <= RATE_LIMIT;
}

// Normalize and validate questions into the desired shape
function normalizeQuestions(items, count) {
  if (!Array.isArray(items)) return [];
  const questions = items.map((it) => {
    const question = (it.question || it.q || it.Q || '').toString().trim();
    let options = Array.isArray(it.options)
      ? it.options.map(String)
      : (Array.isArray(it.choices) ? it.choices.map(String) : []);

    // ensure options length 4 — if not, pad or truncate
    if (options.length < 4) {
      const o = options.slice();
      while (o.length < 4) o.push('Option');
      options = o.slice(0, 4);
    } else if (options.length > 4) {
      options = options.slice(0, 4);
    }

    const answer_index = typeof it.answer_index === 'number'
      ? it.answer_index
      : (typeof it.answerIndex === 'number'
        ? it.answerIndex
        : (typeof it.answer === 'string'
          ? (options.indexOf(it.answer) >= 0 ? options.indexOf(it.answer) : 0)
          : 0));

    const explanation = it.explanation ? String(it.explanation) : '';
    return { question, options, answer_index, explanation };
  }).filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2);

  return questions.slice(0, count);
}

// Helper: safe extraction and parsing of JSON from text
function extractJsonFromText(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const start = rawText.indexOf('```json');
    const end = rawText.lastIndexOf('```');
    if (start === -1 || end === -1) return null;
    let jsonString = rawText.slice(start + 7, end).trim();

    try {
        const parsed = JSON.parse(jsonString);
        return parsed;
    } catch (err) {
        return null;
    }
}


// Lazy-init Gemini
function ensureGemini() {
  if (genAI) return;
  try {
    if (!GEMINI_API_KEY) {
      console.warn('Warning: GEMINI_API_KEY is not set. Set it in .env before using Gemini.');
    }
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  } catch (e) {
    console.warn('Gemini SDK not available. Install with `npm i @google/generative-ai`.');
    throw e;
  }
}

// Try multiple models until one works
async function tryGenerateWithModel(modelName, prompt) {
  const model = genAI.getGenerativeModel({ model: modelName });
  try {
    console.log(`🤖 Trying model: ${modelName}...`);
    const result = await model.generateContent(prompt);
    const response = await result.response;
    console.log(`✅ Success with model: ${modelName}`);
    return response.text();
  } catch (err) {
    if (err.status === 404 || /not found/i.test(String(err.message || ''))) {
      console.log(`❌ Model ${modelName} not found or unsupported`);
      return null;
    }
    // For other errors, throw them
    throw err;
  }
}

// Provider implementations
async function generateWithGemini({ topic, count, usedQuestionsText }) {
  ensureGemini();
  
  // List of models to try, in order of preference
  const modelCandidates = [
    GEMINI_MODEL,           // try configured model first
    'gemini-pro',          // most common model name
    'gemini-1.0-pro',      // older version
    'gemini-pro-latest',   // potential latest version
    'gemini-1.0',          // basic model
    'gemini-pro-vision'    // vision model (fallback)
  ];

  const prompt = `
You are an assistant that generates multiple-choice questions in strict JSON only.
Generate exactly ${count} unique multiple-choice questions on the topic: "${topic}".
Each question must have 4 options (array length 4) and exactly one correct answer.
Return ONLY a JSON object and nothing else. The JSON object must follow this schema:

{
  "questions": [
    {
      "question": "string",
      "options": ["string","string","string","string"],
      "answer_index": 0,
      "explanation": "short explanation (optional)"
    }
  ]
}

Do NOT include any explanatory text, markdown, or backticks. Ensure the output is valid JSON.
${usedQuestionsText ? `Avoid repeating these exact question texts: ${usedQuestionsText}` : ''}
`;

  let responseText = null;
  let lastError = null;

  // Try each model in sequence until one works
  for (const modelName of modelCandidates) {
    try {
      responseText = await tryGenerateWithModel(modelName, prompt);
      if (responseText) {
        // If we got here with a non-null response, we succeeded
        break;
      }
    } catch (err) {
      console.log(`❌ Error with model ${modelName}:`, err.message || err);
      lastError = err;
      // Continue to next model unless it's a non-404 error
      if (err.status !== 404 && !/not found/i.test(String(err.message || ''))) {
        throw err; // Non-404 errors might indicate bigger problems
      }
    }
  }

  // If we tried all models and none worked
  if (!responseText) {
    const messageParts = [];
    messageParts.push(`Failed to generate content with any available model.`);
    messageParts.push(`Tried models: ${modelCandidates.join(', ')}`);
    if (lastError) {
      messageParts.push(`Last error: ${lastError.message || String(lastError)}`);
    }
    const e = new Error(messageParts.join(' '));
    e.triedModels = modelCandidates;
    e.lastError = lastError;
    e.status = 502;
    throw e;
  }

  const text = responseText;
  let parsed = extractJsonFromText(text);

  if (!parsed) {
      try {
          parsed = JSON.parse(text);
      } catch(e) {
        // ignore
      }
  }

  const questions = Array.isArray(parsed) ? parsed : parsed?.questions;

  if (!questions || !Array.isArray(questions)) {
    const err = new Error('Failed to parse Gemini JSON.');
    err.raw = typeof text === 'string' ? text.slice(0, 2000) : null;
    throw err;
  }

  return normalizeQuestions(questions, count);
}

// POST /generate-quiz
app.post('/generate-quiz', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress;
    if (!checkRateLimit(ip || 'global')) {
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }

    const { topic, count = 5, usedQuestionsText = '' } = req.body || {};
    if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
      return res.status(400).json({ error: 'Invalid topic (min 3 chars).' });
    }
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      return res.status(400).json({ error: 'Count must be integer between 1 and 20.' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured with GEMINI_API_KEY.' });
    }
    const questions = await generateWithGemini({ topic, count, usedQuestionsText });

    return res.json({ status: 'ok', questions });
  } catch (err) {
    console.error('Server error in /generate-quiz:', err);
    const payload = { error: 'Server error', details: err.message };
    if (err.raw) payload.raw = err.raw;
    if (err.providerError) payload.provider = err.providerError;
    if (err.triedModels) {
      payload.tried_models = err.triedModels;
      return res.status(502).json({
        error: 'No supported models available',
        details: err.message,
        tried_models: err.triedModels,
        configured_model: GEMINI_MODEL
      });
    }
    return res.status(500).json(payload);
  }
});

// GET /list-models - helpful for debugging which models are available/allowed
app.get('/list-models', async (req, res) => {
  try {
    ensureGemini();
    if (typeof genAI.listModels === 'function') {
      const models = await genAI.listModels();
      return res.json({ status: 'ok', models });
    }
    return res.status(501).json({ error: 'listModels not supported by SDK in this version. Check provider docs or upgrade SDK.' });
  } catch (err) {
    console.error('Error in /list-models:', err);
    return res.status(500).json({ error: 'Failed to list models', details: err.message || String(err) });
  }
});

// Serve static index if requested
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204));

// Start the server
const shouldTunnel = process.argv.includes('--tunnel');
let tunnelInstance = null;

async function startServer(attempt = 0) {
  const maxAttempts = 5;
  const server = app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🚀 Server is running at ${url}`);
    console.log(`📦 Provider: gemini`);
    console.log(`🔎 Configured model: ${GEMINI_MODEL}`);

    if (shouldTunnel) {
      try {
        const localtunnel = require('localtunnel');
        tunnelInstance = await localtunnel({ port: PORT });
        console.log(`🔗 Public URL (localtunnel): ${tunnelInstance.url}`);
        tunnelInstance.on('close', () => console.log('Tunnel closed'));
      } catch (e) {
        console.error('Failed to start localtunnel:', e && e.message ? e.message : e);
      }
    }
  });

  server.on('error', async (err) => {
    if (err && err.code === 'EADDRINUSE' && attempt < maxAttempts) {
      const oldPort = PORT;
      PORT = PORT + 1;
      console.warn(`Port ${oldPort} is in use, retrying on port ${PORT} (attempt ${attempt + 1}/${maxAttempts})`);
      // small delay before retrying
      setTimeout(() => startServer(attempt + 1), 300);
      return;
    }
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

startServer();