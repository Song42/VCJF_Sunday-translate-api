import { MAX_IMPORT_BYTES, emptySnapshot, parseDashboardJSON, createViewReset, afterViewReset } from './data.js';

const $ = (id) => document.getElementById(id);
const languages = ['ko', 'ru', 'kk', 'en'];
let activeLanguages = ['ko', 'ru', 'kk'];
const labels = { waiting: '대기', translating: '번역 중', draft: '임시 번역', initial: '확정 검증 중', final: '최종 확정' };
const reasons = { silence: '2초 음성 무음', stable_prefix: '뒤 문맥으로 앞부분 확정', limit: '텍스트 크기 제한' };
let latest = null, paused = false, selected = null, generation = '', filter = 'all', historyTab = false;
const rowCache = new Map();
let sourceSignature = '', detailSignature = '';
let liveSnapshot = null, viewMode = 'live', importedName = '', viewReset = null, connected = false, loadVersion = 0;

function connectionState() {
  const live = viewMode === 'live';
  $('connection').classList.toggle('connected', live && connected);
  $('connection').replaceChildren(element('i'), document.createTextNode(live ? connected ? '실시간 연결' : '재연결 중' : viewMode === 'log' ? '선택 로그 보기' : '저장 파일 보기'));
  $('view-source').textContent = live ? viewReset ? '화면 초기화 이후 · 새 갱신부터 표시' : '최신 로그 · 실시간 보기'
    : `${viewMode === 'log' ? '선택 로그' : 'JSON 파일'} · ${importedName}`;
  $('return-live').hidden = live;
  $('pause').disabled = !live;
}
function showLive() {
  if (viewMode !== 'live' || paused || !liveSnapshot) return;
  latest = afterViewReset(liveSnapshot, viewReset);
  render(latest);
}
function resetControls() {
  paused = false; selected = null; generation = ''; sourceSignature = ''; detailSignature = ''; filter = 'all';
  $('pause').textContent = '화면 일시정지'; $('follow').checked = true;
  for (const button of document.querySelectorAll('[data-filter]')) button.classList.toggle('active', button.dataset.filter === 'all');
  $('events').replaceChildren();
}
function actionStatus(message, failed = false) {
  $('action-status').textContent = message;
  $('action-status').classList.toggle('action-error', failed);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function clock(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('ko-KR', { hour12: false }) : '—';
}
function name(id, snapshot) { return snapshot.speakers[id] || (id ? `화자 · ${id.slice(-6)}` : '전사 대기'); }
function pill(node, status, text = labels[status] || status) { node.className = `pill ${status}`; node.textContent = text; }

function render(snapshot) {
  if (!snapshot || paused) return;
  const key = `${snapshot.file}:${snapshot.generation}`;
  if (generation !== key) {
    generation = key; selected = null; sourceSignature = ''; detailSignature = '';
    rowCache.clear(); $('captions').replaceChildren();
  }
  const config = snapshot.config;
  $('reset').disabled = false;
  const configured = typeof config.targetLanguages === 'string' ? config.targetLanguages.split(',') : [];
  const observed = [...new Set(snapshot.captions.flatMap(caption => Object.keys(caption.translations)))];
  activeLanguages = configured.length ? configured.filter(language => languages.includes(language))
    : observed.length ? languages.filter(language => observed.includes(language)) : ['ko', 'ru', 'kk'];
  document.querySelectorAll('.captions-panel thead th').forEach((header, index) => {
    if (index >= 2) header.hidden = !activeLanguages.includes(languages[index - 2]);
  });
  $('stt-model').textContent = config.sttModel ? `${config.sttModel} · ${config.sttDelay || '—'}` : '전사 모델 대기';
  $('translation-model').textContent = config.model ? `${config.model} · ${config.reasoningEffort || '—'}` : '번역 모델 대기';
  $('mode').textContent = config.mode || '설정 대기';
  pill($('meeting'), snapshot.meeting === 'running' ? 'draft' : 'stopped', { running: '모임 진행 중', stopped: '모임 종료', waiting: '모임 대기' }[snapshot.meeting] || '대기');
  const notice = snapshot.error ? `처리 오류: ${snapshot.error} · 아래 이벤트를 확인하세요.` : snapshot.notice
    || (config.mode && config.mode !== 'streaming' ? `현재 로그는 이전 ${config.mode} 모드입니다. 새 streaming 설정으로 봇을 재시작하면 임시 전사와 자막 수정 과정도 표시됩니다.` : '');
  $('notice').hidden = !notice; $('notice').textContent = notice || '';
  $('file').textContent = snapshot.file || '로그 파일 대기 중';
  $('transcript-count').textContent = snapshot.transcripts.length;
  $('draft-count').textContent = snapshot.captions.filter((item) => item.status !== 'final').length;
  $('final-count').textContent = snapshot.captions.filter((item) => item.status === 'final').length;
  const timed = snapshot.captions.find((item) => item.latencyMs !== null);
  $('latency').textContent = timed ? `${(timed.latencyMs / 1000).toFixed(1)}s` : '—';
  renderSources(snapshot);
  const visible = snapshot.captions.filter((item) => filter === 'all' || (filter === 'final' ? item.status === 'final' : item.status !== 'final'));
  if ($('follow').checked) selected = visible.find((item) => item.status !== 'final')?.sequence ?? visible[0]?.sequence ?? null;
  if (selected === null) selected = visible[0]?.sequence ?? null;
  renderRows(visible);
  renderDetails(snapshot.captions.find((item) => item.sequence === selected), snapshot);
  $('captions-empty').hidden = visible.length > 0;
  $('event-count').textContent = `${snapshot.events.length}개`;
  if ($('events-panel').open) renderEvents(snapshot.events);
  updateAge();
}

function renderSources(snapshot) {
  const signature = JSON.stringify([snapshot.transcripts, snapshot.speakers]);
  if (signature === sourceSignature) return;
  sourceSignature = signature;
  if (!snapshot.transcripts.length) { $('transcripts').replaceChildren(element('div', 'empty', viewMode !== 'live' ? '불러온 파일에 표시할 전사가 없습니다.' : '새 전사를 기다리고 있습니다. Discord에서 /start 후 말해보세요.')); return; }
  const nodes = snapshot.transcripts.slice().reverse().map((source) => {
    const row = element('div', `transcript-item ${source.final ? '' : 'interim'}`);
    const meta = element('div', 'item-meta');
    meta.append(element('span', 'source-marker'), element('span', 'speaker', name(source.speakerId, snapshot)),
      element('span', 'source-state', source.failed ? '전사 오류' : source.final ? 'STT 확정' : '임시 전사'), element('span', 'timestamp', clock(source.at)));
    row.append(meta, element('p', 'source-text', source.text || '(인식된 텍스트 없음)'));
    return row;
  });
  $('transcripts').replaceChildren(...nodes);
}

function renderRows(captions) {
  const allowed = new Set(captions.map((item) => item.sequence));
  for (const [id, cached] of rowCache) if (!allowed.has(id)) { cached.row.remove(); rowCache.delete(id); }
  let position = $('captions').firstElementChild;
  for (const caption of captions) {
    const signature = JSON.stringify([activeLanguages, caption]);
    let cached = rowCache.get(caption.sequence);
    if (!cached) {
      const row = element('tr'); row.tabIndex = 0;
      const select = () => { selected = caption.sequence; $('follow').checked = false; detailSignature = ''; render(latest); };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
      cached = { row, signature: '' }; rowCache.set(caption.sequence, cached);
    }
    cached.row.classList.toggle('selected', caption.sequence === selected);
    if (cached.signature !== signature) {
      const meta = element('div', 'unit-meta');
      const badge = element('span', `pill ${caption.status}`, labels[caption.status] || caption.status);
      meta.append(element('span', 'unit-id', `#${String(caption.sequence).padStart(3, '0')}`), badge,
        element('span', 'unit-speaker', caption.speakerName || name(caption.speakerId, latest)),
        element('span', 'unit-revision', `rev ${caption.revision} · ${clock(caption.at)}`));
      const identity = element('td'); identity.append(meta);
      const original = element('td', caption.status === 'final' ? '' : 'draft-text', caption.originalText || caption.target || '번역 응답 대기 중…');
      const cells = languages.map((language) => {
        const cell = element('td', caption.translations[language] ? caption.status === 'final' ? '' : 'draft-text' : 'missing', caption.translations[language] || '—');
        cell.hidden = !activeLanguages.includes(language);
        return cell;
      });
      cached.row.replaceChildren(identity, original, ...cells);
      if (cached.signature) { cached.row.classList.remove('cell-updated'); void cached.row.offsetWidth; cached.row.classList.add('cell-updated'); }
      cached.signature = signature;
    }
    if (cached.row !== position) $('captions').insertBefore(cached.row, position);
    position = cached.row.nextElementSibling;
  }
}

function renderDetails(caption, snapshot) {
  const signature = JSON.stringify([caption, snapshot.speakers, historyTab]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  $('selected-id').textContent = caption ? `#${String(caption.sequence).padStart(3, '0')}` : '';
  pill($('selected-status'), caption?.status || 'waiting');
  $('selected-speaker').textContent = caption ? name(caption.speakerId, snapshot) : '';
  $('target').textContent = caption?.target || caption?.originalText || '아직 번역 요청이 없습니다.';
  $('pending').textContent = caption?.pending || '보류된 새 내용 없음';
  $('reason').textContent = `확정 이유: ${reasons[caption?.reason] || caption?.reason || '아직 확정하지 않음'}`;
  $('selected-latency').textContent = caption?.latencyMs !== null && caption?.latencyMs !== undefined ? `번역 ${(caption.latencyMs / 1000).toFixed(2)}초` : '번역 시간 대기';
  $('history-count').textContent = caption?.history.length || 0;
  const history = (caption?.history || []).slice().reverse().map((entry) => {
    const item = element('div', 'history-item'), meta = element('div', 'item-meta');
    meta.append(element('span', `pill ${entry.status}`, labels[entry.status] || entry.status),
      element('span', '', `rev ${entry.revision}`), element('span', 'timestamp', clock(entry.at)));
    item.append(meta, element('p', '', entry.originalText));
    for (const language of activeLanguages) if (entry.translations[language]) {
      item.append(element('p', 'history-translation', `${language.toUpperCase()} · ${entry.translations[language]}`));
    }
    return item;
  });
  $('history').replaceChildren(...(history.length ? history : [element('div', 'empty', '아직 번역 수정 이력이 없습니다.')]));
}

function renderEvents(events) {
  $('events').replaceChildren(...events.map((entry) => {
    const row = element('div', 'event-row');
    row.append(element('span', '', clock(entry.at)), element('span', 'event-name', entry.event),
      element('span', '', entry.sequence ? `#${entry.sequence}` : ''), element('span', 'event-text', entry.text || '—'));
    return row;
  }));
}
function updateAge() {
  if (viewMode !== 'live') { $('updated').textContent = latest?.updatedAt ? `${clock(latest.updatedAt)} 기록 시각` : '저장 파일'; return; }
  const time = new Date(latest?.updatedAt || '').getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  $('updated').textContent = !Number.isFinite(time) ? '아직 수신 없음' : seconds < 60 ? `${seconds}초 전 수신`
    : seconds < 3600 ? `${Math.floor(seconds / 60)}분 전 수신` : `${Math.floor(seconds / 3600)}시간 전 수신`;
}

$('pause').addEventListener('click', () => { paused = !paused; $('pause').textContent = paused ? '실시간 화면 재개' : '화면 일시정지'; if (!paused) showLive(); });
$('follow').addEventListener('change', () => render(latest));
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const sibling of document.querySelectorAll('[data-filter]')) sibling.classList.toggle('active', sibling === button);
  render(latest);
});
for (const id of ['flow-tab', 'history-tab']) $(id).addEventListener('click', () => {
  historyTab = id === 'history-tab'; $('flow').hidden = historyTab; $('history').hidden = !historyTab;
  for (const tab of ['flow-tab', 'history-tab']) { $(tab).classList.toggle('active', tab === id); $(tab).setAttribute('aria-selected', String(tab === id)); }
  render(latest);
});
$('events-panel').addEventListener('toggle', () => { if ($('events-panel').open && latest) renderEvents(latest.events); });
$('download').addEventListener('click', () => {
  if (!latest) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `translation-monitor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('reset').disabled = true;
$('reset').addEventListener('click', () => {
  loadVersion++; resetControls();
  if (viewMode === 'live') {
    viewReset = liveSnapshot ? createViewReset(liveSnapshot) : null;
    latest = liveSnapshot ? afterViewReset(liveSnapshot, viewReset) : emptySnapshot();
  } else latest = { ...emptySnapshot(), file: importedName, config: latest?.config || {} };
  render(latest); connectionState();
  actionStatus('화면만 초기화했습니다. 로그·녹음·저장 JSON은 유지됩니다.');
});
$('load').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0]; $('file-input').value = '';
  if (!file) return;
  const version = ++loadVersion;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('8MB 이하의 JSON 파일을 선택하세요.');
    const snapshot = parseDashboardJSON(await file.text(), file.name);
    if (version !== loadVersion) return;
    resetControls(); viewMode = 'file'; importedName = file.name; latest = snapshot;
    render(latest); connectionState();
    actionStatus('브라우저에서 파일을 열었습니다. 실시간 로그는 이 화면을 덮어쓰지 않습니다.');
  } catch (error) {
    if (version === loadVersion) actionStatus(error instanceof Error ? error.message : 'JSON 파일을 불러오지 못했습니다.', true);
  }
});
function returnLive() {
  loadVersion++; resetControls(); viewMode = 'live'; importedName = ''; viewReset = null;
  $('log-select').value = '';
  latest = liveSnapshot || emptySnapshot(); render(latest); connectionState();
  actionStatus('최신 로그의 실시간 보기로 돌아왔습니다.');
}
$('return-live').addEventListener('click', returnLive);
async function refreshLogs(announce = false) {
  try {
    const response = await fetch('/api/logs');
    if (!response.ok) throw new Error('로그 목록을 읽지 못했습니다. 대시보드 서버를 재시작해 주세요.');
    const { files } = await response.json(), previous = $('log-select').value;
    if (!Array.isArray(files)) throw new Error('로그 목록 형식이 잘못되었습니다.');
    const automatic = element('option', '', '최신 로그 자동 추적'); automatic.value = '';
    $('log-select').replaceChildren(automatic, ...files.map(file => {
      const option = element('option', '', file); option.value = file; return option;
    }));
    if (files.includes(previous)) $('log-select').value = previous;
    if (announce) actionStatus(`실행 로그 ${files.length}개를 확인했습니다.`);
  } catch (error) { actionStatus(error instanceof Error ? error.message : '로그 목록을 읽지 못했습니다.', true); }
}
$('refresh-logs').addEventListener('click', () => { void refreshLogs(true); });
$('open-log').addEventListener('click', async () => {
  const name = $('log-select').value;
  if (!name) { returnLive(); return; }
  const version = ++loadVersion;
  actionStatus('선택한 로그를 읽고 있습니다.');
  try {
    const response = await fetch(`/api/log?name=${encodeURIComponent(name)}`);
    const snapshot = await response.json();
    if (version !== loadVersion) return;
    if (!response.ok) throw new Error(snapshot.error || '로그를 읽지 못했습니다.');
    resetControls(); viewMode = 'log'; importedName = name; latest = snapshot;
    render(latest); connectionState();
    actionStatus('선택한 로그를 열었습니다. 내용이 추가되면 로그 열기 / 다시 읽기를 눌러 갱신하세요.');
  } catch (error) {
    if (version === loadVersion) actionStatus(error instanceof Error ? error.message : '로그를 읽지 못했습니다.', true);
  }
});
const events = new EventSource('/events');
events.onopen = () => { connected = true; connectionState(); };
events.onerror = () => { connected = false; connectionState(); };
events.addEventListener('snapshot', (message) => {
  try {
    liveSnapshot = JSON.parse(message.data);
    if (viewReset && `${liveSnapshot.file}:${liveSnapshot.generation}` !== viewReset.key) { viewReset = null; connectionState(); }
    showLive();
  } catch { if (viewMode === 'live') actionStatus('실시간 화면 데이터를 읽지 못했습니다. 새로고침해 주세요.', true); }
});
connectionState();
void refreshLogs();
setInterval(updateAge, 1000);
