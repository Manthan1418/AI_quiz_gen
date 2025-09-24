require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'gemini-1.5-flash-latest';

if (!GEMINI_API_KEY) {
  console.warn("Warning: GEMINI_API_KEY is not set. Set it in .env before using Gemini.");
}

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
  // remove old
  const fresh = timestamps.filter(t => now - t < RATE_WINDOW_MS);
  fresh.push(now);
  requests.set(ip, fresh);
  return fresh.length <= RATE_LIMIT;
}

// Helper: safe extraction and parsing of JSON from Gemini text
function extractJsonArrayFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  // Find first '[' and last ']' (naive but effective)
  const start = rawText.indexOf('[');
  const end = rawText.lastIndexOf(']') + 1;
  if (start === -1 || end === -1) return null;
  let jsonString = rawText.slice(start, end);

  // clean common markdown fences/backticks and unicode quotes
  jsonString = jsonString.replace(/```json|```/g, '');
  jsonString = jsonString.replace(/“|”/g, '"').replace(/‘|’/g, "'");
  // remove trailing commas before closing braces/brackets (lenient)
  jsonString = jsonString.replace(/,(\s*[}\]])/g, '$1');

  // collapse repeated whitespace/newlines that sometimes break parsing
  jsonString = jsonString.replace(/\r\n/g, '\n').replace(/\n+/g, '\n').trim();

  try {
    const parsed = JSON.parse(jsonString);
    return parsed;
  } catch (err) {
    // failed parse
    return null;
  }
}

// POST /generate-quiz
// Body: { topic: string, count: number, usedQuestionsText?: string }
app.post('/generate-quiz', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip)) {
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

    // Build a strict prompt instructing Gemini to return ONLY valid JSON array
    const prompt = `
You are an assistant that generates multiple-choice questions in strict JSON only. 
Generate exactly ${count} unique multiple-choice questions on the topic: "${topic}".
Each question must have 4 options (array length 4) and exactly one correct answer.
Return ONLY a JSON array and nothing else. The JSON array must follow this schema:

[
  {
    "question": "string",
    "options": ["string","string","string","string"],
    "answer_index": 0,  // integer 0-3 giving the index of the correct option
    "explanation": "short explanation (optional)"
  }
]

Do NOT include any explanatory text, markdown, or backticks. Ensure the output is valid JSON.
${usedQuestionsText ? `Avoid repeating these exact question texts: ${usedQuestionsText}` : ''}
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await r.json();

    if (data.error) {
      console.error('Gemini returned error:', data.error);
      return res.status(502).json({ error: 'Gemini API error', details: data.error });
    }

    // Try to extract text from response candidates
    let rawText = null;
    try {
      if (data.candidates && data.candidates.length > 0) {
        // typical shape: data.candidates[0].content.parts[0].text
        const cand = data.candidates[0];
        if (cand.content && Array.isArray(cand.content.parts) && cand.content.parts.length > 0) {
          rawText = cand.content.parts[0].text;
        } else if (cand.content && cand.content[0] && cand.content[0].text) {
          rawText = cand.content[0].text;
        } else if (cand.output && Array.isArray(cand.output) && cand.output.length) {
          // fallback
          rawText = JSON.stringify(cand.output);
        }
      } else if (data.output && Array.isArray(data.output) && data.output.length) {
        rawText = JSON.stringify(data.output);
      } else if (typeof data === 'string') {
        rawText = data;
      } else {
        rawText = JSON.stringify(data);
      }
    } catch (ex) {
      rawText = JSON.stringify(data);
    }

    const parsed = extractJsonArrayFromText(rawText);

    if (!parsed || !Array.isArray(parsed)) {
      console.error('Failed to parse JSON from Gemini response. Raw text:\n', rawText);
      return res.status(500).json({
        error: 'Failed to parse Gemini JSON.',
        raw: rawText ? rawText.slice(0, 2000) : null
      });
    }

    // Normalize and validate each question
    const questions = parsed.map((it) => {
      const question = (it.question || it.q || it.Q || '').toString().trim();
      const options = Array.isArray(it.options) ? it.options.map(String) : (Array.isArray(it.choices) ? it.choices.map(String) : []);
      // ensure options length 4 — if not, pad or truncate
      if (options.length < 4) {
        // try to salvage using object fields
        const o = options.slice();
        while (o.length < 4) o.push('Option');
        while (o.length > 4) o.pop();
        // continue with padded o
      }
      const answer_index = typeof it.answer_index === 'number' ? it.answer_index
        : (typeof it.answerIndex === 'number' ? it.answerIndex : (typeof it.answer === 'string' ? (options.indexOf(it.answer) >= 0 ? options.indexOf(it.answer) : 0) : 0));
      const explanation = it.explanation ? String(it.explanation) : '';
      return { question, options, answer_index, explanation };
    }).filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2);

    // Return trimmed array (limit to requested count)
    const trimmed = questions.slice(0, count);

    return res.json({ status: 'ok', questions: trimmed });
  } catch (err) {
    console.error('Server error in /generate-quiz:', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Serve static index if requested
app.get('/', (req, res) => {
  res.sendFile(require('path').resolve(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
