// 읽을 문서를 원래 모양 그대로 보여주는 뷰어예요. 읽기 화면에서 써요.
// - PDF: 쪽마다 원래 모양을 그리고, 그 위에 투명한 글자 층을 깔아서 드래그할 수 있게 해요. 쪽을 넘겨 봐요.
// - 파워포인트(.pptx): 슬라이드 안의 글상자·그림·표를 원래 자리에 놓아서 슬라이드 모양으로 보여줘요. 넘겨 봐요.
// - 워드(.docx): 제목·굵게·목록·표·그림을 살려서 종이 모양으로 보여줘요. 위아래로 스크롤해요.
// 파일은 서버로 보내지 않고 이 브라우저 안에서만 그려요.

(function () {
  const PDF_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
  const EMU_PX = 9525; // 파워포인트 길이 단위(EMU)를 화면 픽셀로 바꾸는 값

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('문서 보기 도구를 불러오지 못했어요.'));
      document.head.appendChild(s);
    });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 쪽 넘기기 버튼 묶음을 만들어요. go(n)을 부르면 n쪽(1부터)을 그려요.
  function makePager(nav, total, go) {
    nav.innerHTML = '';
    nav.hidden = false;
    const prev = el('button', 'pg-btn', '◀ 이전');
    const info = el('span', 'pg-info');
    const next = el('button', 'pg-btn', '다음 ▶');
    prev.type = next.type = 'button';
    nav.append(prev, info, next);
    let current = 1;
    async function show(n) {
      current = Math.min(Math.max(1, n), total);
      info.textContent = current + ' / ' + total;
      prev.disabled = current === 1;
      next.disabled = current === total;
      await go(current);
    }
    prev.addEventListener('click', () => show(current - 1));
    next.addEventListener('click', () => show(current + 1));
    // 키보드 ← → 로도 넘겨요. (글자를 입력하는 칸에서는 무시해요)
    document.addEventListener('keydown', (e) => {
      if (/input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') show(current - 1);
      if (e.key === 'ArrowRight') show(current + 1);
    });
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => go(current), 250);
    });
    return show(1);
  }

  // ---------- PDF ----------
  async function renderPdf(file, body, nav) {
    await loadScript('vendor/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({
      data: await file.arrayBuffer(),
      cMapUrl: PDF_CDN + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDF_CDN + 'standard_fonts/',
    }).promise;

    let drawing = 0;
    async function go(n) {
      const ticket = ++drawing;
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const width = Math.max(280, body.clientWidth);
      const viewport = page.getViewport({ scale: width / base.width });
      const dpr = window.devicePixelRatio || 1;

      const wrap = el('div', 'pdf-page');
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      const textLayer = el('div', 'textLayer');
      textLayer.style.setProperty('--scale-factor', viewport.scale);
      wrap.append(canvas, textLayer);

      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      await pdfjsLib.renderTextLayer({
        textContentSource: await page.getTextContent(),
        container: textLayer,
        viewport,
        textDivs: [],
      }).promise;
      if (ticket !== drawing) return; // 그리는 사이 다른 쪽으로 넘겼으면 버려요.
      body.innerHTML = '';
      body.appendChild(wrap);
    }
    return makePager(nav, pdf.numPages, go);
  }

  // ---------- 워드(.docx) ----------
  async function renderDocx(file, body) {
    await loadScript('vendor/mammoth.browser.min.js');
    const result = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      { styleMap: ["p[style-name='Title'] => h1.doc-title:fresh", "p[style-name='Subtitle'] => h2:fresh", "p[style-name='제목'] => h1.doc-title:fresh"] },
    );
    const paper = el('div', 'docx-page');
    paper.innerHTML = result.value; // mammoth가 만든 HTML (스크립트는 들어 있지 않아요)
    paper.querySelectorAll('script').forEach((s) => s.remove());
    body.innerHTML = '';
    body.appendChild(paper);
  }

  // ---------- 파워포인트(.pptx) ----------
  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }
  function kids(node, tag) {
    return node ? Array.from(node.children).filter((c) => c.tagName === tag) : [];
  }
  function kid(node, tag) {
    return kids(node, tag)[0] || null;
  }
  function find(node, tag) {
    return node ? node.getElementsByTagName(tag)[0] || null : null;
  }
  function resolvePath(baseFile, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = baseFile.split('/').slice(0, -1);
    target.split('/').forEach((p) => {
      if (p === '..') parts.pop();
      else if (p !== '.') parts.push(p);
    });
    return parts.join('/');
  }

  async function renderPptx(file, body, nav) {
    await loadScript('vendor/jszip.min.js');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const xmlCache = {};
    async function xml(path) {
      if (!(path in xmlCache)) {
        const f = zip.file(path);
        xmlCache[path] = f ? parseXml(await f.async('string')) : null;
      }
      return xmlCache[path];
    }
    async function rels(path) {
      const relPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
      const doc = await xml(relPath);
      const map = {};
      if (doc) {
        Array.from(doc.getElementsByTagName('Relationship')).forEach((r) => {
          map[r.getAttribute('Id')] = {
            type: r.getAttribute('Type') || '',
            target: r.getAttribute('TargetMode') === 'External' ? null : resolvePath(path, r.getAttribute('Target')),
          };
        });
      }
      return map;
    }

    // 슬라이드 크기와 순서
    const pres = await xml('ppt/presentation.xml');
    const presRels = await rels('ppt/presentation.xml');
    const size = find(pres, 'p:sldSz');
    const W = size ? Number(size.getAttribute('cx')) / EMU_PX : 960;
    const H = size ? Number(size.getAttribute('cy')) / EMU_PX : 540;
    let slidePaths = Array.from(pres ? pres.getElementsByTagName('p:sldId') : [])
      .map((s) => presRels[s.getAttribute('r:id')])
      .filter((r) => r && r.target)
      .map((r) => r.target);
    if (!slidePaths.length) {
      slidePaths = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
    }
    if (!slidePaths.length) throw new Error('슬라이드를 찾지 못했어요.');

    // 테마 색 (글자색·배경색이 "테마 색 1번"처럼 적혀 있을 때 실제 색으로 바꾸려고 읽어요)
    const theme = {};
    const themePath = Object.keys(zip.files).find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
    const themeDoc = themePath ? await xml(themePath) : null;
    const scheme = find(themeDoc, 'a:clrScheme');
    if (scheme) {
      Array.from(scheme.children).forEach((c) => {
        const srgb = find(c, 'a:srgbClr');
        const sys = find(c, 'a:sysClr');
        const name = c.tagName.replace('a:', '');
        if (srgb) theme[name] = '#' + srgb.getAttribute('val');
        else if (sys) theme[name] = '#' + (sys.getAttribute('lastClr') || '000000');
      });
    }
    const alias = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
    function color(node) {
      if (!node) return null;
      const srgb = find(node, 'a:srgbClr');
      if (srgb) return '#' + srgb.getAttribute('val');
      const sc = find(node, 'a:schemeClr');
      if (sc) {
        const v = sc.getAttribute('val');
        return theme[alias[v] || v] || null;
      }
      return null;
    }
    function fillOf(spPr) {
      if (!spPr || kid(spPr, 'a:noFill')) return null;
      const solid = kid(spPr, 'a:solidFill');
      return solid ? color(solid) : null;
    }

    // 자리표시자(제목·본문 칸)는 위치가 슬라이드 대신 레이아웃/마스터에 적혀 있을 때가 많아서 찾아와요.
    function phInfo(sp) {
      const ph = find(kid(sp, 'p:nvSpPr') || kid(sp, 'p:nvPicPr') || sp, 'p:ph');
      if (!ph) return null;
      return { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') };
    }
    function findPh(doc, info) {
      if (!doc || !info) return null;
      const all = Array.from(doc.getElementsByTagName('p:sp'));
      const same = (t) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' ? 'body' : t);
      return (
        (info.idx && all.find((s) => { const p = phInfo(s); return p && p.idx === info.idx; })) ||
        all.find((s) => { const p = phInfo(s); return p && same(p.type) === same(info.type); }) ||
        null
      );
    }
    function xfrmOf(node) {
      const spPr = kid(node, 'p:spPr') || kid(node, 'p:grpSpPr');
      const x = (spPr && kid(spPr, 'a:xfrm')) || kid(node, 'p:xfrm');
      if (!x) return null;
      const off = kid(x, 'a:off');
      const ext = kid(x, 'a:ext');
      if (!off || !ext) return null;
      return {
        x: Number(off.getAttribute('x')) / EMU_PX,
        y: Number(off.getAttribute('y')) / EMU_PX,
        w: Number(ext.getAttribute('cx')) / EMU_PX,
        h: Number(ext.getAttribute('cy')) / EMU_PX,
        rot: Number(x.getAttribute('rot') || 0) / 60000,
        node: x,
      };
    }

    function textBox(txBody, defaults) {
      const box = el('div', 'pp-text');
      const bodyPr = kid(txBody, 'a:bodyPr');
      const anchor = (bodyPr && bodyPr.getAttribute('anchor')) || defaults.anchor || 't';
      box.style.justifyContent = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
      kids(txBody, 'a:p').forEach((p) => {
        const pPr = kid(p, 'a:pPr');
        const line = el('div', 'pp-p');
        const algn = pPr && pPr.getAttribute('algn');
        if (algn) line.style.textAlign = { ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left';
        else if (defaults.align) line.style.textAlign = defaults.align;
        const lvl = Number((pPr && pPr.getAttribute('lvl')) || 0);
        const runs = Array.from(p.children).filter((c) => c.tagName === 'a:r' || c.tagName === 'a:fld' || c.tagName === 'a:br');
        let text = '';
        runs.forEach((r) => { text += r.tagName === 'a:br' ? '\n' : (find(r, 'a:t') || { textContent: '' }).textContent; });
        const bullet = defaults.bullets && text.trim() && !(pPr && kid(pPr, 'a:buNone'));
        if (bullet) {
          line.style.paddingLeft = (1.2 + lvl * 1.4) + 'em';
          line.style.textIndent = '-0.9em';
          line.appendChild(document.createTextNode('• '));
        } else if (lvl) {
          line.style.paddingLeft = lvl * 1.4 + 'em';
        }
        let maxSize = 0;
        runs.forEach((r) => {
          if (r.tagName === 'a:br') { line.appendChild(document.createElement('br')); return; }
          const rPr = kid(r, 'a:rPr');
          const span = el('span', null, (find(r, 'a:t') || { textContent: '' }).textContent);
          const sz = rPr && rPr.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : defaults.size;
          maxSize = Math.max(maxSize, sz);
          span.style.fontSize = (sz * 4) / 3 + 'px';
          if (rPr && rPr.getAttribute('b') === '1') span.style.fontWeight = '700';
          if (rPr && rPr.getAttribute('i') === '1') span.style.fontStyle = 'italic';
          if (rPr && rPr.getAttribute('u') && rPr.getAttribute('u') !== 'none') span.style.textDecoration = 'underline';
          const c = rPr && color(kid(rPr, 'a:solidFill'));
          if (c) span.style.color = c;
          line.appendChild(span);
        });
        if (!runs.length) {
          const end = kid(p, 'a:endParaRPr');
          const sz = end && end.getAttribute('sz') ? Number(end.getAttribute('sz')) / 100 : defaults.size;
          line.style.minHeight = (sz * 4) / 3 + 'px';
        }
        if (maxSize) line.style.fontSize = (maxSize * 4) / 3 + 'px';
        box.appendChild(line);
      });
      return box;
    }

    async function drawSlide(path) {
      const slide = await xml(path);
      const sRels = await rels(path);
      const layoutPath = Object.values(sRels).find((r) => r.type.endsWith('/slideLayout'));
      const layout = layoutPath ? await xml(layoutPath.target) : null;
      const lRels = layoutPath ? await rels(layoutPath.target) : {};
      const masterPath = Object.values(lRels).find((r) => r.type.endsWith('/slideMaster'));
      const master = masterPath ? await xml(masterPath.target) : null;

      const stage = el('div', 'pp-slide');
      stage.style.width = W + 'px';
      stage.style.height = H + 'px';
      // 배경: 슬라이드 → 레이아웃 → 마스터 순서로 찾아요.
      for (const d of [slide, layout, master]) {
        const bg = find(d, 'p:bg');
        const c = bg && color(bg);
        if (c) { stage.style.background = c; break; }
      }
      stage.style.color = theme.dk1 || '#222';

      async function place(node, map) {
        const tag = node.tagName;
        if (tag === 'p:grpSp') {
          const g = xfrmOf(node);
          let inner = map;
          if (g) {
            const ch = { x: Number((kid(g.node, 'a:chOff') || g.node).getAttribute('x') || 0) / EMU_PX, y: Number((kid(g.node, 'a:chOff') || g.node).getAttribute('y') || 0) / EMU_PX };
            const che = kid(g.node, 'a:chExt');
            const sx = che && Number(che.getAttribute('cx')) ? g.w / (Number(che.getAttribute('cx')) / EMU_PX) : 1;
            const sy = che && Number(che.getAttribute('cy')) ? g.h / (Number(che.getAttribute('cy')) / EMU_PX) : 1;
            inner = (b) => map({ x: g.x + (b.x - ch.x) * sx, y: g.y + (b.y - ch.y) * sy, w: b.w * sx, h: b.h * sy, rot: b.rot });
          }
          for (const c of Array.from(node.children)) await place(c, inner);
          return;
        }
        if (!['p:sp', 'p:pic', 'p:graphicFrame', 'p:cxnSp'].includes(tag)) return;

        const ph = phInfo(node);
        let box = xfrmOf(node);
        if (!box && ph) {
          const fromLayout = findPh(layout, ph);
          const fromMaster = findPh(master, ph);
          box = (fromLayout && xfrmOf(fromLayout)) || (fromMaster && xfrmOf(fromMaster)) || null;
        }
        if (!box) return;
        const b = map(box);
        const div = el('div', 'pp-shape');
        Object.assign(div.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
        if (box.rot) div.style.transform = 'rotate(' + box.rot + 'deg)';

        if (tag === 'p:pic') {
          const blip = find(node, 'a:blip');
          const rel = blip && sRels[blip.getAttribute('r:embed')];
          const f = rel && rel.target && zip.file(rel.target);
          if (f) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(await f.async('blob'));
            img.alt = '';
            div.appendChild(img);
          }
        } else if (tag === 'p:graphicFrame') {
          const tbl = find(node, 'a:tbl');
          if (tbl) {
            const table = el('table', 'pp-table');
            kids(tbl, 'a:tr').forEach((tr) => {
              const row = document.createElement('tr');
              kids(tr, 'a:tc').forEach((tc) => {
                if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') return;
                const td = document.createElement('td');
                if (tc.getAttribute('gridSpan')) td.colSpan = Number(tc.getAttribute('gridSpan'));
                if (tc.getAttribute('rowSpan')) td.rowSpan = Number(tc.getAttribute('rowSpan'));
                const fill = fillOf(kid(tc, 'a:tcPr'));
                if (fill) td.style.background = fill;
                const tx = kid(tc, 'a:txBody');
                if (tx) td.appendChild(textBox(tx, { size: 12 }));
                row.appendChild(td);
              });
              table.appendChild(row);
            });
            div.appendChild(table);
          } else {
            div.classList.add('pp-missing');
            div.textContent = '차트·도형 묶음은 여기서는 보이지 않아요';
          }
        } else {
          const spPr = kid(node, 'p:spPr');
          const fill = fillOf(spPr);
          if (fill) div.style.background = fill;
          const ln = spPr && kid(spPr, 'a:ln');
          const lc = ln && !kid(ln, 'a:noFill') && color(kid(ln, 'a:solidFill'));
          if (lc) div.style.border = '1px solid ' + lc;
          const geom = spPr && kid(spPr, 'a:prstGeom');
          if (geom && geom.getAttribute('prst') === 'ellipse') div.style.borderRadius = '50%';
          if (geom && geom.getAttribute('prst') === 'roundRect') div.style.borderRadius = '12px';
          const tx = kid(node, 'p:txBody');
          if (tx) {
            const type = ph ? ph.type : '';
            const isTitle = type === 'title' || type === 'ctrTitle';
            div.appendChild(textBox(tx, {
              size: type === 'ctrTitle' ? 44 : isTitle ? 32 : type === 'subTitle' ? 22 : ph ? 20 : 18,
              anchor: isTitle ? 'ctr' : null,
              align: type === 'ctrTitle' || type === 'subTitle' ? 'center' : null,
              bullets: type === 'body' || type === 'obj',
            }));
          }
        }
        stage.appendChild(div);
      }

      const tree = find(slide, 'p:spTree');
      const identity = (b) => b;
      if (tree) for (const c of Array.from(tree.children)) await place(c, identity);
      return stage;
    }

    let drawing = 0;
    async function go(n) {
      const ticket = ++drawing;
      const stage = await drawSlide(slidePaths[n - 1]);
      if (ticket !== drawing) return;
      // 슬라이드를 원래 크기로 그린 뒤, 읽기 칸 폭에 맞게 줄이거나 늘려요.
      const scale = Math.max(280, body.clientWidth) / W;
      const frame = el('div', 'pp-frame');
      frame.style.width = W * scale + 'px';
      frame.style.height = H * scale + 'px';
      stage.style.transform = 'scale(' + scale + ')';
      frame.appendChild(stage);
      body.innerHTML = '';
      body.appendChild(frame);
    }
    return makePager(nav, slidePaths.length, go);
  }

  // 파일 종류에 맞는 뷰어로 그려요. 원래 모양으로 못 그리는 종류면 false를 돌려줘요.
  async function render(file, body, nav) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf') { await renderPdf(file, body, nav); return true; }
    if (ext === 'pptx') { await renderPptx(file, body, nav); return true; }
    if (ext === 'docx') { await renderDocx(file, body); return true; }
    return false;
  }

  window.SnipViewer = { render };
})();
