import { assertRuntime, ConfigError, loadEnvironment, readTranslationConfig } from './config.js';
import { COMPARISON_PRESETS } from './model-comparison.js';

const ALLOWED_CODES = new Set([
  'invalid_api_key', 'insufficient_quota', 'rate_limit_exceeded', 'model_not_found',
  'permission_denied', 'access_terminated', 'organization_deactivated',
]);
const MAX_BODY_BYTES = 16_384;

async function readMetadata(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown; }
    catch { return undefined; }
  } finally { reader.releaseLock(); }
}

function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' && ALLOWED_CODES.has(error.code) ? error.code : undefined;
}

async function checkModel(label: string, model: string, apiKey: string): Promise<boolean> {
  // GET model metadata only. Do not invoke transcription, Responses, or Discord.
  try {
    const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readMetadata(response);
    const code = errorCode(body);
    const suffix = `HTTP ${response.status}${code ? `, ${code}` : ''}`;
    if (response.ok) {
      if (typeof body !== 'object' || body === null || !('object' in body) || body.object !== 'model') {
        console.error(`FAIL ${label}: 모델 메타데이터 응답을 확인할 수 없습니다 (${suffix}).`);
        return false;
      }
      console.log(`PASS ${label}: 모델 메타데이터 조회 성공 (${suffix}).`);
      return true;
    }
    const hint = response.status === 401 ? '.env의 OPENAI_API_KEY가 유효한지 확인하세요.'
      : response.status === 403 ? '이 키·프로젝트의 모델 접근 권한을 확인하세요.'
      : response.status === 404 ? '설정한 모델 ID와 이 프로젝트의 사용 가능 여부를 확인하세요.'
      : response.status === 429 ? code === 'insufficient_quota'
        ? 'OpenAI API 결제·크레딧·프로젝트 사용 한도를 확인하세요.'
        : 'API 할당량 또는 요청 속도 제한을 확인하고 잠시 후 다시 시도하세요.'
      : response.status >= 500 ? 'OpenAI 서비스 응답 오류입니다. 잠시 후 다시 시도하세요.'
      : 'OpenAI 모델 조회 설정을 확인하세요.';
    console.error(`FAIL ${label}: ${hint} (${suffix})`);
    return false;
  } catch (error) {
    const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
    console.error(`FAIL ${label}: ${timeout ? '모델 조회가 10초 안에 완료되지 않았습니다.' : 'OpenAI 연결에 실패했습니다. 네트워크 연결을 확인하세요.'}`);
    return false;
  }
}

try {
  assertRuntime();
  loadEnvironment();
  const config = readTranslationConfig();
  if (!config) {
    console.error('API 확인을 하려면 .env에 TRANSLATION_ENABLED=true와 OPENAI_API_KEY를 설정하세요. 키를 채팅에 보내지 마세요.');
    process.exitCode = 1;
  } else {
    const results = await Promise.all([
      checkModel('STT', config.sttModel, config.apiKey),
      ...(config.reviewEnabled ? [checkModel('audio review', 'gpt-transcribe', config.apiKey)] : []),
      ...(['streaming', 'separate'].includes(config.captionMode) ? [checkModel('segmentation', config.segmentationModel, config.apiKey)] : []),
      ...(config.captionMode === 'compare'
        ? [...new Set(COMPARISON_PRESETS.map((item) => item.model))].map((model) => checkModel(model, model, config.apiKey))
        : [checkModel(config.captionMode === 'combined' ? 'interpretation' : 'translation', config.translationModel, config.apiKey)]),
    ]);
    process.exitCode = results.every(Boolean) ? 0 : 1;
    console.log('모델 조회만 수행했습니다. 실제 전사·문장 구분·번역의 성공 여부와 품질은 별도 통화 시험으로 확인해야 합니다.');
  }
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : 'API 확인 설정을 읽을 수 없습니다.');
  process.exitCode = 1;
}
