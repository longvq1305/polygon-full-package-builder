import { isEligibleProblem, supportsPackageHistoryFilter } from './package-status.js';

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
  packageStatusProgress: document.querySelector('#package-status-progress'),
  refreshPackageStatus: document.querySelector('#refresh-package-status'),
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
  jobActive: false,
  packageStatusLoadToken: 0,
  packageStatusLoading: false,
  packageStatusStoreHits: 0,
  refreshingStoredStatuses: false,
  selectNewEligible: true,
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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function packageStatusBadge(status) {
  const details = {
    UNBUILT: ['Chưa build', 'package-unbuilt'],
    STANDARD: ['Standard', 'package-standard'],
    FULL: ['Full package', 'package-full'],
    LOADING: ['Đang kiểm tra…', 'package-loading'],
    ERROR: ['Không đọc được', 'package-error'],
  }[status] || ['Chưa build', 'package-unbuilt'];
  return `<span class="status-pill ${details[1]}">${details[0]}</span>`;
}

function updateProblemSummary() {
  const eligible = state.problems.filter(isEligibleProblem);
  const modified = eligible.filter((problem) => problem.modified).length;
  const committed = eligible.filter((problem) => !problem.modified);
  const unbuilt = committed.filter((problem) => problem.packageStatus === 'UNBUILT').length;
  const standard = committed.filter((problem) => problem.packageStatus === 'STANDARD').length;
  const suffix = modified
    ? `; ${modified} problem chưa commit sẽ được tự commit trước khi build.`
    : '.';
  elements.problemSummary.textContent = state.packageStatusLoading
    ? `Tạm thời có ${eligible.length} problem cần xử lý; danh sách đang tiếp tục cập nhật${suffix}`
    : `Có ${eligible.length} problem cần xử lý: ${unbuilt} chưa build, ${standard} Standard${suffix}`;
}

function renderProblems() {
  const filter = elements.problemFilter.value.trim().toLocaleLowerCase('vi');
  const eligible = state.problems.filter(isEligibleProblem);
  const visible = eligible.filter((problem) => {
    return !filter || problem.name.toLocaleLowerCase('vi').includes(filter) || String(problem.id).includes(filter);
  });

  elements.problemsBody.innerHTML = visible.map((problem) => {
    const workingCopyStatus = problem.modified
      ? '<span class="status-pill modified">Chưa commit</span>'
      : '<span class="status-pill ready">Sẵn sàng</span>';
    const latestPackage = problem.latestPackage ?? '—';
    return `
      <tr data-problem-row="${escapeHtml(problem.id)}">
        <td class="checkbox-cell">
          <input type="checkbox" data-problem-id="${escapeHtml(problem.id)}" ${state.selected.has(String(problem.id)) ? 'checked' : ''} aria-label="Chọn ${escapeHtml(problem.name)}">
        </td>
        <td><span class="problem-name">${escapeHtml(problem.name)}</span><span class="problem-id">ID ${escapeHtml(problem.id)} · ${escapeHtml(problem.owner)}</span></td>
        <td>${escapeHtml(problem.revision ?? '—')}</td>
        <td>${escapeHtml(latestPackage)}</td>
        <td>${packageStatusBadge(problem.packageStatus)}</td>
        <td>${workingCopyStatus}</td>
      </tr>`;
  }).join('');

  elements.emptyFilter.textContent = eligible.length
    ? 'Không có problem khớp từ khóa.'
    : state.packageStatusLoading
      ? 'Đang kiểm tra các problem đã có package…'
      : 'Không có problem nào cần build full package.';
  elements.emptyFilter.hidden = visible.length > 0;
  updateProblemSummary();
  updateSelectedCount();
}

function updateSelectedCount() {
  const selectableIds = new Set(state.problems
    .filter(isEligibleProblem)
    .map((problem) => String(problem.id)));
  for (const problemId of state.selected) {
    if (!selectableIds.has(problemId)) state.selected.delete(problemId);
  }
  const count = state.selected.size;
  elements.selectedCount.textContent = state.packageStatusLoading
    ? `${count} problem đã chọn · đang hoàn tất kiểm tra package`
    : `${count} problem đã chọn`;
  elements.buildButton.disabled = count === 0 || state.packageStatusLoading;
  elements.refreshPackageStatus.disabled = state.packageStatusLoading || state.jobActive || state.refreshingStoredStatuses;
}

function updateSavedCredentialUi(saved) {
  state.credentialsSaved = Boolean(saved);
  elements.savedCredentialsActions.hidden = !state.credentialsSaved;
}

function resetToCredentials({ closeSession = true } = {}) {
  clearTimeout(state.pollTimer);
  state.packageStatusLoadToken += 1;
  state.jobActive = false;
  state.packageStatusLoading = false;
  state.packageStatusStoreHits = 0;
  state.refreshingStoredStatuses = false;
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

function updatePackageStatusProgress({ completed, total, errors = 0 }) {
  if (total === 0) {
    elements.packageStatusProgress.textContent = state.packageStatusStoreHits
      ? `Đã khôi phục ${state.packageStatusStoreHits} trạng thái từ file cục bộ trên máy.`
      : 'Các problem trong danh sách chưa có package.';
    return;
  }
  if (completed < total) {
    const storedNote = state.packageStatusStoreHits
      ? `Đã đọc ${state.packageStatusStoreHits} problem từ file cục bộ; `
      : '';
    elements.packageStatusProgress.textContent = state.jobActive
      ? `Đã kiểm tra ${completed}/${total} trạng thái package; tạm dừng trong khi build.`
      : `${storedNote}đang kiểm tra ${completed}/${total} trạng thái còn thiếu; request được xếp hàng để tránh HTTP 429.`;
    return;
  }
  elements.packageStatusProgress.textContent = errors
    ? `Đã kiểm tra xong; ${errors} problem không đọc được trạng thái package.`
    : `Đã cập nhật trạng thái package cho ${total} problem.`;
}

async function loadPackageStatuses() {
  const sessionId = state.sessionId;
  const token = ++state.packageStatusLoadToken;
  const problems = state.problems.filter((problem) => problem.packageStatus === 'LOADING');
  state.packageStatusLoading = problems.length > 0;
  let completed = 0;
  let errors = 0;
  updatePackageStatusProgress({ completed, total: problems.length });

  for (const problem of problems) {
    while (state.jobActive && token === state.packageStatusLoadToken) {
      updatePackageStatusProgress({ completed, total: problems.length, errors });
      await wait(500);
    }
    if (token !== state.packageStatusLoadToken || sessionId !== state.sessionId) return;

    try {
      const result = await api(
        `/api/sessions/${encodeURIComponent(sessionId)}/problems/${encodeURIComponent(problem.id)}/package-status`,
      );
      if (token !== state.packageStatusLoadToken || sessionId !== state.sessionId) return;
      problem.packageStatus = result.status;
    } catch {
      if (token !== state.packageStatusLoadToken || sessionId !== state.sessionId) return;
      problem.packageStatus = 'ERROR';
      errors += 1;
    }
    if (isEligibleProblem(problem) && state.selectNewEligible) {
      state.selected.add(String(problem.id));
    } else if (!isEligibleProblem(problem)) {
      state.selected.delete(String(problem.id));
    }
    completed += 1;
    renderProblems();
    updatePackageStatusProgress({ completed, total: problems.length, errors });
    await wait(0);
  }
  state.packageStatusLoading = false;
  renderProblems();
}

function setProblemList(problems, storeHits = 0) {
  state.problems = problems.map((problem) => ({
    ...problem,
    packageStatus: problem.packageStatus || 'UNBUILT',
  }));
  state.packageStatusStoreHits = Number(storeHits) || 0;
  state.packageStatusLoading = state.problems.some((problem) => problem.packageStatus === 'LOADING');
  state.selectNewEligible = true;
  state.selected = new Set(state.problems
    .filter(isEligibleProblem)
    .map((problem) => String(problem.id)));
}

function applySessionResult(result) {
  state.packageStatusLoadToken += 1;
  state.sessionId = result.sessionId;
  setProblemList(result.problems, result.packageStatusStoreHits);
  updateSavedCredentialUi(result.credentialsSaved);
  elements.apiKey.value = '';
  elements.secretKey.value = '';
  elements.credentialsPanel.hidden = true;
  elements.problemsPanel.hidden = false;
  elements.progressPanel.hidden = true;
  renderProblems();
  void loadPackageStatuses();
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
  state.selectNewEligible = true;
  for (const problem of state.problems) {
    if (isEligibleProblem(problem)) state.selected.add(String(problem.id));
  }
  renderProblems();
});
elements.clearAll.addEventListener('click', () => {
  state.selectNewEligible = false;
  state.selected.clear();
  renderProblems();
});
elements.refreshPackageStatus.addEventListener('click', async () => {
  if (!state.sessionId || state.packageStatusLoading || state.jobActive) return;
  state.refreshingStoredStatuses = true;
  setButtonLoading(elements.refreshPackageStatus, true, 'Đang chuẩn bị quét lại…');
  setAlert('');
  try {
    state.packageStatusLoadToken += 1;
    const result = await api(
      `/api/sessions/${encodeURIComponent(state.sessionId)}/package-status-store/refresh`,
      { method: 'POST' },
    );
    setProblemList(result.problems, 0);
    renderProblems();
    void loadPackageStatuses();
  } catch (error) {
    setAlert(error.message);
  } finally {
    state.refreshingStoredStatuses = false;
    setButtonLoading(elements.refreshPackageStatus, false);
    updateSelectedCount();
  }
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
  state.jobActive = true;
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
    state.jobActive = false;
    setAlert(error.message);
  } finally {
    setButtonLoading(elements.buildButton, false);
  }
});

function stateLabel(itemState) {
  return ({
    QUEUED: 'Đang chờ',
    COMMITTING: 'Đang commit',
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
  state.jobActive = !done;

  elements.progressBar.style.width = `${percent}%`;
  elements.statTotal.textContent = counts.total;
  elements.statReady.textContent = counts.ready;
  elements.statRunning.textContent = Math.max(0, running);
  elements.statFailed.textContent = counts.failed;
  elements.cancelButton.hidden = done;
  elements.finishedActions.hidden = !done;

  if (done) {
    for (const item of job.items) {
      const problem = state.problems.find((candidate) => String(candidate.id) === String(item.problem.id));
      if (problem) {
        problem.revision = item.problem.revision;
        problem.workingCopyRevision = item.problem.workingCopyRevision;
        problem.modified = Boolean(item.problem.modified);
      }
      if (item.state === 'READY' || item.state === 'SKIPPED') {
        if (problem) {
          problem.latestPackage = problem.revision;
          problem.packageStatus = 'FULL';
        }
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
    const detailText = [item.commitComment, item.packageComment].filter(Boolean).join(' · ');
    const detail = item.error
      ? `<span class="detail-error">${escapeHtml(item.error)}</span>`
      : detailText
        ? `<span class="detail-muted">${escapeHtml(detailText)}</span>`
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
  state.jobActive = false;
  elements.progressPanel.hidden = true;
  elements.problemsPanel.hidden = false;
  elements.cancelButton.disabled = false;
  renderProblems();
  elements.problemsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

async function initializeCredentials() {
  try {
    const health = await api('/api/health');
    if (!supportsPackageHistoryFilter(health)) {
      throw new Error('Backend đang chạy là phiên bản cũ. Hãy đóng cửa sổ tool cũ rồi mở lại file Chay Polygon Builder.cmd.');
    }
    const status = await api('/api/credentials/status');
    updateSavedCredentialUi(status.saved);
    if (status.saved) await connectWithSavedCredentials({ automatic: true });
  } catch (error) {
    setAlert(`Không đọc được cấu hình đã lưu: ${error.message}`);
  }
}

void initializeCredentials();
