// 여러 화면이 함께 쓰는 "지금 하는 작업" 도우미예요.
// - 읽을 문서와 참고 문서함을 이 브라우저에 보관해서, 단계를 오가거나 다음에 다시 와도 이어서 할 수 있어요.
// - 화면 맨 위의 단계 표시(① 읽을 문서 ② 읽으며 찾기)를 그려요. 눌러서 자유롭게 오가요.
// js/google.js 다음에 불러와야 해요. (참고 문서함은 SnipGoogle이 보관해요)

(function () {
  const DOC_KEY = 'snip-doc';

  function getDoc() {
    try {
      return JSON.parse(localStorage.getItem(DOC_KEY)) || JSON.parse(sessionStorage.getItem(DOC_KEY));
    } catch (e) {
      return null;
    }
  }

  function setDoc(doc) {
    // 예시로 해 보다가 내 문서를 넣으면, 예시 참고 문서는 빼요.
    if (!doc.sample && window.SnipGoogle) {
      const lib = SnipGoogle.getLibrary();
      if (lib && lib.sample) SnipGoogle.clearLibrary();
    }
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify(doc));
    } catch (e) {
      // 너무 커서 오래 보관하지 못하면, 이 탭에서만이라도 쓰게 해요.
      try { sessionStorage.setItem(DOC_KEY, JSON.stringify(doc)); } catch (e2) {}
    }
    try { sessionStorage.removeItem('snip-results'); sessionStorage.removeItem('snip-page'); } catch (e) {}
    // 다른 문서를 읽기 시작하면 예전 문서에서 모아 둔 참고 내용은 비워요.
    try { localStorage.removeItem('snip-picks'); } catch (e) {}
  }

  // 처음부터 새로 시작할 때 써요. 읽을 문서, 참고 문서함, 찾은 결과를 모두 비워요.
  function clearAll() {
    [localStorage, sessionStorage].forEach((s) => {
      try { s.removeItem(DOC_KEY); } catch (e) {}
    });
    try { sessionStorage.removeItem('snip-results'); sessionStorage.removeItem('snip-page'); localStorage.removeItem('snip-picks'); } catch (e) {}
    if (window.SnipGoogle) SnipGoogle.clearLibrary();
  }

  function libraryCount() {
    const lib = window.SnipGoogle && SnipGoogle.getLibrary();
    return lib && lib.docs ? lib.docs.length : 0;
  }

  // 예시로 먼저 해 보기: 문서를 넣지 않아도 예시 피드백 문서와 예시 참고 문서로 바로 드래그해 볼 수 있어요.
  async function startSample() {
    const { SAMPLE_DOCS } = await import('../data/samples.js');
    clearAll();
    setDoc({
      title: '3분기 기획안 피드백 (예시)',
      sample: true,
      text: [
        '3분기 기획안 피드백 (예시)',
        '전체적인 방향은 좋습니다. 다만 신규 사용자 관점에서 몇 가지 보완이 필요해 보입니다.',
        '신규 회원 온보딩 단계를 줄이는 방안을 검토해 주세요.',
        '또한 경쟁 서비스 대비 차별점이 첫 화면에서 잘 드러나지 않습니다. 첫 화면에서 무엇을 해야 하는지 바로 보이도록 정리가 필요합니다.',
        '지난 프로모션 결과도 함께 참고해서, 이번 분기 목표 수치를 다시 잡아 주세요.',
        '일정은 다음 주 화요일 회의에서 확정하겠습니다.',
      ].join('\n\n'),
    });
    SnipGoogle.saveLibrary({
      docs: SAMPLE_DOCS.map((d, i) => ({ id: 'sample-' + i, name: d.name, link: '', paragraphs: d.paragraphs })),
      sample: true,
      at: Date.now(),
    });
    location.href = 'reader.html';
  }

  // 단계 표시를 그려요. current: 지금 화면의 단계 (1: 읽을 문서, 2: 읽으며 찾기)
  function renderSteps(nav, current) {
    const doc = getDoc();
    const refs = libraryCount();
    const steps = [
      {
        n: 1, href: 'upload.html', title: '읽을 문서',
        hint: '지금 읽는 문서 1개',
        done: doc && doc.text ? doc.title : '',
      },
      {
        n: 2, href: 'reader.html', title: '읽으며 찾기',
        hint: '참고 문서를 넣고 문장을 드래그해요',
        done: refs ? '참고 문서 ' + refs + '개' : '',
        locked: !(doc && doc.text),
      },
    ];
    nav.innerHTML = '';
    nav.classList.add('stepper');
    nav.setAttribute('aria-label', '진행 단계');
    steps.forEach((s) => {
      const item = document.createElement(s.locked || s.n === current ? 'span' : 'a');
      item.className = 'stp' + (s.n === current ? ' now' : '') + (s.done ? ' done' : '') + (s.locked ? ' locked' : '');
      if (item.tagName === 'A') item.href = s.href;
      if (s.n === current) item.setAttribute('aria-current', 'step');
      if (s.locked) item.title = '먼저 읽을 문서를 넣어 주세요';
      const num = document.createElement('span');
      num.className = 'stp-num';
      num.textContent = s.done && s.n !== current ? '✓' : String(s.n);
      const text = document.createElement('span');
      text.className = 'stp-text';
      const b = document.createElement('b');
      b.textContent = s.title;
      const small = document.createElement('small');
      small.textContent = s.done || s.hint;
      text.append(b, small);
      item.append(num, text);
      nav.appendChild(item);
    });
  }

  window.SnipWork = { getDoc, setDoc, clearAll, libraryCount, startSample, renderSteps };
})();
