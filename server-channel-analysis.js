// server.js
// Бекенд для Auralis Clone:
// 1. Приймає посилання на YouTube канал
// 2. Отримує дані про канал та останні відео через YouTube Data API
// 3. Передає ці дані в AI-промпт для генерації контент-стратегії
// 4. Повертає результат фронтенду

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!YOUTUBE_API_KEY) console.warn('УВАГА: YOUTUBE_API_KEY не встановлено.');
if (!ANTHROPIC_API_KEY) console.warn('УВАГА: ANTHROPIC_API_KEY не встановлено.');

const SYSTEM_PROMPT = `Ти — AI-стратег контенту для YouTube та TikTok creators. Твоя задача —
проаналізувати патерни успішного каналу і згенерувати ОРИГІНАЛЬНИЙ
контент-план для іншого каналу з іншою нішею/брендом.

Правила:
1. НІКОЛИ не копіюй конкретні заголовки чи фрази дослівно. Аналізуй лише СТРУКТУРУ та ФОРМУЛИ.
2. Адаптуй формули під нішу та тон голосу користувача.
3. Кожна ідея має бути придатна для ніші користувача.
4. Формат відповіді — лише валідний JSON, без жодного тексту до або після, без markdown-блоків.
5. БУДЬ ЛАКОНІЧНИМ, але ЗМІСТОВНИМ: title_patterns — рівно 2 пункти, кожен до 8 слів.
   content_tone — одне речення до 10 слів. hook — одне яскраве речення до 15 слів.
   summary — 2 речення (до 40 слів) з конкретним описом що саме буде у відео,
   які ключові моменти/повороти. НЕ використовуй вкладені масиви для ідей.

Формат відповіді:
{
  "channel_formula": {
    "posting_frequency": "коротко",
    "avg_duration": "коротко",
    "title_patterns": ["патерн 1", "патерн 2"],
    "content_tone": "одне речення"
  },
  "video_ideas": [
    {
      "title": "заголовок під нішу користувача",
      "format": "короткий опис формату",
      "hook": "одне речення-хук",
      "summary": "одне речення з описом структури відео"
    }
  ]
}

Згенеруй рівно 3 ідеї у video_ideas.`;

const SCRIPT_SYSTEM_PROMPT = `Ти — AI-сценарист для YouTube та TikTok контенту. Твоя задача —
написати ПОВНИЙ детальний сценарій відео на основі короткої ідеї.

Правила:
1. Сценарій українською мовою, готовий для озвучення.
2. Враховуй формат контенту (Shorts чи Long-form) — для Shorts компактно (30-60 сек),
   для Long-form розгорнуто (5-10 хв).
3. Враховуй тон голосу каналу.
4. Структуруй по сценах з позначками "що показати на екрані".
5. Формат відповіді — лише валідний JSON, без жодного тексту до або після, без markdown-блоків.

Формат відповіді:
{
  "full_script": [
    {
      "scene": "Назва сцени",
      "voiceover": "Текст для озвучення",
      "visual": "Опис візуалу"
    }
  ],
  "estimated_duration": "приблизна тривалість",
  "tips": ["порада 1", "порада 2"]
}`;

function parseChannelInput(url) {
  url = url.trim();

  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    if (url.startsWith('@')) return { type: 'handle', value: url };
    return { type: 'handle', value: '@' + url };
  }

  try {
    const u = new URL(url);
    const path = u.pathname;

    let match = path.match(/\/channel\/([^/]+)/);
    if (match) return { type: 'id', value: match[1] };

    match = path.match(/\/(@[^/]+)/);
    if (match) return { type: 'handle', value: match[1] };

    match = path.match(/\/(?:c|user)\/([^/]+)/);
    if (match) return { type: 'handle', value: '@' + match[1] };

    return null;
  } catch (e) {
    return null;
  }
}

function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 'невідомо';
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  const totalMin = h * 60 + m + s / 60;
  return totalMin.toFixed(1) + ' хв';
}

function estimateFrequency(dates) {
  if (dates.length < 2) return 'недостатньо даних';
  const sorted = dates.map(d => new Date(d)).sort((a, b) => b - a);
  const diffs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    diffs.push((sorted[i] - sorted[i + 1]) / (1000 * 60 * 60 * 24));
  }
  const avgDays = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  if (avgDays <= 1.5) return 'щодня';
  if (avgDays <= 4) return `~${Math.round(7 / avgDays)} рази на тиждень`;
  if (avgDays <= 10) return 'раз на тиждень';
  return `приблизно раз на ${Math.round(avgDays)} днів`;
}

function formatCount(num) {
  const n = parseInt(num, 10);
  if (isNaN(n)) return num;
  if (n >= 1000000) {
    return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K';
  }
  return String(n);
}

function detectContentFormat(durationsInMin) {
  const shortsCount = durationsInMin.filter(d => d <= 1).length;
  const total = durationsInMin.length;
  const shortsRatio = shortsCount / total;

  if (shortsRatio >= 0.8) {
    return { format: 'Shorts', label: 'Канал коротких відео (Shorts)', shortsRatio };
  }
  if (shortsRatio <= 0.2) {
    return { format: 'Long-form', label: 'Канал довгих відео', shortsRatio };
  }
  return { format: 'Mixed', label: 'Змішаний формат (Shorts + довгі відео)', shortsRatio };
}


function repairTruncatedJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {}

  const videoIdeasIdx = text.indexOf('"video_ideas"');
  if (videoIdeasIdx === -1) return null;

  const arrayStart = text.indexOf('[', videoIdeasIdx);
  if (arrayStart === -1) return null;

  let depth = 0;
  let lastCompleteEnd = -1;
  let inString = false;
  let escape = false;

  for (let i = arrayStart + 1; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        lastCompleteEnd = i;
      }
    }
  }

  if (lastCompleteEnd === -1) return null;

  const truncated = text.substring(0, lastCompleteEnd + 1) + ']}';

  try {
    return JSON.parse(truncated);
  } catch (e) {
    return null;
  }
}

app.post('/analyze-channel', async (req, res) => {
  try {
    const { channelUrl, myNiche, myTone } = req.body;

    if (!channelUrl || !myNiche) {
      return res.status(400).json({ error: 'Потрібні поля channelUrl та myNiche' });
    }

    const parsed = parseChannelInput(channelUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Не вдалося розпізнати посилання на канал' });
    }

    let channelId;
    if (parsed.type === 'id') {
      channelId = parsed.value;
    } else {
      const searchUrl = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(parsed.value)}&key=${YOUTUBE_API_KEY}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();

      if (!searchData.items || searchData.items.length === 0) {
        return res.status(404).json({ error: 'Канал не знайдено за цим посиланням' });
      }
      channelId = searchData.items[0].id;
    }

    const channelInfoUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet,statistics&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const channelInfoRes = await fetch(channelInfoUrl);
    const channelInfoData = await channelInfoRes.json();

    if (!channelInfoData.items || channelInfoData.items.length === 0) {
      return res.status(404).json({ error: 'Канал не знайдено' });
    }

    const channelInfo = channelInfoData.items[0];
    const uploadsPlaylistId = channelInfo.contentDetails.relatedPlaylists.uploads;

    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=10&key=${YOUTUBE_API_KEY}`;
    const playlistRes = await fetch(playlistUrl);
    const playlistData = await playlistRes.json();

    if (!playlistData.items || playlistData.items.length === 0) {
      return res.status(404).json({ error: 'На каналі не знайдено відео' });
    }

    const videoIds = playlistData.items.map(item => item.snippet.resourceId.videoId).join(',');
    const publishDates = playlistData.items.map(item => item.snippet.publishedAt);
    const titles = playlistData.items.map(item => item.snippet.title);

    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const videosRes = await fetch(videosUrl);
    const videosData = await videosRes.json();

    const durations = videosData.items.map(item => parseDuration(item.contentDetails.duration));
    const durationsInMin = videosData.items.map(item => {
      const match = item.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (!match) return 0;
      const h = parseInt(match[1] || '0', 10);
      const m = parseInt(match[2] || '0', 10);
      const s = parseInt(match[3] || '0', 10);
      return h * 60 + m + s / 60;
    });
    const avgDurationMin = durationsInMin.reduce((a, b) => a + b, 0) / durationsInMin.length;

    const frequency = estimateFrequency(publishDates);
    const contentFormat = detectContentFormat(durationsInMin);

    const channelData = {
      title: channelInfo.snippet.title,
      subscriberCount: formatCount(channelInfo.statistics.subscriberCount) || 'приховано',
      videoCount: formatCount(channelInfo.statistics.videoCount),
      frequency,
      avgDuration: avgDurationMin.toFixed(1) + ' хв',
      sampleTitles: titles.slice(0, 5),
      contentFormat: contentFormat.label,
      contentFormatType: contentFormat.format
    };

    const userPrompt = `Канал-орієнтир:
- Назва: ${channelData.title}
- Підписники: ${channelData.subscriberCount}
- Формат: ${channelData.contentFormat}
- Частота публікацій: ${channelData.frequency}
- Середня тривалість: ${channelData.avgDuration}
- Приклади заголовків (для аналізу патернів — НЕ копіювати):
${channelData.sampleTitles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

Канал користувача:
- Ніша: ${myNiche}
- Тон голосу: ${myTone || 'нейтральний'}
- Мова: українська

Враховуй формат (${channelData.contentFormat}): якщо Shorts — компактні ідеї з швидким хуком; якщо Long-form — можна розгорнутіше. Будь лаконічним.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('Anthropic API error:', errText);
      return res.status(500).json({ error: 'Помилка генерації AI-плану' });
    }

    const aiData = await aiResponse.json();
    const text = aiData.content.map(item => item.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let plan = repairTruncatedJSON(clean);
    if (!plan) {
      console.error('Помилка парсингу AI-відповіді. Довжина:', text.length, 'Текст:', text);
      return res.status(500).json({ error: 'AI повернув некоректний формат відповіді' });
    }
    if (!plan.video_ideas || plan.video_ideas.length === 0) {
      console.error('Немає жодної повної ідеї у відповіді. Текст:', text);
      return res.status(500).json({ error: 'AI не згенерував жодної повної ідеї, спробуйте ще раз' });
    }

    res.json({
      channelInfo: channelData,
      plan
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

app.post('/generate-script', async (req, res) => {
  try {
    const { idea, contentFormat, myTone, targetDuration } = req.body;

    if (!idea || !idea.title) {
      return res.status(400).json({ error: 'Потрібні дані ідеї (idea)' });
    }

    const ideaDescription = idea.summary
      ? `Опис: ${idea.summary}`
      : (idea.outline ? `Структура:\n${(idea.outline || []).map((p, i) => `  ${i + 1}. ${p}`).join('\n')}` : '');

    let durationInstruction = '';
    if (targetDuration) {
      if (targetDuration <= 60) {
        durationInstruction = `\nЦІЛЬОВА ТРИВАЛІСТЬ: рівно ${targetDuration} секунд озвучки. Це КОРОТКЕ відео. Зроби сценарій таким, щоб начитка вкладалась рівно у ${targetDuration} секунд — не більше. Менше сцен, коротші репліки. estimated_duration = "${targetDuration} сек".`;
      } else {
        const mins = Math.round(targetDuration / 60);
        durationInstruction = `\nЦІЛЬОВА ТРИВАЛІСТЬ: приблизно ${mins} хвилин озвучки (${targetDuration} секунд). Розпиши сценарій так, щоб начитка зайняла приблизно стільки часу. estimated_duration = "${mins} хв".`;
      }
    }

    const userPrompt = `Напиши повний сценарій для цього відео:

Заголовок: ${idea.title}
Формат: ${idea.format || 'не вказано'}
Хук: ${idea.hook || 'не вказано'}
${ideaDescription}

Формат контенту каналу: ${contentFormat || 'Long-form'}
Тон голосу: ${myTone || 'нейтральний'}
Мова: українська${durationInstruction}`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: SCRIPT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('Anthropic API error:', errText);
      return res.status(500).json({ error: 'Помилка генерації сценарію' });
    }

    const aiData = await aiResponse.json();
    const text = aiData.content.map(item => item.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let script;
    try {
      script = JSON.parse(clean);
    } catch (e) {
      console.error('Помилка парсингу AI-відповіді:', text);
      return res.status(500).json({ error: 'AI повернув некоректний формат відповіді' });
    }

    res.json({ script });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
