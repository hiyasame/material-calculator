// 代理上游游戏数据接口 http://kt.ikui.vip/api/data/defs
// 并在 Cloudflare 边缘缓存 5 分钟：
//  - 用户每次访问拿到的都是不超过 5 分钟的实时数据（浏览器还会再缓存 5 分钟）
//  - 上游 kt.ikui.vip 每个边缘节点最多每 5 分钟被回源 1 次，压力可忽略
//  - 免费版影响：Pages Functions 免费额度 10 万次请求/天，每次页面访问仅 1 次
// 上游从部分 Cloudflare 边缘节点连接偶发超时（522），故带自动重试

const UPSTREAM_URL = 'http://kt.ikui.vip/api/data/defs';
const TTL_SECONDS = 300; // 5 分钟
const RETRY_LIMIT = 4;   // 最多尝试 1+4 次
const RETRY_DELAY_MS = 150;

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  // 1. 先查 Cloudflare 边缘缓存
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('x-proxy-cache', 'HIT');
    return res;
  }

  // 2. 缓存未命中，回源拉取（失败自动重试）
  const upstream = await fetchWithRetry();

  if (!upstream || !upstream.ok) {
    const status = upstream ? upstream.status : 502;
    return jsonResponse({ ok: false, error: 'upstream_status_' + status }, 502);
  }

  const body = await upstream.text();
  const res = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + TTL_SECONDS,
      'x-proxy-cache': 'MISS',
    },
  });

  // 3. 写入边缘缓存（cache.put 遵循响应头的 max-age 作为过期时间）
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// 上游连接偶发 522 超时，带退避重试
async function fetchWithRetry() {
  let last = null;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
    try {
      // cache: 'no-store' —— 绕过 Cloudflare 对子请求的默认缓存，
      // 避免上游偶发错误被边缘缓存；缓存完全由下方 caches.default 显式管理
      //（注意：不能同时设置 cf.cacheTtl，两者不兼容会让 fetch 直接抛错）
      const res = await fetch(UPSTREAM_URL, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (res.status >= 500) {
        last = res;
        continue;
      }
      return res;
    } catch (err) {
      last = null; // 网络异常同样重试
    }
  }
  return last || null;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
