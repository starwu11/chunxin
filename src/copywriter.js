const fs = require('fs');
const { chat, config, hasKey } = require('./zhipu');

function mimeOf(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

async function generateMomentsCopy({ carName, vin, department, type, files }) {
  if (!hasKey()) {
    return { ok: false, error: '未配置智谱 API Key，跳过文案生成' };
  }
  if (!carName) {
    return { ok: false, error: '缺少车型信息，跳过文案生成' };
  }

  const usable = files.filter((f) => !/车架号|(^|[_\-\s])vin([_\-\s.]|$)/i.test(f.name));
  if (!usable.length) {
    return { ok: false, error: '没有可用于文案的照片（车架号照片已排除）' };
  }

  const candidates = usable
    .slice()
    .sort((a, b) => a.size - b.size)
    .slice(0, 2)
    .filter((f) => f.size > 0 && f.size < 4 * 1024 * 1024);

  if (!candidates.length) {
    return { ok: false, error: '图片过大，无法生成文案' };
  }

  const content = [];
  for (const file of candidates) {
    try {
      const base64 = fs.readFileSync(file.path).toString('base64');
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mimeOf(file.name)};base64,${base64}` },
      });
    } catch {
      /* skip unreadable */
    }
  }
  if (!content.length) {
    return { ok: false, error: '图片读取失败，无法生成文案' };
  }

  const typeLabel = { ppf: '隐形车衣/改色膜', window: '窗膜', mod: '轻改装' }[type] || '汽车贴膜';
  const storeGuide = process.env.STORE_ADDRESS
    ? `到店预约：${process.env.STORE_ADDRESS}`
    : (process.env.STORE_CONTACT || '私信预约到店体验');

  content.push({
    type: 'text',
    text:
      `车型：${carName}${vin ? `（车架号 ${vin}）` : ''}。业务类型：${typeLabel}。所属门店：${department || '膜登时代'}。\n` +
      '你是「膜登时代」汽车贴膜门店的社媒运营。门店主营隐形车衣、改色膜、窗膜和轻改装，微信好友绝大多数是车主客户。\n' +
      '请根据照片内容和业务类型，生成 3 条不同风格的朋友圈种草文案，严格按以下格式输出：\n' +
      '【案例型】<文案>\n【体验型】<文案>\n【专业型】<文案>\n' +
      '要求：每条 80-120 字；突出该业务的核心卖点（车衣：车漆光泽、护漆防刮；窗膜：隔热、隐私、防爆；改装：外观气质、细节质感）；' +
      '用施工细节和用车体验制造向往感，让车主产生“我的车也想这样”的冲动；口语化，适度使用 emoji；' +
      '每条结尾带 2-3 个话题标签（如 #膜登时代 #隐形车衣 #窗膜）；' +
      `并在每条末尾附上预约引导「${storeGuide}」；\n` +
      '不出现具体价格，不夸大承诺，不分点，只输出文案正文。',
  });

  try {
    const text = await chat([{ role: 'user', content }], {
      model: config.visionModel,
      maxTokens: 8000,
      temperature: 0.8,
      timeout: 120000,
    });
    let trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: '文案生成结果为空' };
    if (storeGuide) {
      trimmed = trimmed
        .split(/(?=【(?:案例型|体验型|专业型)】)/)
        .map((part) => {
          const p = part.trim();
          if (!p) return '';
          return p.includes(storeGuide) ? p : `${p}\n${storeGuide}`;
        })
        .filter(Boolean)
        .join('\n\n');
    }
    return { ok: true, text: trimmed };
  } catch (err) {
    return { ok: false, error: String(err.body || err.message).slice(0, 120) };
  }
}

module.exports = { generateMomentsCopy };