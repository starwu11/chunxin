const form = document.getElementById('authForm');
const tabs = document.querySelectorAll('.tab');
const ink = document.querySelector('.tab-ink');
const errorBox = document.getElementById('errorBox');
const submitBtn = document.getElementById('submitBtn');
const hintText = document.getElementById('hintText');
const passwordInput = document.getElementById('password');
const authTabs = document.getElementById('authTabs');
const waySwitch = document.getElementById('waySwitch');
const wayBtns = document.querySelectorAll('.way');
const sendBtn = document.getElementById('sendCode');

const $ = (id) => document.getElementById(id);

let mode = 'login';
let way = 'password';
let timer = null;

function showError(msg) {
  errorBox.classList.remove('success');
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}
function showSuccess(msg) {
  errorBox.classList.remove('success');
  errorBox.classList.add('success', 'show');
  errorBox.textContent = msg;
}
function hideError() {
  errorBox.classList.remove('show', 'success');
}

function bindSwitch() {
  const link = $('switchLink');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (mode === 'reset') setMode('login');
      else setMode(mode === 'login' ? 'register' : 'login');
    });
  }
}

function syncUI() {
  const isLogin = mode === 'login';
  const isRegister = mode === 'register';
  const isReset = mode === 'reset';
  const isBind = mode === 'bind';
  const codeMode = (isLogin && way === 'code') || isReset;

  authTabs.hidden = isReset || isBind;
  waySwitch.hidden = !isLogin;
  $('loginExtra').hidden = !isLogin;
  wayBtns.forEach((b) => b.classList.toggle('active', b.dataset.way === way));
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  ink.classList.toggle('right', isRegister);

  $('usernameField').hidden = isReset || isBind || (isLogin && way === 'code');
  $('passwordField').hidden = isReset || isBind || (isLogin && way === 'code');
  const nameInput = $('username');
  if (nameInput) {
    nameInput.placeholder = isRegister ? '请输入用户名' : '请输入用户名或手机号';
  }
  const nameLabel = $('usernameField .label');
  if (nameLabel) {
    nameLabel.textContent = isRegister ? '用户名' : '用户名 / 手机号';
  }
  $('phoneField').hidden = !(isRegister || isReset || isBind || (isLogin && way === 'code'));
  $('codeField').hidden = !codeMode;
  $('newPasswordField').hidden = !isReset;
  $('deptField').hidden = !isRegister;
  $('rememberField').hidden = !isLogin;

  submitBtn.textContent = isBind ? '绑定并登录' : isReset ? '重置密码' : isRegister ? '注 册' : '登 录';
  passwordInput.autocomplete = isLogin ? 'current-password' : 'new-password';

  hintText.innerHTML = isBind
    ? '首次登录需要补填手机号，补填后才能继续使用'
    : isReset
    ? '想起密码了？<a href="#" id="switchLink">返回登录</a>'
    : isRegister
    ? '已有账号？<a href="#" id="switchLink">返回登录</a>'
    : '还没有账号？<a href="#" id="switchLink">立即注册</a>';
  bindSwitch();
  hideError();
}

function setMode(next) {
  mode = next;
  if (next !== 'login') way = 'password';
  syncUI();
}

tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.tab)));
wayBtns.forEach((b) =>
  b.addEventListener('click', () => {
    way = b.dataset.way;
    syncUI();
  })
);
$('forgotLink').addEventListener('click', (e) => {
  e.preventDefault();
  setMode('reset');
});
sendBtn.addEventListener('click', sendSmsCode);

async function sendSmsCode() {
  const phone = $('phone').value.trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return showError('请输入正确的 11 位手机号');
  const purpose = mode === 'reset' ? 'reset' : mode === 'bind' ? 'bind' : 'login';
  sendBtn.disabled = true;
  sendBtn.textContent = '发送中…';
  try {
    const res = await fetch('/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, purpose }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '验证码发送失败');
    showSuccess(data.debug ? '验证码已生成（调试模式：请查看服务器日志）' : '验证码已发送，5 分钟内有效');
    let left = Number(data.resendAfter) || 60;
    sendBtn.textContent = `${left} 秒`;
    clearInterval(timer);
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        sendBtn.disabled = false;
        sendBtn.textContent = '重新获取';
      } else {
        sendBtn.textContent = `${left} 秒`;
      }
    }, 1000);
  } catch (err) {
    showError(err.message || '验证码发送失败');
    sendBtn.disabled = false;
    sendBtn.textContent = '获取验证码';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const username = $('username').value.trim();
  const password = $('password').value;
  const department = $('department').value;
  const phone = $('phone').value.trim();
  const code = $('code').value.trim();
  const newPassword = $('newPassword').value;

  let url = '';
  let payload = null;
  if (mode === 'login' && way === 'password') {
    if (!username || !password) return showError('请填写用户名和密码');
    url = '/api/login';
    payload = { username, password, remember: $('remember').checked };
  } else if (mode === 'login' && way === 'code') {
    if (!/^1[3-9]\d{9}$/.test(phone)) return showError('请输入正确的 11 位手机号');
    if (!/^\d{6}$/.test(code)) return showError('请输入 6 位验证码');
    url = '/api/sms/login';
    payload = { phone, code, remember: $('remember').checked };
  } else if (mode === 'register') {
    if (!username || !password) return showError('请填写用户名和密码');
    if (password.length < 6) return showError('密码至少需要 6 位字符');
    if (!department) return showError('请选择所属部门');
    if (!/^1[3-9]\d{9}$/.test(phone)) return showError('请输入正确的 11 位手机号');
    url = '/api/register';
    payload = { username, password, department, phone };
  } else if (mode === 'bind') {
    if (!/^1[3-9]\d{9}$/.test(phone)) return showError('请输入正确的 11 位手机号');
    url = '/api/account/bind-phone';
    payload = { phone };
  } else {
    if (!/^1[3-9]\d{9}$/.test(phone)) return showError('请输入正确的 11 位手机号');
    if (!/^\d{6}$/.test(code)) return showError('请输入 6 位验证码');
    if (newPassword.length < 6) return showError('新密码至少需要 6 位字符');
    url = '/api/sms/reset';
    payload = { phone, code, password: newPassword };
  }

  submitBtn.disabled = true;
  const busy = { login: '登录中…', register: '注册中…', reset: '提交中…', bind: '绑定中…' }[mode];
  submitBtn.textContent = busy;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '操作失败，请稍后重试');

    if (data.pending) {
      setMode('login');
      showSuccess(data.message || '注册成功，请等待管理员审核通过后再登录');
      submitBtn.disabled = false;
      submitBtn.textContent = '登 录';
      return;
    }
    if (data.needPhone) {
      setMode('bind');
      showSuccess('登录成功，请补充手机号后继续');
      submitBtn.disabled = false;
      submitBtn.textContent = '绑定并登录';
      return;
    }
    if (mode === 'reset') {
      setMode('login');
      showSuccess('密码已重置，请使用新密码登录');
      submitBtn.disabled = false;
      submitBtn.textContent = '登 录';
      return;
    }
    location.href = '/';
  } catch (err) {
    showError(err.message || '网络异常，请稍后重试');
    submitBtn.disabled = false;
    submitBtn.textContent =
      mode === 'reset' ? '重置密码' : mode === 'register' ? '注 册' : mode === 'bind' ? '绑定并登录' : '登 录';
  }
});

syncUI();

fetch('/api/me')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (data && data.user) {
      if (data.needPhone) {
        setMode('bind');
        showSuccess('请先补充手机号');
      } else {
        location.href = '/';
      }
    }
  })
  .catch(() => {});