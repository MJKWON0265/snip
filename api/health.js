// 점검용 주소(/api/health): 주방이 AI 열쇠를 찾을 수 있는지 확인해요.
// 열쇠 값은 절대 보여주지 않고, "있다/없다"와 모양이 맞는지만 알려줘요.

export default function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  const similar = Object.keys(process.env).filter(
    (name) => name !== 'ANTHROPIC_API_KEY' && name.toUpperCase().includes('ANTHROPIC'),
  );

  res.status(200).json({
    열쇠_있음: Boolean(key),
    열쇠_모양_정상: Boolean(key && key.trim().startsWith('sk-ant-')),
    열쇠_앞뒤_공백: Boolean(key && key !== key.trim()),
    비슷한_이름: similar,
    배포_환경: process.env.VERCEL_ENV || '알 수 없음',
    배포_버전: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || '알 수 없음',
  });
}
