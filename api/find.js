// 백엔드(주방): 드래그한 문장을 받아 AI에게 관련 부분을 찾아 달라고 부탁하는 곳이에요.
// 브라우저는 /api/find 로 주문을 넣고, 여기서 Claude API를 불러 결과를 돌려줘요.
// AI 열쇠(ANTHROPIC_API_KEY)는 Vercel 설정에만 넣어 두고, 코드에는 절대 적지 않아요.

import Anthropic from '@anthropic-ai/sdk';
import { SAMPLE_DOCS } from '../data/samples.js';

// 너무 긴 글이 들어오면 비용이 커지니 길이를 제한해요.
const MAX_SENTENCE = 1000;
const MAX_DOC = 20000;
const MAX_LIBRARY_DOCS = 30;
const MAX_LIBRARY_CHARS = 130000;

const SYSTEM = `당신은 문서를 읽는 사람을 돕는 리서치 비서입니다. 사용자는 기획자, 학생, 연구자 등 누구든 될 수 있습니다.
사용자는 지금 읽고 있는 문서에서 궁금한 문장 하나를 골랐습니다.
시스템 안내 끝의 "참고 자료" 문서들 중에서 그 문장과 실제로 관련 있는 문단을 찾아 주세요.

규칙:
- 관련성이 높은 순서로 최대 3곳만 고르세요. 정말 관련 있는 곳이 없으면 빈 목록을 돌려주세요.
- 문단은 참고 자료에 있는 번호(file_index, paragraph_index)로 정확히 가리키세요. 내용을 지어내지 마세요.
- why: 그 문단이 고른 문장과 왜 관련 있는지 한 문장으로, 구체적인 숫자나 결정 사항을 짚어서 쓰세요.
- tip: 사용자가 지금 읽는 문서에 대응할 때 그 문단을 어떻게 참고하면 좋을지 한두 문장으로 제안하세요.
- 모두 한국어로, 함께 일하는 동료에게 말하듯 간결하게 쓰세요.
- 반드시 report_results 도구로 답하세요.`;

const REPORT_TOOL = {
  name: 'report_results',
  description: '찾아낸 관련 문단 목록을 돌려줍니다.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file_index: { type: 'integer' },
            paragraph_index: { type: 'integer' },
            why: { type: 'string' },
            tip: { type: 'string' },
          },
          required: ['file_index', 'paragraph_index', 'why', 'tip'],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false,
  },
};

function libraryText(docs) {
  return docs
    .map((doc, f) =>
      [`<file index="${f}" name="${doc.name}">`]
        .concat(doc.paragraphs.map((p, i) => `[${i}] ${p}`))
        .concat('</file>')
        .join('\n'),
    )
    .join('\n\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST로만 주문할 수 있어요.' });
    return;
  }

  const { sentence, docTitle = '', docText = '', library } = req.body || {};
  if (typeof sentence !== 'string' || !sentence.trim()) {
    res.status(400).json({ error: '드래그한 문장이 비어 있어요.' });
    return;
  }
  if (sentence.length > MAX_SENTENCE || String(docText).length > MAX_DOC) {
    res.status(400).json({ error: '문장이나 문서가 너무 길어요. 조금 줄여서 다시 해 주세요.' });
    return;
  }

  // 드라이브에서 읽어 온 문서가 오면 그걸 쓰고, 없으면 예시 기획안을 써요.
  let docs = SAMPLE_DOCS;
  if (Array.isArray(library) && library.length) {
    const clean = library
      .filter((d) => d && typeof d.name === 'string' && Array.isArray(d.paragraphs))
      .map((d) => ({
        id: typeof d.id === 'string' ? d.id : '',
        name: d.name,
        link: typeof d.link === 'string' && d.link.startsWith('https://') ? d.link : '',
        paragraphs: d.paragraphs.filter((p) => typeof p === 'string'),
      }));
    const chars = clean.reduce((n, d) => n + d.paragraphs.join('\n').length, 0);
    if (clean.length > MAX_LIBRARY_DOCS || chars > MAX_LIBRARY_CHARS) {
      res.status(400).json({ error: '연결한 문서가 너무 많거나 길어요. 더 작은 폴더를 골라 주세요.' });
      return;
    }
    if (clean.length) docs = clean;
  }
  const userText = `<지금 읽는 문서 제목>${docTitle}</지금 읽는 문서 제목>
<지금 읽는 문서>\n${docText}\n</지금 읽는 문서>

<고른 문장>${sentence.trim()}</고른 문장>`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.trim() });
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // AI가 안전상의 이유로 답을 거절하면, 다른 모델로 자동으로 다시 시도해요.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      // 참고 자료는 같은 폴더로 여러 번 찾을 때 다시 읽지 않도록 캐시해 두어 비용을 아껴요.
      system: [
        { type: 'text', text: SYSTEM },
        {
          type: 'text',
          text: `<참고 자료>\n${libraryText(docs)}\n</참고 자료>`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: userText }],
    });

    if (response.stop_reason === 'refusal') {
      res.status(422).json({ error: '이 문장으로는 찾기를 할 수 없어요. 다른 문장을 골라 주세요.' });
      return;
    }

    const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'report_results');
    const raw = call && Array.isArray(call.input?.results) ? call.input.results : [];

    // AI가 가리킨 번호가 실제로 있는지 확인하고, 화면에 필요한 모양으로 바꿔요.
    const results = raw
      .filter((r) => docs[r.file_index] && docs[r.file_index].paragraphs[r.paragraph_index])
      .slice(0, 3)
      .map((r) => {
        const doc = docs[r.file_index];
        return {
          id: doc.id || '',
          file: doc.name,
          link: doc.link || '',
          paragraphs: doc.paragraphs,
          index: r.paragraph_index,
          excerpt: doc.paragraphs[r.paragraph_index],
          why: r.why,
          tip: r.tip,
        };
      });

    res.status(200).json({ results });
  } catch (error) {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(500).json({ error: 'AI 열쇠(API 키)가 아직 설정되지 않았어요. Vercel 설정에 ANTHROPIC_API_KEY를 넣어 주세요.' });
    } else if (error instanceof Anthropic.AuthenticationError) {
      res.status(500).json({ error: 'AI 열쇠(API 키)가 맞지 않아요. Vercel 설정의 ANTHROPIC_API_KEY를 확인해 주세요.' });
    } else if (error instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: '요청이 잠깐 몰렸어요. 조금 뒤에 다시 눌러 주세요.' });
    } else if (error instanceof Anthropic.APIError) {
      console.error('Claude API error', error.status, error.message);
      res.status(502).json({ error: 'AI 쪽에서 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.' });
    } else {
      console.error(error);
      res.status(500).json({ error: '알 수 없는 문제가 생겼어요.' });
    }
  }
}
