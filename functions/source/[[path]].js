// 代理上游静态资源服务器 http://203.135.99.28:32001/source/*
// （游戏 defs 中的 img 字段指向该 HTTP 服务器；页面是 HTTPS，
//   浏览器会拦截 HTTPS 页面里的 HTTP 图片，必须经同源代理转发）
//
// 链路变迁史：
//  1. kt.ikui.vip 的 DNS 改指到 103.236.77.143，但 32001 端口（图片服务）
//     没迁移，仍只在旧 IP 203.135.99.28:32001 上运行
//  2. 旧 IP 的 32001 端口对 Cloudflare 边缘节点的 IP 段有访问控制
//    （实测：CF 边缘到旧 IP:80 返回 200，到旧 IP:32001 返回 521；
//      中国境内家庭宽带到 32001 正常）——上游刻意配置，外部无法改变
//  3. 因此回源改为走 lanxi（45.207.196.52，其 IP 在上游白名单内）上的
//     Docker 反代，经 Cloudflare quick tunnel 暴露成 HTTPS：
//       页面 → /source/（本函数）→ lanxi tunnel → node 反代 → 旧 IP:32001
//  4. 2026-09-01：quick tunnel 域名失效（trycloudflare 临时域名随 cloudflared
//     重启即更换，DNS 直接 NXDOMAIN），本函数所有回源失败、全量 502，
//     页面全部回退本地 icons/——而本地镜像缺新物品图标，新装备贴图空白。
//     因此改为多源回退：任一候选源可用即可恢复，直连旧 IP 始终作为兜底
//    （若上游日后放行 CF 边缘 IP，则无需隧道也能工作）。
//
// 图片在 Cloudflare 边缘缓存 1 小时、浏览器缓存 1 小时：
//  - 重复访问几乎不再产生函数调用与回源请求
//  - 免费版影响：仅图标首次加载时消耗 Pages Functions 请求额度（10 万次/天）

// 回源候选（按顺序尝试，第一个返回 2xx 且 content-type 为 image/* 的生效）。
// lanxi 隧道域名是临时的：cloudflared 重启会换新域名。失效时可用两种方式更新：
//   a) 在 Cloudflare Pages 项目环境变量里设置 IMAGE_PROXY_ORIGIN 为新隧道地址（免改代码）
//   b) 直接修改下面 DEFAULT_ORIGINS 的第一项后重新部署
const DEFAULT_ORIGINS = [
  'https://nebraska-synthetic-customise-carlo.trycloudflare.com', // lanxi quick tunnel（2026-09-01 重启后新域名）
  'http://203.135.99.28:32001', // 直连旧 IP（被上游 ACL 拦 CF 边缘，返回 403/521，保留兜底）
];

const TTL_SECONDS = 3600; // 1 小时
const ATTEMPTS_PER_ORIGIN = 2; // 每个源最多尝试 2 次（DNS 失败/521 都快速失败）
const ATTEMPT_TIMEOUT_MS = 6000; // 单次回源超过 6s 视为失败

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);

  // 只允许 /source/ 前缀，避免变成开放代理
  if (!url.pathname.startsWith('/source/')) {
    return new Response('not found', { status: 404 });
  }

  const origins = [];
  if (env && env.IMAGE_PROXY_ORIGIN) origins.push(String(env.IMAGE_PROXY_ORIGIN).replace(/\/+$/, ''));
  for (const o of DEFAULT_ORIGINS) {
    if (!origins.includes(o)) origins.push(o);
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  // 1. 边缘缓存命中直接返回
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('x-proxy-cache', 'HIT');
    return res;
  }

  // 2. 逐个候选源回源拉取（全新 GET，不带浏览器的条件请求头）
  const upstream = await fetchFirstUsable(origins, url.pathname + url.search);

  // 404 = 图标在上游确实不存在（如 defs 引用了未上传的文件名），快速返回，不重试不缓存
  if (upstream && upstream.status === 404) {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  if (!upstream || !upstream.ok) {
    const status = upstream ? upstream.status : 502;
    return new Response('upstream error ' + status, {
      status: status >= 500 ? 502 : status,
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

// 依序尝试各候选源：5xx/网络错误/超时重试本源，本源耗尽换下一个源；
// 200 但 content-type 不是 image/* 也视为失败（防止把错误页/反代误配页当图标缓存 1 小时）
async function fetchFirstUsable(origins, pathAndQuery) {
  for (const origin of origins) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_ORIGIN; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
      try {
        // cache: 'no-store' —— 绕过 Cloudflare 对子请求的默认缓存，
        // 否则上游偶发的 5xx 错误会被边缘缓存住，重试也一直拿到缓存的错误
        //（注意：不能同时设置 cf.cacheTtl，两者不兼容会让 fetch 直接抛错）
        const res = await fetch(origin + pathAndQuery, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.status >= 500) {
          continue; // 5xx（含 CF 生成的 521/522）视为本次失败，重试/换源
        }
        if (res.ok) {
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (!ct.startsWith('image/')) {
            // 200 但非图片：反代挂了错误页之类，按失败处理换下一个源
            continue;
          }
          return res;
        }
        // 4xx 原样返回（交给上层区分 404 等）
        return res;
      } catch (err) {
        // DNS 失效/网络异常/超时中断：换源重试
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return null;
}
