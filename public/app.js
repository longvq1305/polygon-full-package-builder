const elements = {
  alert: document.querySelector('#alert'),
  credentialsPanel: document.querySelector('#credentials-panel'),
  credentialsForm: document.querySelector('#credentials-form'),
  apiKey: document.querySelector('#api-key'),
  secretKey: document.querySelector('#secret-key'),
  toggleSecret: document.querySelector('#toggle-secret'),
  connectButton: document.querySelector('#connect-button'),
  rememberCredentials: document.querySelector('#remember-credentials'),
  savedCredentialsActions: document.querySelector('#saved-credentials-actions'),
  useSavedCredentials: document.querySelector('#use-saved-credentials'),
  forgetSavedCredentials: document.querySelector('#forget-saved-credentials'),
  problemsPanel: document.querySelector('#problems-panel'),
  problemSummary: document.querySelector('#problem-summary'),
  problemFilter: document.querySelector('#problem-filter'),
  problemsBody: document.querySelector('#problems-body'),
  emptyFilter: document.querySelector('#empty-filter'),
  selectAll: document.querySelector('#select-all'),
  clearAll: document.querySelector('#clear-all'),
  reconnectButton: document.querySelector('#reconnect-button'),
  concurrency: document.querySelector('#concurrency'),
  verify: document.querySelector('#verify'),
  selectedCount: document.querySelector('#selected-count'),
  buildButton: document.querySelector('#build-button'),
  progressPanel: document.querySelector('#progress-panel'),
  jobTitle: document.querySelector('#job-title'),
  jobSummary: document.querySelector('#job-summary'),
  cancelButton: document.querySelector('#cancel-button'),
  progressBar: document.querySelector('#progress-bar'),
  statTotal: document.querySelector('#stat-total'),
  statReady: document.querySelector('#stat-ready'),
  statRunning: document.querySelector('#stat-running'),
  statFailed: document.querySelector('#stat-failed'),
  progressBody: document.querySelector('#progress-body'),
  finishedActions: document.querySelector('#finished-actions'),
  newJobButton: document.querySelector('#new-job-button'),
};

const state = {
  sessionId: null,
  problems: [],
  selected: new Set(),
  jobId: null,
  pollTimer: null,
  credentialsSaved: false,
};

const terminalJobStates = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setAlert(message, type = 'error') {
  elements.alert.textContent = message;
  elements.alert.className = `alert${type === 'success' ? ' success' : ''}`;
  elements.alert.hidden = !message;
  if (message) elements.alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setButtonLoading(button, loading, label) {
  button.disabled = loading;
  if (!button.dataset.original) button.dataset.original = button.innerHTML;
  button.innerHTML = loading ? label : button.dataset.original;
}

function renderProblems() {
  const filter = elements.problemFilter.value.trim().toLocaleLowerCase('vi');
  const visible = state.problems.filter((problem) => {
    return !filter || problem.name.toLocaleLowerCase('vi').includes(filter) || String(problem.id).includes(filter);
  });

  elements.problemsBody.innerHTML = visible.map((problem) => {
    const status = problem.modified
      ? '<span class="status-pill modified">Chưa commit</span>'
      : '<span class="status-pill ready">Sẵn sàng</span>';
    const latestPackage = problem.latestPackage ?? '—';
    return `
      <tr data-problem-row="${escapeHtml(problem.id)}">
        <td class="checkbox-cell">
          <input type="checkbox" data-problem-id="${escapeHtml(problem.id)}" ${state.selected.has(String(problem.id)) ? 'checked' : ''} ${problem.modified ? 'disabled' : ''} aria-label="Chọn ${escapeHtml(problem.name)}">
        </td>
        <td><span class="problem-name">${escapeHtml(problem.name)}</span><span class="problem-id">ID ${escapeHtml(problem.id)} · ${escapeHtml(problem.owner)}</span></td>
        <td>${escapeHtml(problem.revision ?? '—')}</td>
        <td>${escapeHtml(latestPackage)}</td>
        <td>${status}</td>
      </tr>`;
  }).join('');

  elements.emptyFilter.hidden = visible.length > 0;
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = state.selected.size;
  elements.selectedCount.textContent = `${count} problem đã chọn`;
  elements.buildButton.disabled = count === 0;
}

function updateSavedCredentialUi(saved) {
  state.credentialsSaved = Boolean(saved);
  elements.savedCredentialsActions.hidden = !state.credentialsSaved;
}

function resetToCredentials({ closeSession = true } = {}) {
  clearTimeout(state.pollTimer);
  if (closeSession && state.sessionId) {
    void fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}`, { method: 'DELETE' });
  }
  state.sessionId = null;
  state.problems = [];
  state.selected.clear();
  state.jobId = null;
  elements.secretKey.value = '';
  elements.credentialsPanel.hidden = false;
  elements.problemsPanel.hidden = true;
  elements.progressPanel.hidden = true;
  updateSavedCredentialUi(state.credentialsSaved);
  setAlert('');
}

function applySessionResult(result) {
  state.sessionId = result.sessionId;
  state.problems = result.problems;
  state.selected = new Set(result.problems.filter((problem) => !problem.modified).map((problem) => String(problem.id)));
  updateSavedCredentialUi(result.credentialsSaved);
  elements.apiKey.value = '';
  elements.secretKey.value = '';
  const modifiedCount = result.problems.filter((problem) => problem.modified).length;
  elements.problemSummary.textContent = result.problems.length
    ? `Tìm thấy ${result.problems.length} problem bạn sở hữu. Đã chọn ${result.problems.length - modifiedCount} problem sẵn sàng${modifiedCount ? `; ${modifiedCount} problem chưa commit được bỏ qua.` : '.'}`
    : 'Không tìm thấy problem nào có quyền OWNER.';
  elements.credentialsPanel.hidden = true;
  elements.problemsPanel.hidden = false;
  elements.progressPanel.hidden = true;
  renderProblems();
}

async function connectWithSavedCredentials({ automatic = false } = {}) {
  setAlert('');
  setButtonLoading(elements.useSavedCredentials, true, 'Đang kết nối…');
  try {
    const result = await api('/api/sessions/saved', { method: 'POST' });
    applySessionResult(result);
    if (!automatic) elements.problemsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setAlert(`Không dùng được khóa đã lưu: ${error.message}`);
  } finally {
    setButtonLoading(elements.useSavedCredentials, false);
  }
}

elements.toggleSecret.addEventListener('click', () => {
  const isPassword = elements.secretKey.type === 'password';
  elements.secretKey.type = isPassword ? 'text' : 'password';
  elements.toggleSecret.textContent = isPassword ? 'Ẩn' : 'Hiện';
  elements.toggleSecret.setAttribute('aria-label', isPassword ? 'Ẩn secret key' : 'Hiện secret key');
});

elements.credentialsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setAlert('');
  setButtonLoading(elements.connectButton, true, 'Đang kết nối…');
  try {
    const result = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: elements.apiKey.value,
        secretKey: elements.secretKey.value,
        remember: elements.rememberCredentials.checked,
      }),
    });
    applySessionResult(result);
    elements.problemsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setAlert(error.message);
  } finally {
    setButtonLoading(elements.connectButton, false);
  }
});

elements.problemFilter.addEventListener('input', renderProblems);
elements.problemsBody.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-problem-id]');
  if (!checkbox) return;
  if (checkbox.checked) state.selected.add(checkbox.dataset.problemId);
  else state.selected.delete(checkbox.dataset.problemId);
  updateSelectedCount();
});

elements.selectAll.addEventListener('click', () => {
  for (const problem of state.problems) {
    if (!problem.modified) state.selected.add(String(problem.id));
  }
  renderProblems();
});
elements.clearAll.addEventListener('click', () => {
  state.selected.clear();
  renderProblems();
});
elements.reconnectButton.addEventListener('click', resetToCredentials);
elements.useSavedCredentials.addEventListener('click', () => connectWithSavedCredentials());
elements.forgetSavedCredentials.addEventListener('click', async () => {
  try {
    await api('/api/credentials', { method: 'DELETE' });
    updateSavedCredentialUi(false);
    setAlert('Đã xóa credential được lưu trên máy.', 'success');
  } catch (error) {
    setAlert(error.message);
  }
});

elements.buildButton.addEventListener('click', async () => {
  if (!state.sessionId || state.selected.size === 0) return;
  setAlert('');
  setButtonLoading(elements.buildButton, true, 'Đang tạo job…');
  try {
    const job = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/build`, {
      method: 'POST',
      body: JSON.stringify({
        problemIds: [...state.selected],
        concurrency: Number(elements.concurrency.value),
        verify: elements.verify.checked,
      }),
    });
    state.jobId = job.id;
    elements.problemsPanel.hidden = true;
    elements.progressPanel.hidden = false;
    renderJob(job);
    elements.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    schedulePoll();
  } catch (error) {
    setAlert(error.message);
  } finally {
    setButtonLoading(elements.buildButton, false);
  }
});

function stateLabel(itemState) {
  return ({
    QUEUED: 'Đang chờ',
    SUBMITTING: 'Đang gửi',
    PENDING: 'Trong hàng đợi',
    RUNNING: 'Đang build',
    READY: 'Hoàn tất',
    FAILED: 'Thất bại',
    CANCELLED: 'Đã dừng',
    SKIPPED: 'Đã có package',
  })[itemState] || itemState;
}

function renderJob(job) {
  const { counts } = job;
  const running = counts.total - counts.completed;
  const percent = counts.total ? Math.round((counts.completed / counts.total) * 100) : 0;
  const done = terminalJobStates.has(job.state);

  elements.progressBar.style.width = `${percent}%`;
  elements.statTotal.textContent = counts.total;
  elements.statReady.textContent = counts.ready;
  elements.statRunning.textContent = Math.max(0, running);
  elements.statFailed.textContent = counts.failed;
  elements.cancelButton.hidden = done;
  elements.finishedActions.hidden = !done;

  if (done) {
    for (const item of job.items) {
      if (item.state === 'READY' || item.state === 'SKIPPED') {
        const problem = state.problems.find((candidate) => String(candidate.id) === String(item.problem.id));
        if (problem) problem.latestPackage = problem.revision;
      }
    }
    elements.jobTitle.textContent = job.state === 'COMPLETED' ? 'Build đã hoàn tất' : 'Job đã kết thúc';
    elements.jobSummary.textContent = `${counts.ready}/${counts.total} package thành công${counts.failed ? `, ${counts.failed} lỗi` : ''}.`;
  } else {
    elements.jobTitle.textContent = `Đang build ${counts.total} problem`;
    elements.jobSummary.textContent = `${counts.completed}/${counts.total} đã xử lý · tối đa ${job.concurrency} build song song${job.verify ? ' · có verify' : ''}.`;
  }

  elements.progressBody.innerHTML = job.items.map((item) => {
    const cssState = item.state.toLowerCase();
    const detail = item.error
      ? `<span class="detail-error">${escapeHtml(item.error)}</span>`
      : item.packageComment
        ? `<span class="detail-muted">${escapeHtml(item.packageComment)}</span>`
        : '<span class="detail-muted">—</span>';
    return `
      <tr>
        <td><span class="problem-name">${escapeHtml(item.problem.name)}</span><span class="problem-id">ID ${escapeHtml(item.problem.id)}</span></td>
        <td>${item.packageId ? `#${escapeHtml(item.packageId)} · ${escapeHtml(item.packageType || 'full')}` : '—'}</td>
        <td><span class="status-pill ${escapeHtml(cssState)}">${escapeHtml(stateLabel(item.state))}</span></td>
        <td>${detail}</td>
      </tr>`;
  }).join('');
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(pollJob, 2_000);
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
    renderJob(job);
    if (!terminalJobStates.has(job.state)) schedulePoll();
  } catch (error) {
    setAlert(`Không cập nhật được tiến độ: ${error.message}`);
    schedulePoll();
  }
}

elements.cancelButton.addEventListener('click', async () => {
  if (!state.jobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.jobId)}`, { method: 'DELETE' });
    elements.cancelButton.disabled = true;
    elements.jobSummary.textContent = 'Đang dừng các tác vụ chưa gửi và ngừng theo dõi…';
    schedulePoll();
  } catch (error) {
    setAlert(error.message);
  }
});

elements.newJobButton.addEventListener('click', () => {
  clearTimeout(state.pollTimer);
  state.jobId = null;
  elements.progressPanel.hidden = true;
  elements.problemsPanel.hidden = false;
  elements.cancelButton.disabled = false;
  renderProblems();
  elements.problemsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

async function initializeCredentials() {
  try {
    const status = await api('/api/credentials/status');
    updateSavedCredentialUi(status.saved);
    if (status.saved) await connectWithSavedCredentials({ automatic: true });
  } catch (error) {
    setAlert(`Không đọc được cấu hình đã lưu: ${error.message}`);
  }
}

void initializeCredentials();
