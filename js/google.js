// 구글 로그인과 드라이브 읽기를 담당하는 도우미예요. 여러 화면이 함께 써요.
// 로그인 정보는 브라우저 탭을 닫으면 사라지고(sessionStorage),
// 읽어 온 기획안은 이 브라우저에만 저장돼요(localStorage). 서버에는 남지 않아요.

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
      throw new Error('드라이브 읽기 권한에 체크해 주셔야 기획안을 찾을 수 있어요. 다시 로그인해 주세요.');
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

  async function drive(path, params) {
    const s = getSession();
    if (!s) throw new Error('로그인이 만료되었어요. 첫 화면에서 다시 로그인해 주세요.');
    const url = new URL('https://www.googleapis.com/drive/v3/' + path);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + s.token } });
    if (res.status === 401) {
      write(sessionStorage, SESSION_KEY, null);
      throw new Error('로그인이 만료되었어요. 첫 화면에서 다시 로그인해 주세요.');
    }
    if (!res.ok) throw new Error('드라이브에서 정보를 가져오지 못했어요. (' + res.status + ')');
    return res;
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

  // 읽을 수 있는 문서 목록 (폴더 하나 또는 드라이브 전체의 최근 문서)
  async function listDocs(folderId) {
    const types = Object.keys(READABLE).map((t) => "mimeType='" + t + "'").join(' or ');
    let q = '(' + types + ') and trashed=false';
    if (folderId) q += " and '" + escapeQuery(folderId) + "' in parents";
    const res = await drive('files', {
      q,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: String(MAX_DOCS),
    });
    return (await res.json()).files || [];
  }

  async function exportText(file) {
    const res = await drive('files/' + encodeURIComponent(file.id) + '/export', { mimeType: 'text/plain' });
    const text = await res.text();
    return text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // 문서들을 하나씩 읽어 오며 진행 상황을 알려줘요.
  async function buildLibrary(source, onProgress) {
    const files = await listDocs(source.folderId);
    const docs = [];
    let total = 0;
    let skipped = 0;
    for (let i = 0; i < files.length; i++) {
      onProgress && onProgress(i, files.length, files[i].name);
      try {
        const paragraphs = await exportText(files[i]);
        const size = paragraphs.join('\n').length;
        if (!paragraphs.length) continue;
        if (total + size > MAX_TOTAL_CHARS) { skipped++; continue; }
        total += size;
        docs.push({ id: files[i].id, name: files[i].name, link: files[i].webViewLink || '', paragraphs });
      } catch (e) {
        skipped++;
      }
    }
    onProgress && onProgress(files.length, files.length, '');
    const library = { source: source.label, docs, skipped, at: Date.now() };
    if (!write(localStorage, LIBRARY_KEY, library)) {
      throw new Error('읽어 온 문서가 너무 커서 브라우저에 저장하지 못했어요. 더 작은 폴더를 골라 주세요.');
    }
    return library;
  }

  function getLibrary() {
    return read(localStorage, LIBRARY_KEY);
  }
  function clearLibrary() {
    write(localStorage, LIBRARY_KEY, null);
  }

  window.SnipGoogle = {
    MAX_DOCS,
    READABLE,
    hasClientId: () => Boolean(clientId()),
    signIn,
    signOut,
    getSession,
    requireSession,
    listFolders,
    buildLibrary,
    getLibrary,
    clearLibrary,
  };
})();
