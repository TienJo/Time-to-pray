import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { initializeApp as initializeAdminApp, getApps, getApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const firebaseConfigPath = path.join(__dirname, 'firebase-applet-config.json');
let firebaseConfig = {};
try {
  firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
} catch (err) {
  console.warn('Warning: firebase-applet-config.json could not be read:', err.message);
}

const FIREBASE_PROJECT_ID = firebaseConfig.projectId || process.env.FIREBASE_PROJECT_ID || '';
const FIRESTORE_DATABASE_ID = firebaseConfig.firestoreDatabaseId || '(default)';

let adminAuth = null;
if (FIREBASE_PROJECT_ID) {
  const adminApp = getApps().length
    ? getApp()
    : initializeAdminApp({ projectId: FIREBASE_PROJECT_ID });
  adminAuth = getAdminAuth(adminApp);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const ai = new GoogleGenAI({
  ...(process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY } : {}),
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const BLOCKED_FILES = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
  '/README.md',
  '/firestore.rules',
  '/firebase-blueprint.json',
  '/security_spec.md',
  '/eslint.config.mjs',
]);

app.use((req, res, next) => {
  if (BLOCKED_FILES.has(req.path) || req.path.startsWith('/node_modules') || req.path.startsWith('/.')) {
    return res.status(404).end();
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

// ==========================================
// Firebase ID Token Verification & Firestore REST Helpers
// ==========================================
const VALID_NODE_TYPES = new Set(['anxiety', 'gratitude', 'reflection', 'scripture']);
const ID_REGEX = /^[a-zA-Z0-9_\-]{1,128}$/;
const PARENT_ID_REGEX = /^[a-zA-Z0-9_\-]{0,128}$/;

function getFirestoreDocumentsBaseUrl() {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/${encodeURIComponent(FIRESTORE_DATABASE_ID)}/documents`;
}

function getPrayerNodeDocPath(uid, nodeId) {
  return `projects/${FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents/users/${uid}/prayer_nodes/${nodeId}`;
}

function encodeFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(encodeFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = encodeFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function decodeFirestoreValue(fv) {
  if (!fv || typeof fv !== 'object') return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return Boolean(fv.booleanValue);
  if ('integerValue' in fv) return Number(fv.integerValue);
  if ('doubleValue' in fv) return Number(fv.doubleValue);
  if ('stringValue' in fv) return fv.stringValue;
  if ('timestampValue' in fv) return Date.parse(fv.timestampValue) || fv.timestampValue;
  if ('arrayValue' in fv) {
    return Array.isArray(fv.arrayValue?.values)
      ? fv.arrayValue.values.map(decodeFirestoreValue)
      : [];
  }
  if ('mapValue' in fv) {
    const out = {};
    const fields = fv.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function decodePrayerDoc(docObj) {
  if (!docObj || !docObj.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(docObj.fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  if (!out.id && docObj.name) {
    out.id = docObj.name.split('/').pop();
  }
  return out;
}

async function firestoreRestFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function requireFirebaseUser(req, res, next) {
  if (!adminAuth || !FIREBASE_PROJECT_ID) {
    return res.status(503).json({ error: 'Firebase cloud configuration is not available on this server.' });
  }
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <Firebase ID Token> header.' });
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Empty bearer token.' });
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (decoded.email_verified !== true) {
      return res.status(403).json({ error: 'A verified Google/email account is required to access cloud prayer data.' });
    }
    req.firebaseUser = decoded;
    req.firebaseToken = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired Firebase ID token.' });
  }
}

function validateCreateNodePayload(body, uid) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const rawId = body.id !== undefined && body.id !== null && body.id !== ''
    ? String(body.id).trim()
    : `node-${crypto.randomUUID().slice(0, 8)}`;
  if (!ID_REGEX.test(rawId)) {
    return { error: 'Invalid id: must be 1-128 characters matching ^[a-zA-Z0-9_-]+$.' };
  }

  const type = typeof body.type === 'string' ? body.type.trim() : 'anxiety';
  if (!VALID_NODE_TYPES.has(type)) {
    return { error: 'Invalid type: must be anxiety, gratitude, reflection, or scripture.' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (title.length > 200) return { error: 'title exceeds 200 characters.' };
  if (content.length > 5000) return { error: 'content exceeds 5000 characters.' };
  if (!title && !content) return { error: 'At least title or content must be non-empty.' };

  let parentId = null;
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') {
    if (typeof body.parentId !== 'string' || !PARENT_ID_REGEX.test(body.parentId)) {
      return { error: 'Invalid parentId format.' };
    }
    parentId = body.parentId;
  }

  const reference = typeof body.reference === 'string' ? body.reference.slice(0, 200) : '';
  const x = body.x !== undefined ? Number(body.x) : 415;
  const y = body.y !== undefined ? Number(body.y) : 0;
  if (!Number.isFinite(x) || x < -50000 || x > 50000 || !Number.isFinite(y) || y < -50000 || y > 50000) {
    return { error: 'x and y must be finite numbers between -50000 and 50000.' };
  }

  const collapsed = typeof body.collapsed === 'boolean' ? body.collapsed : false;
  const answered = typeof body.answered === 'boolean' ? body.answered : false;

  return {
    node: {
      id: rawId,
      ownerId: uid,
      parentId,
      type,
      title,
      content,
      reference,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      collapsed,
      answered,
    }
  };
}

function validatePatchNodePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }
  const immutableFields = ['id', 'ownerId', 'type', 'createdAt'];
  for (const field of immutableFields) {
    if (field in body) {
      return { error: `Field "${field}" cannot be modified after creation.` };
    }
  }

  const allowedKeys = new Set(['parentId', 'title', 'content', 'reference', 'x', 'y', 'collapsed', 'answered']);
  const updates = {};

  for (const [k, v] of Object.entries(body)) {
    if (!allowedKeys.has(k)) {
      return { error: `Unsupported field "${k}".` };
    }
    if (k === 'parentId') {
      if (v === null || v === '') updates.parentId = null;
      else if (typeof v === 'string' && PARENT_ID_REGEX.test(v)) updates.parentId = v;
      else return { error: 'Invalid parentId format.' };
    } else if (k === 'title') {
      if (typeof v !== 'string' || v.length > 200) return { error: 'title must be a string <= 200 chars.' };
      updates.title = v;
    } else if (k === 'content') {
      if (typeof v !== 'string' || v.length > 5000) return { error: 'content must be a string <= 5000 chars.' };
      updates.content = v;
    } else if (k === 'reference') {
      if (typeof v !== 'string' || v.length > 200) return { error: 'reference must be a string <= 200 chars.' };
      updates.reference = v;
    } else if (k === 'x' || k === 'y') {
      const num = Number(v);
      if (!Number.isFinite(num) || num < -50000 || num > 50000) {
        return { error: `${k} must be a finite number between -50000 and 50000.` };
      }
      updates[k] = Math.round(num * 100) / 100;
    } else if (k === 'collapsed' || k === 'answered') {
      if (typeof v !== 'boolean') return { error: `${k} must be a boolean.` };
      updates[k] = v;
    }
  }

  if (Object.keys(updates).length === 0) {
    return { error: 'No updatable fields provided.' };
  }
  return { updates };
}

async function listUserPrayers(uid, token) {
  const url = `${getFirestoreDocumentsBaseUrl()}/users/${encodeURIComponent(uid)}:runQuery`;
  const result = await firestoreRestFetch(url, token, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'prayer_nodes' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'ownerId' },
            op: 'EQUAL',
            value: { stringValue: uid }
          }
        }
      }
    })
  });
  if (!result.ok) return result;
  const rows = Array.isArray(result.data) ? result.data : [];
  const items = rows
    .filter(r => r && r.document)
    .map(r => decodePrayerDoc(r.document))
    .filter(Boolean)
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  return { ok: true, status: 200, items };
}

// ==========================================
// Cloud Prayer Nodes REST API Router
// ==========================================
const prayersRouter = express.Router();
prayersRouter.use(requireFirebaseUser);

prayersRouter.get('/', async (req, res) => {
  try {
    const uid = req.firebaseUser.uid;
    const listed = await listUserPrayers(uid, req.firebaseToken);
    if (!listed.ok) {
      return res.status(listed.status).json({ error: listed.data?.error?.message || 'Failed to list prayers from cloud.' });
    }
    res.json({
      uid,
      email: req.firebaseUser.email || null,
      count: listed.items.length,
      items: listed.items
    });
  } catch (err) {
    console.error('GET /api/prayers error:', err);
    res.status(500).json({ error: 'Internal server error while fetching cloud prayers.' });
  }
});

prayersRouter.get('/:id', async (req, res) => {
  const nodeId = req.params.id;
  if (!ID_REGEX.test(nodeId)) {
    return res.status(400).json({ error: 'Invalid prayer node ID.' });
  }
  try {
    const uid = req.firebaseUser.uid;
    const url = `${getFirestoreDocumentsBaseUrl()}/users/${encodeURIComponent(uid)}/prayer_nodes/${encodeURIComponent(nodeId)}`;
    const result = await firestoreRestFetch(url, req.firebaseToken, { method: 'GET' });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.data?.error?.message || 'Prayer node not found.' });
    }
    res.json({ item: decodePrayerDoc(result.data) });
  } catch (err) {
    console.error('GET /api/prayers/:id error:', err);
    res.status(500).json({ error: 'Internal server error while fetching prayer node.' });
  }
});

prayersRouter.post('/', async (req, res) => {
  const uid = req.firebaseUser.uid;
  const validated = validateCreateNodePayload(req.body, uid);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }
  const node = validated.node;

  try {
    const fields = {};
    for (const [k, v] of Object.entries(node)) {
      fields[k] = encodeFirestoreValue(v);
    }

    const commitUrl = `${getFirestoreDocumentsBaseUrl()}:commit`;
    const commitRes = await firestoreRestFetch(commitUrl, req.firebaseToken, {
      method: 'POST',
      body: JSON.stringify({
        writes: [
          {
            currentDocument: { exists: false },
            update: {
              name: getPrayerNodeDocPath(uid, node.id),
              fields
            },
            updateTransforms: [
              { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
              { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }
            ]
          }
        ]
      })
    });

    if (!commitRes.ok) {
      return res.status(commitRes.status).json({
        error: commitRes.data?.error?.message || 'Failed to save prayer node to cloud.'
      });
    }

    const getUrl = `${getFirestoreDocumentsBaseUrl()}/users/${encodeURIComponent(uid)}/prayer_nodes/${encodeURIComponent(node.id)}`;
    const fetched = await firestoreRestFetch(getUrl, req.firebaseToken, { method: 'GET' });
    res.status(201).json({
      item: fetched.ok ? decodePrayerDoc(fetched.data) : node
    });
  } catch (err) {
    console.error('POST /api/prayers error:', err);
    res.status(500).json({ error: 'Internal server error while creating cloud prayer node.' });
  }
});

prayersRouter.patch('/:id', async (req, res) => {
  const nodeId = req.params.id;
  if (!ID_REGEX.test(nodeId)) {
    return res.status(400).json({ error: 'Invalid prayer node ID.' });
  }

  const validated = validatePatchNodePayload(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  try {
    const uid = req.firebaseUser.uid;
    const fields = {};
    const fieldPaths = [];
    for (const [k, v] of Object.entries(validated.updates)) {
      fields[k] = encodeFirestoreValue(v);
      fieldPaths.push(k);
    }

    const commitUrl = `${getFirestoreDocumentsBaseUrl()}:commit`;
    const commitRes = await firestoreRestFetch(commitUrl, req.firebaseToken, {
      method: 'POST',
      body: JSON.stringify({
        writes: [
          {
            currentDocument: { exists: true },
            update: {
              name: getPrayerNodeDocPath(uid, nodeId),
              fields
            },
            updateMask: { fieldPaths },
            updateTransforms: [
              { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }
            ]
          }
        ]
      })
    });

    if (!commitRes.ok) {
      return res.status(commitRes.status).json({
        error: commitRes.data?.error?.message || 'Failed to update prayer node in cloud.'
      });
    }

    const getUrl = `${getFirestoreDocumentsBaseUrl()}/users/${encodeURIComponent(uid)}/prayer_nodes/${encodeURIComponent(nodeId)}`;
    const fetched = await firestoreRestFetch(getUrl, req.firebaseToken, { method: 'GET' });
    res.json({
      item: fetched.ok ? decodePrayerDoc(fetched.data) : { id: nodeId, ...validated.updates }
    });
  } catch (err) {
    console.error('PATCH /api/prayers/:id error:', err);
    res.status(500).json({ error: 'Internal server error while updating cloud prayer node.' });
  }
});

prayersRouter.delete('/:id', async (req, res) => {
  const nodeId = req.params.id;
  if (!ID_REGEX.test(nodeId)) {
    return res.status(400).json({ error: 'Invalid prayer node ID.' });
  }

  try {
    const uid = req.firebaseUser.uid;
    const cascade = req.query.cascade === 'true';

    if (!cascade) {
      const delUrl = `${getFirestoreDocumentsBaseUrl()}/users/${encodeURIComponent(uid)}/prayer_nodes/${encodeURIComponent(nodeId)}`;
      const delRes = await firestoreRestFetch(delUrl, req.firebaseToken, { method: 'DELETE' });
      if (!delRes.ok) {
        return res.status(delRes.status).json({
          error: delRes.data?.error?.message || 'Failed to delete prayer node.'
        });
      }
      return res.json({ deletedIds: [nodeId] });
    }

    const listed = await listUserPrayers(uid, req.firebaseToken);
    if (!listed.ok) {
      return res.status(listed.status).json({ error: listed.data?.error?.message || 'Failed to query child branches.' });
    }
    const toDelete = new Set([nodeId]);
    let added = true;
    while (added) {
      added = false;
      for (const item of listed.items) {
        if (item.parentId && toDelete.has(item.parentId) && !toDelete.has(item.id)) {
          toDelete.add(item.id);
          added = true;
        }
      }
    }

    const writes = [...toDelete].map(id => ({
      delete: getPrayerNodeDocPath(uid, id)
    }));
    const commitUrl = `${getFirestoreDocumentsBaseUrl()}:commit`;
    const commitRes = await firestoreRestFetch(commitUrl, req.firebaseToken, {
      method: 'POST',
      body: JSON.stringify({ writes })
    });
    if (!commitRes.ok) {
      return res.status(commitRes.status).json({
        error: commitRes.data?.error?.message || 'Failed to delete prayer subtree.'
      });
    }

    res.json({ deletedIds: [...toDelete] });
  } catch (err) {
    console.error('DELETE /api/prayers/:id error:', err);
    res.status(500).json({ error: 'Internal server error while deleting cloud prayer node.' });
  }
});

app.use('/api/prayers', prayersRouter);
app.use('/api/prayer-nodes', prayersRouter);

// ==========================================
// AI Scripture Lookup Route
// ==========================================
const CUV_BIBLE_KNOWLEDGE_BASE = [
  {
    keywords: ['焦慮', '掛慮', '擔心', '不安', '壓力', '緊張', '害怕', '恐懼', '失眠'],
    verses: [
      {
        reference: '彼得前書 5:7',
        verseText: '你們要將一切的憂慮卸給神，因為他顧念你們。',
        encouragement: '神親自顧念你的每一個重擔，現在就可以安心卸下交給祂。'
      },
      {
        reference: '約翰福音 14:27',
        verseText: '我留下平安給你們；我將我的平安賜給你們。我所賜的，不像世人所賜的。你們心裡不要憂愁，也不要膽怯。',
        encouragement: '主所賜的平安超越環境的風浪，深呼吸領受這份屬天的安息。'
      }
    ]
  },
  {
    keywords: ['工作', '未來', '方向', '迷惘', '決定', '智慧', '選擇', '學業', '考試'],
    verses: [
      {
        reference: '箴言 3:5-6',
        verseText: '你要專心仰賴耶和華，不可倚靠自己的聰明，在你一切所行的事上都要認定他，他必指引你的路。',
        encouragement: '不必獨自算計所有下一步，認定神，祂必為你鋪平前方的道路。'
      },
      {
        reference: '耶利米書 29:11',
        verseText: '耶和華說：我知道我向你們所懷的意念是賜平安的意念，不是降災禍的意念，要叫你們末後有指望。',
        encouragement: '神對你的未來懷抱著平安與盼望的藍圖，放心交託給祂帶領。'
      }
    ]
  },
  {
    keywords: ['疲憊', '軟弱', '無力', '累', '辛苦', '撐不住', '困難', '挑戰'],
    verses: [
      {
        reference: '馬太福音 11:28',
        verseText: '凡勞苦擔重擔的人可以到我這裡來，我就使你們得安息。',
        encouragement: '累了就來到主面前歇息，祂從不責備你的軟弱，反而要親自更新你。'
      },
      {
        reference: '以賽亞書 40:31',
        verseText: '但那等候耶和華的必從新得力。他們必如鷹展翅上騰；他們奔跑卻不困倦，行走卻不疲乏。',
        encouragement: '在安靜等候中，神正為你重新注入如鷹展翅的力量。'
      }
    ]
  },
  {
    keywords: ['感謝', '感恩', '讚美', '恩典', '喜樂', '祝福', '開心', '幫助'],
    verses: [
      {
        reference: '帖撒羅尼迦前書 5:16-18',
        verseText: '要常常喜樂，不住的禱告，凡事謝恩；因為這是神在基督耶穌裡向你們所定的旨意。',
        encouragement: '數算恩典的心會開啟更多祝福的門，願喜樂持續充滿你的生命。'
      },
      {
        reference: '詩篇 103:2',
        verseText: '我的心哪，你要稱頌耶和華！不可忘記他的一切恩惠！',
        encouragement: '把今天所領受的恩惠記在心版上，成為日後信心的見證。'
      }
    ]
  }
];

function matchBuiltInScriptures(text) {
  const lower = (text || '').toLowerCase();
  for (const group of CUV_BIBLE_KNOWLEDGE_BASE) {
    if (group.keywords.some(k => lower.includes(k))) {
      return group.verses;
    }
  }
  return [
    {
      reference: '詩篇 46:1',
      verseText: '神是我們的避難所，是我們的力量，是我們在患難中隨時的幫助。',
      encouragement: '無論此刻你正在經歷什麼，神都是你隨時可得的力量與避難所。'
    },
    {
      reference: '羅馬書 8:28',
      verseText: '我們曉得萬事都互相效力，叫愛神的人得益處，就是按他旨意被召的人。',
      encouragement: '相信神正在每一件大小事中動工，為你編織美好的益處。'
    }
  ];
}

app.post('/api/ai/scripture', async (req, res) => {
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const typeLabel = typeof rawBody.typeLabel === 'string' ? rawBody.typeLabel.slice(0, 64) : '禱告事項';
  const title = typeof rawBody.title === 'string' ? rawBody.title.slice(0, 200) : '';
  const content = typeof rawBody.content === 'string' ? rawBody.content.slice(0, 5000) : '';

  try {
    if (!process.env.GEMINI_API_KEY) {
      const verses = matchBuiltInScriptures(`${title} ${content}`);
      return res.json({ verses });
    }

    const systemPrompt = `你是一位充滿愛心、溫柔且熟讀聖經（繁體中文和合本）的屬靈陪伴者。
使用者在「禱告心智畫布」上建立了一張【${typeLabel}】節點卡片。
請根據對方的處境與內容，從聖經中挑選出 2 段最貼切、能帶來安慰、力量或共鳴的經文（使用繁體中文和合本），並附上簡短溫暖的靈修亮光。`;

    const userQuery = `節點類型：${typeLabel}\n主題：${title || '無標題'}\n內容：${content || '請為我的心禱告'}`;

    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: [{ parts: [{ text: userQuery }] }],
      config: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            verses: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  reference: { type: Type.STRING, description: "經卷章節，例如：詩篇 23:1-4" },
                  verseText: { type: Type.STRING, description: "繁體中文和合本經文內容" },
                  encouragement: { type: Type.STRING, description: "簡短溫暖的鼓勵與禱告方向（約30-45字）" }
                },
                required: ["reference", "verseText", "encouragement"]
              }
            }
          },
          required: ["verses"]
        }
      }
    });

    const jsonText = response.text;
    if (!jsonText) throw new Error("Empty AI response");
    const parsed = JSON.parse(jsonText);
    res.json(parsed);
  } catch (err) {
    console.warn("AI generation failed, falling back to built-in scripture knowledge base:", err);
    const verses = matchBuiltInScriptures(`${title} ${content}`);
    res.json({ verses });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use(express.static(__dirname, { dotfiles: 'ignore', index: 'index.html' }));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

