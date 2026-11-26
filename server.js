import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
]);

app.use((req, res, next) => {
  if (BLOCKED_FILES.has(req.path) || req.path.startsWith('/node_modules') || req.path.startsWith('/.')) {
    return res.status(404).end();
  }
  next();
});

app.use(express.json());

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
  try {
    const { typeLabel, title, content } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      const verses = matchBuiltInScriptures(`${title} ${content}`);
      return res.json({ verses });
    }

    const systemPrompt = `你是一位充滿愛心、溫柔且熟讀聖經（繁體中文和合本）的屬靈陪伴者。
使用者在「禱告心智畫布」上建立了一張【${typeLabel || '禱告事項'}】節點卡片。
請根據對方的處境與內容，從聖經中挑選出 2 段最貼切、能帶來安慰、力量或共鳴的經文（使用繁體中文和合本），並附上簡短溫暖的靈修亮光。`;

    const userQuery = `節點類型：${typeLabel || '禱告事項'}\n主題：${title || '無標題'}\n內容：${content || '請為我的心禱告'}`;

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
    const { title, content } = req.body;
    const verses = matchBuiltInScriptures(`${title} ${content}`);
    res.json({ verses });
  }
});

app.use(express.static(__dirname, { dotfiles: 'ignore', index: 'index.html' }));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
