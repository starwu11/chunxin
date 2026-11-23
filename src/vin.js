const fs = require('fs');
const { chat, parseJson, hasKey, config } = require('./zhipu');
const imagefx = require('./imagefx');
const { db } = require('./db');
const vehicleApi = require('./vehicle-api');

const VIN_CACHE_TTL = 30 * 24 * 3600 * 1000;

const WMI_BRANDS = {
  LSV: '大众',
  LSV: '大众',
  LGB: '日产',
  LFM: '丰田',
  LTV: '丰田',
  LFV: '大众',
  LDC: '比亚迪',
  LGX: '比亚迪',
  L6T: '吉利',
  LB3: '吉利',
  LVS: '福特',
  LVR: '本田',
  LHG: '本田',
  LJD: '起亚',
  LBE: '现代',
  LSG: '雪佛兰',
  LSJ: '别克',
  LSC: '别克',
  LYW: '宝马',
  LBV: '宝马',
  LMB: '奥迪',
  LFU: '奥迪',
  LNP: '奔驰',
  LEA: '奔驰',
  WDD: '奔驰',
  WBA: '宝马',
  WAU: '奥迪',
  WVW: '大众',
  JHM: '本田',
  JT2: '丰田',
  KMH: '现代',
  KNA: '起亚',
};

function normalizeVIN(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-HJ-NPR-Z0-9]/g, '');
}

function isValidVIN(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalizeVIN(vin));
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

function mimeOfFile(file) {
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_CODE = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4,
  N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

function checkDigitOk(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    const v = /\d/.test(c) ? Number(c) : VIN_CODE[c];
    if (v === undefined) return false;
    sum += v * VIN_WEIGHTS[i];
  }
  const rem = sum % 11;
  return vin[8] === (rem === 10 ? 'X' : String(rem));
}

function extractVINCandidates(text) {
  const compact = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const matches = compact.match(/[A-Z0-9]{17}/g) || [];
  const out = [];
  for (const m of matches) {
    const fixed = m.replace(/I/g, '1').replace(/O/g, '0').replace(/Q/g, '0');
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(fixed)) out.push(fixed);
  }
  return out;
}

const OCR_PROMPTS = [
  '识别图片中的车辆车架号 VIN。VIN 为 17 位，只含数字 0-9 和大写字母，且不含 I、O、Q。' +
    '请逐字符读取，注意区分 0/O、1/I、5/S、2/Z、8/B、6/G。只输出 17 位 VIN，' +
    '不要空格和解释；没有清晰 VIN 时输出“无”。',
  '这是一张车架号照片。请确认每个字符后，只输出图片中完整的 17 位 VIN' +
    '（数字和大写字母，不含 I/O/Q）。不要输出其他内容；无法识别时输出“无”。',
];

async function recognizeVINFromImage(file, options = {}) {
  if (!hasKey()) {
    const err = new Error('未配置智谱 API Key，无法识别车架号照片');
    err.status = 400;
    throw err;
  }
  let enhanced;
  try {
    enhanced = imagefx.enhanceForOCR(file.path);
  } catch (e) {
    const err = new Error('车架号图片无法解码，请重新拍摄');
    err.status = 400;
    throw err;
  }
  const counts = new Map();
  const texts = [];
  let lastError = null;
  const prompts = options.fast ? OCR_PROMPTS.slice(0, 1) : OCR_PROMPTS;
  for (const prompt of prompts) {
    try {
      const text = await chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${enhanced.mime};base64,${enhanced.base64}` },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
        { model: config.visionModel, maxTokens: 1500, temperature: 0.0, timeout: options.timeout }
      );
      texts.push(text);
      for (const c of extractVINCandidates(text)) {
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    } catch (e) {
      lastError = e;
    }
  }
  if (!counts.size) {
    return {
      vin: '',
      confidence: 'low',
      checkDigitOk: false,
      candidates: [],
      raw: texts.join(' | ').slice(0, 160),
      error: lastError ? String(lastError.body || lastError.message).slice(0, 100) : '',
    };
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const checked = sorted.find(([v]) => checkDigitOk(v));
  const best = checked ? checked[0] : sorted[0][0];
  const freq = counts.get(best);
  const check = checkDigitOk(best);
  const confidence = freq >= 2 && check ? 'high' : check ? 'medium' : 'low';
  return {
    vin: best,
    confidence,
    checkDigitOk: check,
    candidates: sorted.slice(0, 5).map(([vin, count]) => ({ vin, count, checkDigitOk: checkDigitOk(vin) })),
    raw: texts.join(' | ').slice(0, 160),
  };
}

function brandFromWMI(vin) {
  const v = normalizeVIN(vin);
  return WMI_BRANDS[v.slice(0, 3)] || '';
}

function getCachedVIN(vin) {
  try {
    const row = db.prepare('SELECT * FROM vin_cache WHERE vin = ?').get(vin);
    if (!row) return null;
    if (Date.now() - row.created_at > VIN_CACHE_TTL) return null;
    if (!row.car_name) return null;
    return {
      vin,
      brand: row.brand || '',
      series: row.series || '',
      model: row.model || '',
      year: row.year || '',
      carName: row.car_name,
      method: row.source || 'cache',
    };
  } catch {
    return null;
  }
}

function saveCachedVIN(vin, data, source) {
  try {
    db.prepare(
      `INSERT INTO vin_cache (vin, brand, series, model, car_name, year, source, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vin) DO UPDATE SET
         brand = excluded.brand,
         series = excluded.series,
         model = excluded.model,
         car_name = excluded.car_name,
         year = excluded.year,
         source = excluded.source,
         raw = excluded.raw,
         created_at = excluded.created_at`
    ).run(
      vin,
      data.brand || '',
      data.series || '',
      data.model || '',
      data.carName || '',
      data.year || '',
      source,
      data.raw ? JSON.stringify(data.raw).slice(0, 4000) : '',
      Date.now()
    );
  } catch (err) {
    console.error('[vin-cache]', err.message);
  }
}

async function decodeVIN(input) {
  const vin = normalizeVIN(input);
  if (!isValidVIN(vin)) {
    const err = new Error('车架号格式不正确：必须为 17 位字符，且不含 I、O、Q');
    err.status = 400;
    throw err;
  }

  const cached = getCachedVIN(vin);
  if (cached) return cached;

  const api = await vehicleApi.lookupVIN(vin);
  if (api && api.carName) {
    saveCachedVIN(vin, api, 'api');
    return {
      vin,
      brand: api.brand || '',
      series: api.series || '',
      model: api.model || '',
      year: api.year || '',
      carName: api.carName,
      method: 'api',
    };
  }

  const fallbackBrand = brandFromWMI(vin);
  if (!hasKey()) {
    return {
      vin,
      brand: fallbackBrand,
      model: '',
      carName: fallbackBrand ? `${fallbackBrand}${vin.slice(-6)}` : `VIN${vin.slice(-6)}`,
      method: 'wmi',
      note: '未配置智谱 API Key，仅按 VIN 前缀识别品牌',
    };
  }

  try {
    const text = await chat(
      [
        {
          role: 'system',
          content:
            '你是车辆 VIN 解码助手。根据 17 位车架号判断车辆品牌和车型，只输出 JSON，不要解释。',
        },
        {
          role: 'user',
          content:
            `车架号 VIN：${vin}\n` +
            '请返回 JSON：{"brand":"品牌中文名","model":"车型名称"}。' +
            '无法确定时对应字段填空字符串，不要编造。',
        },
      ],
      { model: config.textModel, maxTokens: 3000, temperature: 0.1 }
    );
    const parsed = parseJson(text) || {};
    const brand = String(parsed.brand || '').trim();
    const model = String(parsed.model || '').trim();
    const carName = combineName(brand, model);
    if (carName) {
      const result = { vin, brand, model, carName, method: 'model' };
      saveCachedVIN(vin, result, 'model');
      return result;
    }
  } catch {
    /* 回退到 WMI */
  }

  return {
    vin,
    brand: fallbackBrand,
    model: '',
    carName: fallbackBrand ? `${fallbackBrand}${vin.slice(-6)}` : `VIN${vin.slice(-6)}`,
    method: 'wmi',
    note: '模型未返回有效品牌车型，已按 VIN 命名',
  };
}

module.exports = { decodeVIN, recognizeVINFromImage, isValidVIN, normalizeVIN, combineName, brandFromWMI };