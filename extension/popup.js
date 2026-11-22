/**
 * Flowboard Bridge — Popup UI
 * Polls background status every 1.5 s and renders it.
 */

let _manualDisconnect = false;
let pairing = false;
const pairForm = document.getElementById('pair-form');
const pairCode = document.getElementById('pair-code');
const pairButton = document.getElementById('btn-pair');
const pairResult = document.getElementById('pair-result');
document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

function formatTokenAge(ms) {
  if (ms === null || ms === undefined) return '暂无';
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s} 秒前更新`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前更新`;
  return `${Math.floor(s / 3600)} 小时前更新`;
}

function render(status) {
  if (!status) return;

  _manualDisconnect = status.manualDisconnect;

  // Status dot
  const dotEl = document.getElementById('status-dot');
  if (status.manualDisconnect || !status.connected) {
    dotEl.className = 'section-value dot-offline';
    dotEl.textContent = '○ 未连接';
  } else if (status.state === 'running') {
    dotEl.className = 'section-value dot-running';
    dotEl.textContent = '▶ 处理中';
  } else {
    dotEl.className = 'section-value dot-connected';
    dotEl.textContent = status.paired ? '● 已连接 · 已配对' : '● 已连接 · 未配对';
  }

  // Token
  document.getElementById('token-row').textContent =
    status.flowKeyPresent ? formatTokenAge(status.tokenAge) : '暂无';
  document.getElementById('token-row').parentElement.hidden = status.paired;
  document.getElementById('btn-refresh').hidden = status.paired;

  // Stats
  const m = status.metrics || {};
  document.getElementById('stats-row').textContent =
    `${m.requestCount || 0} · ✓ ${m.successCount || 0} · ✗ ${m.failedCount || 0}`;

  // Error
  const errSection = document.getElementById('error-section');
  const errRow     = document.getElementById('error-row');
  if (m.lastError) {
    errSection.style.display = 'flex';
    errRow.textContent = m.lastError;
  } else {
    errSection.style.display = 'none';
  }

  // Toggle button
  const btn = document.getElementById('btn-toggle');
  if (status.manualDisconnect) {
    btn.textContent = '重新连接';
    btn.className   = 'reconnect';
  } else {
    btn.textContent = '断开连接';
    btn.className   = 'disconnect';
  }
}

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (reply) => {
    if (chrome.runtime.lastError) return;
    render(reply);
  });
}

// Initial fetch + poll
fetchStatus();
setInterval(fetchStatus, 1500);

// Re-render on push from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') fetchStatus();
});

// Buttons
document.getElementById('btn-flow-tab').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' });
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
});

document.getElementById('btn-toggle').addEventListener('click', () => {
  const type = _manualDisconnect ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type }, () => {
    if (chrome.runtime.lastError) return;
    fetchStatus();
  });
});


pairForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pairing || !pairCode.value.trim()) return;
  pairing = true;
  pairButton.disabled = true;
  pairResult.dataset.error = 'false';
  pairResult.textContent = '正在配对…';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'PAIR_PROFILE', code: pairCode.value.trim() });
    if (reply?.ok) {
      pairCode.value = '';
      pairResult.textContent = '配对成功。请返回画布确认连接状态。';
    } else {
      pairResult.dataset.error = 'true';
      pairResult.textContent = reply?.error || '配对未完成，请重试。';
    }
  } catch {
    pairResult.dataset.error = 'true';
    pairResult.textContent = '配对未完成，请重新打开扩展后重试。';
  } finally {
    pairing = false;
    pairButton.disabled = false;
    fetchStatus();
  }
});
