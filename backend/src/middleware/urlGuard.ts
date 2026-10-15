/**
 * 自定义 apiUrl 协议安全校验（Phase 0 安全加固，D8 SSRF 收口）
 *
 * 策略（用户已拍板）：仅允许 http/https 协议；内网/本机地址允许——
 * 私有化单机部署场景下 EdgeTTS/MegaTTS 等自建 TTS 服务就跑在本机回环地址。
 * SSRF 主要攻击面（未登录匿名调用）由 requireAuth 收口，此处做协议层兜底。
 */

/** 返回不安全原因；null 表示安全（或未提供——由调用方决定是否走服务端配置回退） */
export function unsafeApiUrlReason(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'apiUrl 格式不正确';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'apiUrl 仅支持 http/https 协议';
  }
  return null;
}
