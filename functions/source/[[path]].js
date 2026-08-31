// 代理上游静态资源服务器 http://kt.ikui.vip:32001/source/*
// （游戏 defs 中的 img 字段指向该 HTTP 服务器；页面是 HTTPS，
//   浏览器会拦截 HTTPS 页面里的 HTTP 图片，必须经同源代理转发）
//
// 2026-08 链路变迁：
//  1. kt.ikui.vip 的 DNS 改指到 103.236.77.143，但 32001 端口（图片服务）
//     没迁移，仍只在旧 IP 203.135.99.28:32001 上运行
//  2. 旧 IP 的 32001 端口对 Cloudflare 边缘节点的 IP 段有访问控制
//    （实测：CF 边缘到旧 IP:80 返回 200，到旧 IP:32001 返回 521；
//      中国境内家庭宽带到 32001 正常）——上游刻意配置，外部无法改变
//  3. 因此回源改为走 lanxi（45.207.196.52，其 IP 在上游白名单内）上的
//     Docker 反代，经 Cloudflare Tunnel 暴露成 HTTPS：
//       页面 → /source/（本函数）→ lanxi tunnel → node 反代 → 旧 IP:32001
//
// 图片在 Cloudflare 边缘缓存 1 小时、浏览器缓存 1 小时：
//  - 重复访问几乎不再产生函数调用与回源请求
//  - 免费版影响：仅图标首次加载时消耗 Pages Functions 请求额度（10 万次/天）

const UPSTREAM_ORIGIN = 'https://temperature-doc-wearing-connecting.trycloudflare.com';
const TTL_SECONDS = 3600; // 1 小时
const RETRY_LIMIT = 4;    // 最多尝试 1+4 次
const RETRY_DELAY_MS = 200;
const ATTEMPT_TIMEOUT_MS = 8000; // 单次回源超过 8s 视为失败（经 tunnel 稍慢）

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);

  // 只允许 /source/ 前缀，避免变成开放代理
  if (!url.pathname.startsWith('/source/')) {
    return new Response('not found', { status: 404 });
  }

  const upstreamUrl = UPSTREAM_ORIGIN + url.pathname + url.search;

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  // 1. 边缘缓存命中直接返回
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('x-proxy-cache', 'HIT');
    return res;
  }

  // 2. 回源拉取（全新 GET，不带浏览器的条件请求头；失败自动重试）
  const upstream = await fetchWithRetry(upstreamUrl);

  if (!upstream || !upstream.ok) {
    const status = upstream ? upstream.status : 502;
    return new Response('upstream error ' + status, {
      status: status === 404 ? 404 : 502,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
  headers.set('cache-control', 'public, max-age=' + TTL_SECONDS);
  headers.set('x-proxy-cache', 'MISS');

  const res = new Response(upstream.body, { status: 200, headers });

  // 3. 写入边缘缓存
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// 上游连接偶发 522 超时，带退避重试 + 单次超时中断
async function fetchWithRetry(url) {
  let last = null;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      // cache: 'no-store' —— 绕过 Cloudflare 对子请求的默认缓存，
      // 否则上游偶发的 5xx 错误会被边缘缓存住，重试也一直拿到缓存的错误
      //（注意：不能同时设置 cf.cacheTtl，两者不兼容会让 fetch 直接抛错）
      const res = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
      });
      // 5xx（含 Cloudflare 生成的 522 超时）视为本次失败，重试
      if (res.status >= 500) {
        last = res;
        continue;
      }
      return res;
    } catch (err) {
      last = null; // 网络异常/超时中断同样重试
    } finally {
      clearTimeout(timer);
    }
  }
  return last || null;
}
