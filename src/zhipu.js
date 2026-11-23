const DEFAULT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const config = {
  url: process.env.VISION_API_URL || DEFAULT_URL,
  key: process.env.VISION_API_KEY || '',
  visionModel: process.env.VISION_MODEL || 'glm-4v-flash',
  textModel: process.env.VIN_MODEL || 'glm-4-flash',
  timeout: Number(process.env.VISION_TIMEOUT_MS || 20000),
};

function hasKey() {
  return !!config.key;
}

function parseJson(text) {
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

async function chat(messages, opts = {}) {
  if (!config.key) throw new Error('未配置智谱 API Key');
  const model = opts.model || config.visionModel;
  const body = {
    model,
    messages,
    temperature: opts.temperature == null ? 0.2 : opts.temperature,
    max_tokens: opts.maxTokens || 160,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || config.timeout);
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`智谱接口返回 ${res.status}`);
      err.body = text.slice(0, 200);
      throw err;
    }
    const data = await res.json();
    const content =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
      : String(content);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, parseJson, config, hasKey };