const { db } = require('./db');

const KEY = 'describe_template';
const MAX_LENGTH = 10000;

const DEFAULT_TEMPLATE = `我是一个小红书贴膜行业创作者，使用以上图片进行小红书笔记撰写，和图片设计

图片文件夹：{{image_folder}}（共 {{image_count}} 张）

1、施工信息
施工项目：{{projects}}
{{brand_line}}产品型号：{{model}}

2、图片车型信息
车型：{{car_name}}
车架号：{{vin}}

3、创作方向：案例分享
4、创作要求：增加封面的点击率，引导互动，增加阅读时长，最终以客户私信为目的
5、交付要求：先读照片，对照片进行理解，然后结合图片内容和上面信息，结合小红书运营方法论，先设计思路框架，然后根据框架内容，自动设计首页及其他图片，同时生成笔记文案。
`;

const PLACEHOLDERS = [
  { key: 'projects', label: '施工项目' },
  { key: 'brands', label: '施工品牌（顿号连接）' },
  { key: 'brand_line', label: '品牌整行（无品牌时自动省略）' },
  { key: 'model', label: '产品型号' },
  { key: 'car_name', label: '车型' },
  { key: 'vin', label: '车架号（空则显示未记录）' },
  { key: 'image_folder', label: '图片文件夹路径' },
  { key: 'image_count', label: '图片数量' },
  { key: 'date', label: '日期' },
  { key: 'department', label: '部门' },
  { key: 'username', label: '上传账号' },
];

function get(key, fallback = '') {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function set(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value), Date.now());
}

function getDescribeTemplate() {
  const value = get(KEY, '');
  return value && value.trim() ? value : DEFAULT_TEMPLATE;
}

function setDescribeTemplate(template) {
  const text = String(template == null ? '' : template);
  if (!text.trim()) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(KEY);
    return DEFAULT_TEMPLATE;
  }
  if (text.length > MAX_LENGTH) {
    const err = new Error('模板内容不能超过 10000 字');
    err.status = 400;
    throw err;
  }
  set(KEY, text.replace(/\r\n/g, '\n'));
  return text.replace(/\r\n/g, '\n');
}

function renderDescribeTemplate(template, values) {
  const text = String(template == null ? '' : template).replace(/\r\n/g, '\n');
  return text.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, k)
      ? String(values[k] == null ? '' : values[k])
      : match;
  });
}

const WORKBUDDY_URL_KEY = 'workbuddy_webhook_url';

function getWorkbuddyUrl() {
  return String(get(WORKBUDDY_URL_KEY, '') || '').trim();
}

function setWorkbuddyUrl(value) {
  const url = String(value == null ? '' : value).trim();
  if (url && !/^https?:\/\/.+/i.test(url)) {
    const err = new Error('请输入正确的 http(s) 地址');
    err.status = 400;
    throw err;
  }
  set(WORKBUDDY_URL_KEY, url);
  return url;
}

module.exports = {
  KEY,
  MAX_LENGTH,
  DEFAULT_TEMPLATE,
  PLACEHOLDERS,
  get,
  set,
  getDescribeTemplate,
  setDescribeTemplate,
  renderDescribeTemplate,
  WORKBUDDY_URL_KEY,
  getWorkbuddyUrl,
  setWorkbuddyUrl,
};