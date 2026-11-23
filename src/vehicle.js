const fs = require('fs');

const KEYWORDS = (process.env.CAR_HEAD_KEYWORDS || '车头,前脸,汽车前部,车头照,front')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const VISION = {
  url: process.env.VISION_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  key: process.env.VISION_API_KEY || '',
  model: process.env.VISION_MODEL || 'glm-4v-flash',
  timeout: Number(process.env.VISION_TIMEOUT_MS || 20000),
};

const PROMPT =
  '识别这张汽车照片。只返回一个 JSON，不要解释、不要代码块：' +
  '{"isCarHead": true 或 false, "brand": "汽车品牌中文名", "model": "车型名称"}。' +
  'isCarHead 表示画面是否清晰展示车头正面（前脸、前保险杠、大灯、车牌区域）。' +
  '无法确定时对应字段填空字符串。';

function matchKeyword(text) {
  const t = String(text || '').toLowerCase();
  return KEYWORDS.some((k) => t.includes(k.toLowerCase()));
}

function mimeOfFile(file) {
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function parseModelJson(text) {
  const s = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function askVision(file) {
  const base64 = fs.readFileSync(file.path).toString('base64');
  const body = {
    model: VISION.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeOfFile(file)};base64,${base64}` },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 120,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION.timeout);
  try {
    const res = await fetch(VISION.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VISION.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`视觉识别接口返回 ${res.status}`);
      err.body = text.slice(0, 200);
      throw err;
    }
    const data = await res.json();
    const content =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const text = Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
      : String(content);
    const parsed = parseModelJson(text) || {};
    const yes =
      toBool(parsed.isCarHead) || (!parsed.isCarHead && /是/.test(text) && !/否/.test(text));
    return {
      yes,
      brand: String(parsed.brand || '').trim(),
      model: String(parsed.model || '').trim(),
      raw: text.slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function visionCheck(file) {
  if (!VISION.key) throw new Error('未配置视觉识别服务');
  return askVision(file);
}

function combineName(brand, model) {
  const b = String(brand || '').trim();
  const m = String(model || '').trim();
  if (!b && !m) return '';
  if (!b) return m;
  if (!m) return b;
  if (m.startsWith(b) || (b.length >= 2 && m.includes(b.slice(0, 2)))) return m;
  return `${b}${m}`;
}

async function scanByVision(files) {
  for (let i = 0; i < files.length; i += 3) {
    const group = files.slice(i, i + 3);
    const results = await Promise.all(
      group.map((file) =>
        askVision(file).then((r) => ({ file, ...r }))
      )
    );
    const hit = results.find((r) => r.yes);
    if (hit) return hit;
  }
  return null;
}

async function detectCarHead(files) {
  if (!VISION.key) {
    return {
      ok: false,
      method: 'none',
      message: '未配置车头自动识别服务，请在上传列表中勾选一张「车头」照片',
    };
  }

  const preferred = files.find((f) => matchKeyword(f.name));
  if (preferred) {
    try {
      const r = await askVision(preferred);
      const carName = combineName(r.brand, r.model);
      if (carName) {
        return {
          ok: true,
          method: 'vision',
          matched: preferred.name,
          brand: r.brand,
          model: r.model,
          carName,
        };
      }
    } catch {
      /* 继续扫描其他图片 */
    }
  }

  try {
    const hit = await scanByVision(files);
    if (!hit) {
      return {
        ok: false,
        method: 'vision',
        message: '未检测到车头照片，请确认 9 张图片中包含清晰的汽车车头，或直接勾选车头照片',
      };
    }
    const carName = combineName(hit.brand, hit.model);
    if (!carName) {
      return {
        ok: false,
        method: 'vision',
        matched: hit.file.name,
        message: '已识别到车头，但无法确定车辆品牌和车型，本批上传失败',
      };
    }
    return {
      ok: true,
      method: 'vision',
      matched: hit.file.name,
      brand: hit.brand,
      model: hit.model,
      carName,
    };
  } catch (err) {
    return {
      ok: false,
      method: 'vision',
      message: `车头识别服务调用失败（${String(err.body || err.message).slice(0, 80)}），请稍后重试或勾选车头照片`,
    };
  }
}

module.exports = { detectCarHead, matchKeyword, KEYWORDS, VISION, visionCheck, combineName };