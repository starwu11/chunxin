const { db } = require('./db');

const KEEP_MONTHS = Number(process.env.AUDIT_KEEP_MONTHS || 6);
const PAGE_SIZE = 50;

const ACTION_LABELS = {
  login: '登录',
  login_fail: '登录失败',
  sms_login: '验证码登录',
  logout: '退出登录',
  register: '注册账号',
  reset_password: '找回密码',
  change_password: '修改密码',
  bind_phone: '绑定手机号',
  upload: '上传文件',
  describe: '生成创作说明',
  delete: '删除文件',
  restore: '恢复文件',
  purge: '彻底删除',
  mkdir: '新建文件夹',
  folder_note: '编辑文件夹备注',
  rename: '重命名',
  move: '移动文件',
  copy: '复制文件',
  edit: '编辑文件',
  share: '创建分享',
  share_delete: '取消分享',
  admin_review: '审核账号',
  admin_username: '修改用户名',
  admin_phone: '修改手机号',
  admin_department: '修改部门',
  admin_access: '修改权限',
  admin_password: '重置密码',
  admin_delete_user: '删除账号',
  admin_quota: '调整容量',
  admin_template: '修改说明模板',
};

function write(userId, username, action, target, detail, ip) {
  try {
    db.prepare(
      `INSERT INTO audit_logs (user_id, username, action, target, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId == null ? null : Number(userId),
      String(username || ''),
      String(action || ''),
      String(target || '').slice(0, 300),
      String(detail || '').slice(0, 300),
      String(ip || '').slice(0, 60),
      Date.now()
    );
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

function add(user, action, target, detail, ip) {
  write(user ? user.id : null, user ? user.username : '', action, target, detail, ip);
}

function addRaw(username, action, target, detail, ip, userId) {
  write(userId, username, action, target, detail, ip);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded ? String(forwarded).split(',')[0].trim() : '';
  return raw || String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function toStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function toEnd(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() + 24 * 3600 * 1000 - 1;
}

function query(opts = {}) {
  const where = [];
  const params = [];
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.from || '')) ? toStart(opts.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.to || '')) ? toEnd(opts.to) : null;
  if (from != null) {
    where.push('created_at >= ?');
    params.push(from);
  }
  if (to != null) {
    where.push('created_at <= ?');
    params.push(to);
  }
  if (opts.action) {
    where.push('action = ?');
    params.push(String(opts.action));
  }
  if (opts.username) {
    where.push('username LIKE ?');
    params.push('%' + String(opts.username).slice(0, 40) + '%');
  }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_logs' + clause).get(...params).c;
  const pageSize = Math.min(200, Math.max(10, Number(opts.pageSize) || PAGE_SIZE));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(opts.page) || 1));
  const rows = db
    .prepare('SELECT * FROM audit_logs' + clause + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      actionLabel: ACTION_LABELS[r.action] || r.action,
      target: r.target,
      detail: r.detail,
      ip: r.ip,
      createdAt: r.created_at,
    })),
    total,
    page,
    pageSize,
    pages,
    keepMonths: KEEP_MONTHS,
    actions: Object.keys(ACTION_LABELS).map((key) => ({ key, label: ACTION_LABELS[key] })),
  };
}

function cleanup() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);
  const info = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff.getTime());
  const removed = Number(info.changes || 0);
  if (removed) console.log(`[audit] 已清理 ${removed} 条过期日志`);
  return removed;
}

module.exports = {
  KEEP_MONTHS,
  ACTION_LABELS,
  add,
  addRaw,
  clientIp,
  query,
  cleanup,
};