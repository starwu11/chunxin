const crypto = require('crypto');

const DEFAULT_URL = 'https://vehiclevinquery.apistore.huaweicloud.com/vehicle/vin-query';

const config = {
  url: process.env.VEHICLE_API_URL || DEFAULT_URL,
  appKey: process.env.VEHICLE_API_APPKEY || '',
  appSecret: process.env.VEHICLE_API_SECRET || '',
  timeout: Number(process.env.VEHICLE_API_TIMEOUT || 12000),
  retries: Number(process.env.VEHICLE_API_RETRIES || 2), // 额外重试次数（共 1+N 次）

  vinParam: process.env.VEHICLE_API_VIN_PARAM || 'vin',
};

let failures = 0;
let cooldownUntil = 0;

function isConfigured() {
  return !!(config.appKey && config.appSecret);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

function encodeRFC3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildSignedHeaders(method, url, body) {
  const parsed = new URL(url);
  const sdkDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const headers = { host: parsed.host, 'x-sdk-date': sdkDate };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join('');
  const query = [...parsed.searchParams.entries()]
    .map(([k, v]) => [encodeRFC3986(k), encodeRFC3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const uri = (() => {
    let value = parsed.pathname
      .split('/')
      .map((seg) => encodeRFC3986(decodeURIComponent(seg)))
      .join('/');
    if (!value.endsWith('/')) value += '/';
    return value;
  })();
  const canonicalRequest = [
    method,
    uri,
    query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body || ''),
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', sdkDate, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', config.appSecret).update(stringToSign).digest('hex');
  return {
    'X-Sdk-Date': sdkDate,
    Authorization: `SDK-HMAC-SHA256 Access=${config.appKey}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function findField(node, names, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return '';
  for (const [key, value] of Object.entries(node)) {
    if (names.includes(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findField(value, names, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

function combineName(brand, series, model) {
  const parts = [];
  for (const raw of [brand, series, model]) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const idx = parts.findIndex((x) => x === value || x.includes(value) || value.includes(x));
    if (idx >= 0) {
      if (value.length > parts[idx].length) parts[idx] = value;
      continue;
    }
    parts.push(value);
  }
  return parts.join('').slice(0, 60);
}

function mapResponse(json) {
  const root = json && (json.data || json.result || json.body || json);
  const brand = findField(root, [
    'brandname',
    'brand_name',
    'brand',
    'make',
    'carmake',
    'vendor',
    'carbrand',
  ]);
  const series = findField(root, [
    'seriesname',
    'series_name',
    'typename',
    'series',
    'carseries',
    'factoryname',
    'carfactory',
  ]);
  const full = findField(root, ['name', 'vehiclename', 'carname', 'vehicle_name', 'car_name']);
  const model =
    findField(root, ['modelname', 'carmodel', 'model', 'trim', 'style', 'vehicletype']) || full;
  const year = findField(root, ['modelyear', 'yeartype', 'productionyear', 'year']);
  const brief = combineName(brand, series);
  const carName = (brief || full || model).slice(0, 60);
  return { brand, series, model, year, carName };
}

// 单次请求（不含重试/熔断计数）
async function lookupVINOnce(vin) {
  const url = new URL(config.url);
  url.searchParams.set(config.vinParam, vin);
  const body = '';
  // 每次重试都重新签名（签名含时间戳，旧签名可能过期）
  const headers = buildSignedHeaders('POST', url.toString(), body);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(config.timeout),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const message = (json && (json.error_msg || json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  if (!json) throw new Error('接口返回不是 JSON');
  if (json.success === false || json.error || json.error_msg) {
    throw new Error(json.error_msg || json.error || json.msg || '接口返回失败');
  }
  const code = json.code;
  if (code != null && ![0, 200, '0', '200'].includes(code)) {
    throw new Error(json.msg || json.message || `接口返回码 ${code}`);
  }
  const mapped = mapResponse(json);
  if (!mapped.carName) throw new Error('接口未返回可用车型');
  return { ...mapped, raw: json };
}

async function lookupVIN(vin) {
  if (!isConfigured()) return null;
  if (Date.now() < cooldownUntil) return null;
  let lastErr = null;
  const attempts = Math.max(1, config.retries + 1);
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await lookupVINOnce(vin);
      failures = 0;
      cooldownUntil = 0;
      if (i > 0) console.error(`[vehicle-api] 第 ${i + 1} 次尝试成功：${vin}`);
      return result;
    } catch (err) {
      lastErr = err;
      // 仅对网络/超时/5xx 类错误重试；明确的参数错误不重试
      const msg = String(err.message || '');
      const retryable = /timeout|abort|ECONN|ETIMEDOUT|socket|network|HTTP 5\d\d/i.test(msg) || /HTTP 429/.test(msg);
      if (i < attempts - 1 && retryable) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      break;
    }
  }
  failures += 1;
  if (failures >= 5) {
    cooldownUntil = Date.now() + 2 * 60 * 1000;
    failures = 0;
    console.error('[vehicle-api] 连续失败 5 次，暂停调用 2 分钟');
  }
  console.error('[vehicle-api]', vin, lastErr ? lastErr.message : '未知错误');
  return null;
}

module.exports = {
  isConfigured,
  lookupVIN,
  mapResponse,
  buildSignedHeaders,
};