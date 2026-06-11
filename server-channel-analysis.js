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

// Зберігайте ключі у змінних середовища, не в коді.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!YOUTUBE_API_KEY) console.warn('УВАГА: YOUTUBE_API_KEY не встановлено.');
if (!ANTHROPIC_API_KEY) console.warn('УВАГА: ANTHROPIC_API_KEY не встановлено.');

const SYSTEM_PROMPT = `Ти — AI-стратег контенту для YouTube та TikTok creators. Твоя задача —
проаналізувати патерни успішного каналу (теми, формат заголовків, тон,
структуру відео) і на основі цих патернів згенерувати ОРИГІНАЛЬНИЙ
контент-план для іншого каналу з іншою нішею/брендом.

Правила:
1. НІКОЛИ не копіюй конкретні заголовки, сценарії чи фрази з каналу-орієнтира
   дослівно. Аналізуй лише СТРУКТУРУ та ФОРМУЛИ (наприклад: "заголовок у форматі
   'Я зробив X за Y днів'", "відео починається з особистої історії, потім дає
   3 практичні поради").
2. Адаптуй знайдені формули під нішу та тон голосу користувача, які він вказав.
3. Кожна ідея має бути придатна для каналу користувача — не пропонуй теми поза
   його нішею.
4. Формат відповіді — лише валідний JSON, без жодного тексту до або після.

Очікуваний формат відповіді:
{
  "channel_formula": {
    "posting_frequency": "опис частоти публікацій на основі вхідних даних",
    "avg_duration": "приблизна тривалість відео",
    "title_patterns": ["опис патерну заголовків 1", "опис патерну 2"],
    "content_tone": "опис тону/стилю подачі"
  },
  "video_ideas": [
    {
      "title": "Заголовок відео під нішу користувача",
      "format": "короткий опис формату (наприклад: сторітелінг + поради)",
      "hook": "перші 1-2 речення сценарію (хук)",
      "outline": ["пункт сценарію 1", "пункт сценарію 2", "пункт сценарію 3"]
    }
  ]
}

Згенеруй рівно 5 ідей у масиві video_ideas.`;

const SCRIPT_SYSTEM_PROMPT = `Ти — AI-сценарист для YouTube та TikTok контенту. Твоя задача —
написати ПОВНИЙ детальний сценарій відео на основі короткої ідеї (заголовок, формат, хук, нарис структури).

Правила:
1. Сценарій має бути написаний українською мовою, готовий для озвучення.
2. Враховуй формат контенту (Shorts чи Long-form) — для Shorts сценарій компактний (30-60 секунд озвучки),
   для Long-form — розгорнутий (5-10 хвилин озвучки), з більш детальними блоками.
3. Враховуй тон голосу каналу користувача.
4. Структуруй сценарій по сценах/блоках з позначками "куди дивитись камера" / "що показати на екрані"
   (наприклад: "[На екрані: текст заголовку]", "[Кадр: автор дивиться в камеру]").
5. Формат відповіді — лише валідний JSON, без жодного тексту до або після.

Очікуваний формат відповіді:
{
  "full_script": [
    {
      "scene": "Назва сцени/блоку (наприклад: 'Хук', 'Основна частина 1', 'Висновок')",
      "voiceover": "Текст для озвучення цієї сцени",
      "visual": "Опис того, що показати на екрані / куди дивитись камера"
    }
  ],
  "estimated_duration": "приблизна тривалість готового відео",
  "tips": ["порада щодо зйомки/монтажу 1", "порада 2"]
}`;

// --- Допоміжні функції ---

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

// --- Основний ендпоінт ---

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

    const userPrompt = `Дані про канал-орієнтир (отримано автоматично з YouTube Data API):
- Назва каналу: ${channelData.title}
- Кількість підписників: ${channelData.subscriberCount}
- Загальна кількість відео: ${channelData.videoCount}
- Формат контенту: ${channelData.contentFormat}
- Частота публікацій (оцінка за останніми відео): ${channelData.frequency}
- Середня тривалість відео: ${channelData.avgDuration}
- Приклади заголовків останніх відео (для аналізу патернів — НЕ копіювати):
${channelData.sampleTitles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}

Дані про канал користувача:
- Ніша: ${myNiche}
- Тон голосу: ${myTone || 'нейтральний'}
- Мова контенту: українська

Враховуй формат контенту (${channelData.contentFormat}) при генерації ідей: якщо це Shorts — ідеї мають бути компактні, з швидким хуком у перші 1-2 секунди; якщо Long-form — ідеї можуть мати розгорнуту структуру.`;

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

    let plan;
    try {
      plan = JSON.parse(clean);
    } catch (e) {
      console.error('Помилка парсингу AI-відповіді:', text);
      return res.status(500).json({ error: 'AI повернув некоректний формат відповіді' });
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

// --- Ендпоінт для генерації повного сценарію під конкретну ідею ---

app.post('/generate-script', async (req, res) => {
  try {
    const { idea, contentFormat, myTone } = req.body;

    if (!idea || !idea.title) {
      return res.status(400).json({ error: 'Потрібні дані ідеї (idea)' });
    }

    const userPrompt = `Напиши повний сценарій для цього відео:

Заголовок: ${idea.title}
Формат: ${idea.format || 'не вказано'}
Хук: ${idea.hook || 'не вказано'}
Нарис структури:
${(idea.outline || []).map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

Формат контенту каналу: ${contentFormat || 'Long-form'}
Тон голосу: ${myTone || 'нейтральний'}
Мова: українська`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
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
