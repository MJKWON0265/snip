// 내 컴퓨터 파일(워드·PDF·파워포인트·텍스트)에서 글자만 꺼내는 도우미예요. 여러 화면이 함께 써요.
// 파일은 서버로 보내지 않고, 이 브라우저 안에서만 읽어요.

(function () {
  const ACCEPT = '.docx,.pdf,.pptx,.txt,.md';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('파일 읽기 도구를 불러오지 못했어요.'));
      document.head.appendChild(s);
    });
  }

  async function readDocx(file) {
    await loadScript('vendor/mammoth.browser.min.js');
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }

  async function readPdf(file) {
    await loadScript('vendor/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // 같은 줄의 글자는 붙이고, 줄이 바뀌면 줄바꿈을 넣어요.
      let line = '';
      const lines = [];
      content.items.forEach((item) => {
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
      });
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
    }
    return pages.join('\n\n');
  }

  // 파워포인트(.pptx)는 사실 압축 파일이에요. 풀어서 슬라이드마다 들어 있는 글자(<a:t>)를 꺼내요.
  async function readPptx(file) {
    await loadScript('vendor/jszip.min.js');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
    const out = [];
    for (const name of slides) {
      const xml = new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
      // 한 문단(<a:p>) 안의 글자 조각(<a:t>)을 이어 붙여 한 줄로 만들어요.
      const lines = Array.from(xml.getElementsByTagName('a:p'))
        .map((p) => Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent).join('').trim())
        .filter(Boolean);
      if (lines.length) out.push(lines.join('\n'));
    }
    return out.join('\n\n');
  }

  // 파일 하나를 읽어서 정리된 글자를 돌려줘요. 못 읽으면 이유를 담은 오류를 내요.
  async function readText(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    let text;
    if (ext === 'docx') text = await readDocx(file);
    else if (ext === 'pdf') text = await readPdf(file);
    else if (ext === 'pptx') text = await readPptx(file);
    else if (ext === 'txt' || ext === 'md') text = await file.text();
    else if (ext === 'doc' || ext === 'hwp' || ext === 'ppt') throw new Error('예전 워드(.doc)·파워포인트(.ppt)와 한글(.hwp)은 아직 못 읽어요. .docx, .pptx나 PDF로 저장해서 올려 주세요.');
    else throw new Error('이 파일 형식은 아직 못 읽어요. 워드(.docx), 파워포인트(.pptx), PDF, 텍스트(.txt)를 올려 주세요.');

    text = (text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('파일에서 글자를 찾지 못했어요. 스캔한 이미지 PDF는 글자를 읽을 수 없어요.');
    return text;
  }

  // ---------- 올린 원본 파일 보관 ----------
  // 원본 보기 화면에서 "원본 파일 열기"를 할 수 있게, 올린 파일을 이 브라우저의 IndexedDB에 넣어 둬요.
  // (localStorage는 글자만 담을 수 있어서 파일 자체는 IndexedDB를 써요. 서버로는 보내지 않아요.)
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('snip', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');      // 참고할 문서 원본들
        if (!db.objectStoreNames.contains('reading')) db.createObjectStore('reading');  // 지금 읽을 문서 원본 하나
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 새로 올린 파일들로 통째로 바꿔요. entries: [{ id, file }]
  async function saveOriginals(entries) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.clear();
      entries.forEach((e) => store.put(e.file, e.id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function getOriginal(id) {
    const db = await openDb();
    const file = await new Promise((resolve, reject) => {
      const req = db.transaction('files').objectStore('files').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return file;
  }

  // 지금 읽을 문서 원본 하나를 보관/꺼내기 (읽기 화면에서 원래 모양 그대로 보여주려고)
  async function saveReading(file) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('reading', 'readwrite');
      if (file) tx.objectStore('reading').put(file, 'current');
      else tx.objectStore('reading').delete('current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function getReading() {
    const db = await openDb();
    const file = await new Promise((resolve, reject) => {
      const req = db.transaction('reading').objectStore('reading').get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return file;
  }

  window.SnipFiles = { ACCEPT, readText, saveOriginals, getOriginal, saveReading, getReading };
})();
