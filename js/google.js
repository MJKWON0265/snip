// 구글 로그인과 드라이브 읽기를 담당하는 도우미예요. 여러 화면이 함께 써요.
// 로그인 정보는 브라우저 탭을 닫으면 사라지고(sessionStorage),
// 읽어 온 참고 문서는 이 브라우저에만 저장돼요(localStorage). 서버에는 남지 않아요.

(function () {
  const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.readonly';
  const SESSION_KEY = 'snip-google';
  const LIBRARY_KEY = 'snip-library';

  // 한 번에 읽어 오는 양의 한도예요. 많을수록 AI 비용이 커져요.
  const MAX_DOCS = 30;
  const MAX_TOTAL_CHARS = 120000;

  // 읽을 수 있는 파일 종류: 구글 문서, 구글 프레젠테이션
  const READABLE = {
    'application/vnd.google-apps.document': '구글 문서',
    'application/vnd.google-apps.presentation': '구글 프레젠테이션',
  };

  function read(storage, key) {
    try { return JSON.parse(storage.getItem(key)); } catch (e) { return null; }
  }
  function write(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clientId() {
    return (window.SNIP_CONFIG && window.SNIP_CONFIG.GOOGLE_CLIENT_ID) || '';
  }

  // 구글이 제공하는 로그인 스크립트를 필요할 때 불러와요.
  let gisLoading = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('구글 로그인 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'));
        document.head.appendChild(s);
      });
    }
    return gisLoading;
  }

  function getSession() {
    const s = read(sessionStorage, SESSION_KEY);
    if (!s || !s.token || Date.now() > s.expiresAt) return null;
    return s;
  }

  async function signIn() {
    if (!clientId()) {
      throw new Error('아직 구글 클라이언트 ID가 설정되지 않았어요. (js/config.js)');
    }
    await loadGis();
    const token = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) reject(new Error('구글 로그인이 취소되었거나 실패했어요.'));
          else resolve(resp);
        },
        error_callback: () => reject(new Error('구글 로그인 창이 닫혔어요. 다시 눌러 주세요.')),
      });
      client.requestAccessToken();
    });

    if (!google.accounts.oauth2.hasGrantedAllScopes(token, 'https://www.googleapis.com/auth/drive.readonly')) {
      throw new Error('드라이브 읽기 권한에 체크해 주셔야 참고할 문서를 찾을 수 있어요. 다시 로그인해 주세요.');
    }

    const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + token.access_token },
    }).then((r) => r.json());

    const session = {
      token: token.access_token,
      expiresAt: Date.now() + (Number(token.expires_in) - 60) * 1000,
      name: me.name || me.email || '',
      email: me.email || '',
    };
    write(sessionStorage, SESSION_KEY, session);
    return session;
  }

  function signOut() {
    const s = read(sessionStorage, SESSION_KEY);
    write(sessionStorage, SESSION_KEY, null);
    if (s && s.token && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(s.token, () => {});
    }
  }

  // 로그인이 필요한 화면에서 불러요. 로그인 전이면 첫 화면으로 보내요.
  function requireSession() {
    const s = getSession();
    if (!s) {
      location.href = 'index.html?login=needed';
      return null;
    }
    return s;
  }

  // 구글에 요청을 보내요. 실패하면 구글이 알려준 이유(reason)를 오류에 담아 돌려줘요.
  async function google(urlText, params) {
    const s = getSession();
    if (!s) throw new Error('로그인이 만료되었어요. 페이지를 새로고침한 뒤 다시 로그인해 주세요.');
    const url = new URL(urlText);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + s.token } });
    if (res.status === 401) {
      write(sessionStorage, SESSION_KEY, null);
      throw new Error('로그인이 만료되었어요. 페이지를 새로고침한 뒤 다시 로그인해 주세요.');
    }
    if (!res.ok) {
      let info = {};
      try { info = (await res.json()).error || {}; } catch (e) {}
      const err = new Error('드라이브에서 정보를 가져오지 못했어요. (' + res.status + ')');
      err.status = res.status;
      err.reason = (info.errors && info.errors[0] && info.errors[0].reason) || info.status || '';
      err.detail = info.message || '';
      throw err;
    }
    return res;
  }

  function drive(path, params) {
    return google('https://www.googleapis.com/drive/v3/' + path, params);
  }

  function escapeQuery(text) {
    return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // 폴더 목록 (이름으로 검색 가능)
  async function listFolders(search) {
    let q = "mimeType='application/vnd.google-apps.folder' and trashed=false";
    if (search) q += " and name contains '" + escapeQuery(search) + "'";
    const res = await drive('files', {
      q,
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '50',
    });
    return (await res.json()).files || [];
  }

  const FILE_FIELDS = 'files(id,name,mimeType,modifiedTime,webViewLink)';

  function readableTypes() {
    return '(' + Object.keys(READABLE).map((t) => "mimeType='" + t + "'").join(' or ') + ') and trashed=false';
  }

  // 폴더 하나 안의 읽을 수 있는 문서 목록
  async function listDocs(folderId) {
    const res = await drive('files', {
      q: readableTypes() + " and '" + escapeQuery(folderId) + "' in parents",
      fields: FILE_FIELDS,
      orderBy: 'modifiedTime desc',
      pageSize: String(MAX_DOCS),
    });
    return (await res.json()).files || [];
  }

  // 파일 이름으로 문서 찾기
  async function searchFiles(name) {
    let q = readableTypes();
    if (name) q += " and name contains '" + escapeQuery(name) + "'";
    const res = await drive('files', {
      q,
      fields: FILE_FIELDS,
      orderBy: 'modifiedTime desc',
      pageSize: '30',
    });
    return (await res.json()).files || [];
  }

  // 키워드나 문장으로 관련 문서 찾기
  // 구글 드라이브의 본문 검색(fullText)을 써서, 낱말 중 하나라도 들어 있는 문서를
  // 관련 있는 순서대로 가져와요. 문장을 넣으면 두 글자 이상 낱말 몇 개로 나눠 찾아요.
  async function searchByKeyword(text) {
    const words = Array.from(new Set(
      text.split(/[\s,.!?·"'“”‘’()\[\]]+/).map((w) => w.trim()).filter((w) => w.length >= 2),
    )).slice(0, 6);
    if (!words.length) return [];
    const q = readableTypes() + ' and (' +
      words.map((w) => "fullText contains '" + escapeQuery(w) + "'").join(' or ') + ')';
    const res = await drive('files', { q, fields: FILE_FIELDS, pageSize: '15' });
    return (await res.json()).files || [];
  }

  function saveLibrary(library) {
    if (!write(localStorage, LIBRARY_KEY, library)) {
      throw new Error('읽어 온 문서가 너무 커서 브라우저에 저장하지 못했어요. 문서 수를 줄여 주세요.');
    }
    return library;
  }

  function toParagraphs(text) {
    return text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // 구글 문서·프레젠테이션을 글자(text/plain)로 내보내서 읽어요.
  async function exportText(file) {
    const res = await drive('files/' + encodeURIComponent(file.id) + '/export', { mimeType: 'text/plain' });
    return toParagraphs(await res.text());
  }

  // 구글 문서·프레젠테이션 안의 글자 조각(textRun)을 차례대로 모아요.
  function collectText(node, out) {
    if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
    else if (node && typeof node === 'object') {
      if (node.textRun && typeof node.textRun.content === 'string') out.push(node.textRun.content);
      Object.keys(node).forEach((k) => { if (k !== 'textRun') collectText(node[k], out); });
    }
    return out;
  }

  // 내보내기(export)가 막힌 문서는 프레젠테이션/문서 API로 한 번 더 읽어 봐요.
  // (예: 주인이 "보기 권한자는 다운로드 못 함"으로 막아 둔 문서)
  async function readByApi(file) {
    if (file.mimeType === 'application/vnd.google-apps.presentation') {
      const res = await google('https://slides.googleapis.com/v1/presentations/' + encodeURIComponent(file.id), { fields: 'slides(pageElements)' });
      const data = await res.json();
      return (data.slides || []).flatMap((slide) => toParagraphs(collectText(slide.pageElements || [], []).join('')));
    }
    const res = await google('https://docs.googleapis.com/v1/documents/' + encodeURIComponent(file.id), { fields: 'body(content)' });
    return toParagraphs(collectText((await res.json()).body || {}, []).join(''));
  }

  function isApiOff(e) {
    // 구글 클라우드에서 그 API를 아직 켜지 않았을 때 나오는 오류예요.
    return e.status === 403 && (e.reason === 'accessNotConfigured' || e.reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(e.detail || ''));
  }

  // 파일 하나를 읽어요. 실패하면 왜 실패했는지 짧은 이름으로 알려줘요.
  async function readFileText(file) {
    try {
      return { paragraphs: await exportText(file) };
    } catch (e) {
      if (/로그인이 만료/.test(e.message)) throw e;
      try {
        return { paragraphs: await readByApi(file) };
      } catch (e2) {
        if (/로그인이 만료/.test(e2.message)) throw e2;
        const which = file.mimeType === 'application/vnd.google-apps.presentation' ? 'slides' : 'docs';
        if (isApiOff(e2)) return { problem: 'api-off-' + which };
        if (e.reason === 'cannotDownloadFile' || e.reason === 'cannotExportFile') return { problem: 'no-download' };
        if (e.reason === 'exportSizeLimitExceeded') return { problem: 'too-big' };
        console.warn('문서를 읽지 못했어요', file.name, e, e2);
        return { problem: 'error-' + (e2.status || e.status || '?') };
      }
    }
  }

  // 문서들을 하나씩 읽어 오며 진행 상황을 알려줘요.
  // source.folderId가 있으면 그 폴더의 문서를, source.files가 있으면 고른 문서들을 읽어요.
  async function buildLibrary(source, onProgress) {
    const files = source.files ? source.files.slice(0, MAX_DOCS) : await listDocs(source.folderId);
    const docs = [];
    const problems = {}; // 못 읽은 이유별 개수
    let total = 0;
    let skipped = 0;
    const note = (why) => { problems[why] = (problems[why] || 0) + 1; skipped++; };
    for (let i = 0; i < files.length; i++) {
      onProgress && onProgress(i, files.length, files[i].name);
      const got = await readFileText(files[i]);
      if (got.problem) { note(got.problem); continue; }
      const paragraphs = got.paragraphs;
      if (!paragraphs.length) { note('empty'); continue; }
      const size = paragraphs.join('\n').length;
      if (total + size > MAX_TOTAL_CHARS) { note('over-limit'); continue; }
      total += size;
      docs.push({ id: files[i].id, name: files[i].name, link: files[i].webViewLink || '', paragraphs });
    }
    onProgress && onProgress(files.length, files.length, '');
    return saveLibrary({ source: source.label, docs, skipped, problems, at: Date.now() });
  }

  function getLibrary() {
    return read(localStorage, LIBRARY_KEY);
  }
  function clearLibrary() {
    write(localStorage, LIBRARY_KEY, null);
  }

  window.SnipGoogle = {
    MAX_DOCS,
    MAX_TOTAL_CHARS,
    READABLE,
    hasClientId: () => Boolean(clientId()),
    signIn,
    signOut,
    getSession,
    requireSession,
    listFolders,
    searchFiles,
    searchByKeyword,
    buildLibrary,
    saveLibrary,
    getLibrary,
    clearLibrary,
  };
})();
