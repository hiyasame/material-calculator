# 开拓生存 · 材料计算器

一个为《开拓生存》制作的网页工具：**材料合成计算** 与 **挂机时长估算**，部署在 Cloudflare Pages 上。

全部游戏数据（物品、配方、怪物掉落、召唤成本）不硬编码，实时来自游戏服务器 `kt.ikui.vip` 的数据接口，经边缘代理缓存加速——游戏更新配方后，页面无需发版即可拿到最新数据。

## 功能

### 📦 材料合成计算

- 同时添加多个合成目标（锻造、NPC 兑换、虚空商队、区域配方统一纳入下拉选择）
- 递归展开合成树，可逐层折叠查看每一级的用量
- 自动汇总到**原子材料**（不可再合成的材料），按数量排序
- 标记每种材料是否**可刷怪获得**，并给出期望掉落最高的怪物
- 装备图标/名称悬浮可查看**属性提示**（品质、槽位、词条、特效）

### ⏳ 挂机时间计算

- 输入目标材料数量，选择刷取怪物，估算需要击杀的次数与**挂机总时长**
- 掉落按**期望值**计算：`掉率 × 掉落数区间均值`，宝袋自动按 loot table 展开
- 每只怪物击杀秒数可全局默认、可按行覆盖（召唤 / Boss 自行估计）
- 召唤成本（召唤币、召唤材料）按击杀数换算并汇总
- 支持从合成统计**一键带入**所有可刷材料

## 技术要点

- **零构建、零依赖前端**：单个 `index.html`，原生 JS + CSS，无框架无打包
- **数据实时化**：页面每次访问经 `/api/data/defs` 拉取上游数据；失败自动回退 `localStorage` 离线缓存；页面驻留时每 30 分钟自动刷新，切回标签页超过 10 分钟也会刷新
- **两个 Cloudflare Pages Functions 边缘代理**：
  - `functions/api/data/defs.js` — 代理游戏数据 API，边缘缓存 5 分钟，上游 5xx/超时自动重试
  - `functions/source/[[path]].js` — 代理上游图片服务器（游戏图标为 HTTP 资源，需转成同源 HTTPS 才能在页面上显示），边缘缓存 1 小时；**多源回退**（lanxi 隧道 → 直连旧 IP），隧道域名失效后可通过 Pages 环境变量 `IMAGE_PROXY_ORIGIN` 免代码更新新地址
- **图标多级回退**：上游代理失败时自动切换到本地 `icons/` 镜像（按文件名匹配）；游戏新增物品后执行 `node scripts/sync-icons.mjs` 一键补齐镜像（`--check` 只报告不下载），避免代理挂掉时新物品贴图空白
- 免费额度友好：数据接口每个边缘节点最多 5 分钟回源一次，图片缓存 1 小时，Pages Functions 请求消耗极低

## 目录结构

```
├── index.html                 # 前端单页应用（全部 UI 与逻辑）
├── functions/
│   ├── api/data/defs.js       # 游戏数据 API 边缘代理（缓存 5 分钟）
│   └── source/[[path]].js     # 图片资源边缘代理（缓存 1 小时，多源回退）
├── scripts/
│   └── sync-icons.mjs         # 本地图标镜像同步脚本（新增物品后运行）
├── icons/                     # 本地图标回退库（200+ 游戏素材）
└── .wrangler/                 # Wrangler 本地缓存（不入库）
```

## 图标链路与故障排查

页面图标加载顺序：`/source/` 边缘代理（缓存 1h）→ 本地 `icons/` 镜像（按文件名匹配）。

若线上出现「新物品贴图空白」，按序检查：

1. **本地镜像是否缺新图标**：`node scripts/sync-icons.mjs --check`，缺则去掉 `--check` 下载
2. **代理回源是否可用**：`curl -I https://<pages域名>/source/items/玄铁锭.png` 看 `x-proxy-cache` 与状态码
3. **lanxi 隧道域名是否还活着**：`functions/source/[[path]].js` 依赖的 trycloudflare 快速隧道域名会随 cloudflared 重启而更换；失效时在 Cloudflare Pages 环境变量里设置 `IMAGE_PROXY_ORIGIN` 为新隧道地址即可恢复（无需改代码），或在 `DEFAULT_ORIGINS` 中更新后重新部署
4. 注意：上游图片服务器 `203.135.99.28:32001` 对 Cloudflare 边缘 IP 段有 ACL（返回 521），从国内家庭宽带直连则正常——这是当初引入 lanxi 中转的原因

## 本地开发

需要 Node.js。用 Wrangler 起 Pages 本地环境（同时模拟 Functions 代理）：

```bash
npx wrangler pages dev .
```

访问 `http://localhost:8788`。

## 部署

项目即开即用为 Cloudflare Pages 项目：

- **Git 集成**：在 Cloudflare Pages 连接本仓库，构建命令留空、输出目录填 `/` 即可
- **直接部署**：`npx wrangler pages deploy .`

## 数据来源与说明

- 上游数据/图片来自游戏服务器 `kt.ikui.vip`，本项目仅做代理缓存与计算展示，不存储游戏数据
- `icons/` 中的游戏素材版权归游戏方所有
