// 내 컴퓨터 파일(워드·PDF·텍스트)에서 글자만 꺼내는 도우미예요. 여러 화면이 함께 써요.
// 파일은 서버로 보내지 않고, 이 브라우저 안에서만 읽어요.

(function () {
  const ACCEPT = '.docx,.pdf,.txt,.md';

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

  // 파일 하나를 읽어서 정리된 글자를 돌려줘요. 못 읽으면 이유를 담은 오류를 내요.
  async function readText(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    let text;
    if (ext === 'docx') text = await readDocx(file);
    else if (ext === 'pdf') text = await readPdf(file);
    else if (ext === 'txt' || ext === 'md') text = await file.text();
    else if (ext === 'doc' || ext === 'hwp') throw new Error('예전 워드(.doc)와 한글(.hwp)은 아직 못 읽어요. .docx나 PDF로 저장해서 올려 주세요.');
    else throw new Error('이 파일 형식은 아직 못 읽어요. 워드(.docx), PDF, 텍스트(.txt)를 올려 주세요.');

    text = (text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('파일에서 글자를 찾지 못했어요. 스캔한 이미지 PDF는 글자를 읽을 수 없어요.');
    return text;
  }

  window.SnipFiles = { ACCEPT, readText };
})();
