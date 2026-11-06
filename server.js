'use strict';
/**
 * USDT (TRC20) 收款服务 —— 零依赖 Node.js 后端
 *
 * 功能：
 *  - POST /api/orders      创建收款订单（自动加金额尾数区分并发订单）
 *  - GET  /api/orders/:id  查询订单状态 pending / paid / expired
 *  - GET  /api/config      返回收款地址等公开配置
 *  - 后台轮询 TronGrid API，监听收款地址 USDT 入账并自动核销订单
 *
 * 运行：
 *  MERCHANT_ADDRESS=你的TRC20收款地址 node server.js
 *
 * 可选（Telegram 自动发送一次性邀请链接）：
 *  TG_BOT_TOKEN=xxx TG_CHAT_ID=-100xxxxxxxxxx MERCHANT_ADDRESS=xxx node server.js
 *  ※ Bot 需是目标群组/频道的管理员，并拥有"通过链接邀请用户"权限
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TelegramBot } = require('./telegram');

// ================= 配置 =================
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS || '';
const PORT = Number(process.env.PORT || 3000);
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT TRC20 合约
const SUN = 1_000_000;                    // 1 USDT = 10^6 最小单位
const ORDER_TTL_MS = 15 * 60 * 1000;      // 订单有效期 15 分钟
const POLL_INTERVAL_MS = 12 * 1000;       // 链上查询间隔
const MAX_AMOUNT = 1_000_000;             // 单笔上限（USDT）
const RATE_LIMIT = 20;                    // 每 IP 每分钟最多创建订单数
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'orders.json');
const TRONGRID_API = (process.env.TRONGRID_API_BASE || 'https://api.trongrid.io').replace(/\/$/, '');
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(MERCHANT_ADDRESS)) {
  console.error('[启动失败] 请通过环境变量设置有效的 TRC20 收款地址，例如：\n' +
    '  MERCHANT_ADDRESS=Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx node server.js');
  process.exit(1);
}

// ================= 订单存储 =================
/** @type {Array<{id:string,totalSun:number,createdAt:number,expiresAt:number,status:string,txid:string|null,from:string|null,paidAt:number|null}>} */
let orders = [];

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) orders = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.warn('[存储] 读取历史订单失败，已从空订单启动：', e.message);
    orders = [];
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
  } catch (e) {
    console.warn('[存储] 写入订单失败：', e.message);
  }
}

function fmtSun(sun) {
  return (sun / SUN).toFixed(6);
}

function expireOld() {
  const now = Date.now();
  let changed = false;
  for (const o of orders) {
    if (o.status === 'pending' && o.expiresAt <= now) {
      o.status = 'expired';
      changed = true;
    }
  }
  if (changed) save();
}

// ================= 金额解析 & 尾数分配 =================
/** 把用户输入金额（字符串/数字）解析为整数 sun；非法返回 null */
function parseAmountToSun(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [intPart, fracPart = ''] = s.split('.');
  const sun = Number(intPart) * SUN + Number(fracPart.padEnd(6, '0'));
  if (!Number.isSafeInteger(sun) || sun <= 0 || sun > MAX_AMOUNT * SUN) return null;
  return sun;
}

/** 在 0.000001 ~ 0.000999 范围内找未被占用的尾数，保证并发订单金额唯一 */
function allocateUniqueSun(baseSun) {
  const used = new Set(
    orders.filter(o => o.status === 'pending').map(o => o.totalSun)
  );
  if (!used.has(baseSun)) return baseSun;
  for (let k = 1; k <= 999; k++) {
    if (!used.has(baseSun + k)) return baseSun + k;
  }
  return null; // 999 个尾数全部占用
}

function createOrder(baseSun) {
  expireOld();
  const totalSun = allocateUniqueSun(baseSun);
  if (totalSun === null) return { error: '当前并发订单过多，请稍后重试' };
  const now = Date.now();
  const order = {
    id: crypto.randomBytes(8).toString('hex'),
    totalSun,
    createdAt: now,
    expiresAt: now + ORDER_TTL_MS,
    status: 'pending',
    txid: null,
    from: null,
    paidAt: null,
    tgChatId: null,      // 客户通过 /start 绑定的 Telegram chat_id
    tgUsername: null,
    inviteLink: null,    // 支付后生成的一次性邀请链接
    linkSent: false,     // 邀请链接是否已私聊送达
  };
  orders.push(order);
  // 控制文件体积：最多保留最近 2000 条订单
  if (orders.length > 2000) orders = orders.slice(-2000);
  save();
  return { order };
}

// ================= Telegram 履约 =================
let tg = null;          // TelegramBot 实例（未配置时为 null，功能自动停用）
let tgBotUsername = '';

async function initTelegram() {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.warn('[TG] 未设置 TG_BOT_TOKEN / TG_CHAT_ID，邀请链接自动发送功能已停用');
    return;
  }
  tg = new TelegramBot(TG_BOT_TOKEN, TG_CHAT_ID);
  try {
    const me = await tg.init();
    tgBotUsername = me.username;
    console.log(`[TG] 机器人已连接 @${tgBotUsername}`);
  } catch (e) {
    console.warn('[TG] 机器人连接失败（邀请功能将不可用）：', e.message);
  }
  tg.pollLoop(bindOrder); // 后台长轮询 /start <订单号>
}

/** 客户 /start <订单号> 绑定：记录 chat_id；若已支付则立即补发链接 */
async function bindOrder(orderId, chatId, from) {
  const order = orders.find(o => o.id === orderId);
  if (!order) {
    await tg.sendText(chatId, '订单不存在或已失效，请回到网页重新创建订单。');
    return;
  }
  order.tgChatId = chatId;
  order.tgUsername = (from && from.username) || null;
  if (order.status === 'paid' && order.inviteLink && !order.linkSent) {
    await tg.sendText(chatId, `✅ 支付已确认！\n\n这是你的专属邀请链接（仅可使用 1 次，请勿分享）：\n${order.inviteLink}`);
    order.linkSent = true;
  } else {
    await tg.sendText(chatId, `✅ 订单绑定成功！\n金额：${fmtSun(order.totalSun)} USDT\n完成转账后，一次性邀请链接将自动发送到这里。`);
  }
  save();
  console.log(`[TG] 订单 ${orderId} 已绑定 chat_id=${chatId} user=@${order.tgUsername || '-'}`);
}

/** 支付履约：生成一次性邀请链接，并私聊已绑定的客户（失败时返回 false，下轮重试） */
async function fulfillOrder(order) {
  if (!tg || order.status !== 'paid' || order.inviteLink) return false;
  try {
    order.inviteLink = await tg.createInviteLink(order.id);
    console.log(`[TG] 订单 ${order.id} 一次性邀请链接已生成`);
    if (order.tgChatId && !order.linkSent) {
      await tg.sendText(order.tgChatId, `✅ 支付已确认！\n\n这是你的专属邀请链接（仅可使用 1 次，请勿分享）：\n${order.inviteLink}`);
      order.linkSent = true;
      console.log(`[TG] 邀请链接已发送 chat_id=${order.tgChatId}`);
    }
    save();
    return true;
  } catch (e) {
    order.inviteLink = null;
    console.warn('[TG] 履约失败（下轮自动重试）：', e.message);
    return false;
  }
}

// ================= 链上转账核销 =================
/** 用 TronGrid 返回的 TRC20 交易列表核销订单；返回新支付的订单 */
function matchTransfers(transfers) {
  expireOld();
  const usedTx = new Set(orders.filter(o => o.txid).map(o => o.txid));
  const list = transfers
    .filter(t => t.type === 'Transfer' && t.to === MERCHANT_ADDRESS && !usedTx.has(t.transaction_id))
    .sort((a, b) => a.block_timestamp - b.block_timestamp);
  const paidNow = [];
  for (const t of list) {
    const value = Number(t.value);
    const hit = orders
      .filter(o => o.status === 'pending'
        && o.totalSun === value
        && t.block_timestamp >= o.createdAt - 120_000   // 允许 2 分钟时钟误差
        && t.block_timestamp <= Date.now() + 60_000)
      .sort((a, b) => a.createdAt - b.createdAt)[0];     // 同金额先到先得
    if (hit) {
      hit.status = 'paid';
      hit.txid = t.transaction_id;
      hit.from = t.from;
      hit.paidAt = Date.now();
      usedTx.add(t.transaction_id);
      paidNow.push(hit);
    }
  }
  if (paidNow.length) save();
  return paidNow;
}

async function pollChain() {
  // 已到账单邀请链接未生成的订单，每轮重试履约
  for (const o of orders) {
    if (o.status === 'paid' && !o.inviteLink && tg) await fulfillOrder(o);
  }
  const pendings = orders.filter(o => o.status === 'pending');
  if (!pendings.length) return;
  const minTs = Math.min(...pendings.map(o => o.createdAt)) - 120_000;
  const url = `${TRONGRID_API}/v1/accounts/${MERCHANT_ADDRESS}` +
    `/transactions/trc20?only_to=true&only_confirmed=true&limit=100` +
    `&contract_address=${USDT_CONTRACT}&min_timestamp=${minTs}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const json = await res.json();
    if (json && json.success && Array.isArray(json.data)) {
      for (const o of matchTransfers(json.data)) {
        console.log(`[到账] 订单 ${o.id} 金额 ${fmtSun(o.totalSun)} USDT 来自 ${o.from} txid=${o.txid}`);
        await fulfillOrder(o);
      }
    }
  } catch (e) {
    console.warn('[轮询失败]', e.message);
  }
}

// ================= HTTP 服务 =================
const rateMap = new Map(); // ip -> {count, resetAt}

function rateLimited(ip) {
  const now = Date.now();
  let rec = rateMap.get(ip);
  if (!rec || rec.resetAt <= now) {
    rec = { count: 0, resetAt: now + 60_000 };
    rateMap.set(ip, rec);
  }
  rec.count++;
  return rec.count > RATE_LIMIT;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function publicOrder(o) {
  return {
    id: o.id,
    amount: fmtSun(o.totalSun),
    address: MERCHANT_ADDRESS,
    status: o.status,
    txid: o.txid,
    from: o.from,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt,
    inviteLink: o.status === 'paid' ? o.inviteLink : null,
    tgBound: !!o.tgChatId,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 10_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && u.pathname === '/api/config') {
    return sendJson(res, 200, { address: MERCHANT_ADDRESS, orderTtlMs: ORDER_TTL_MS, botUsername: tgBotUsername || null });
  }

  if (req.method === 'POST' && u.pathname === '/api/orders') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const baseSun = parseAmountToSun(body.amount);
      if (baseSun === null) {
        return sendJson(res, 400, { error: `金额无效：需为 0 ~ ${MAX_AMOUNT} 之间的数字，最多 6 位小数` });
      }
      const { order, error } = createOrder(baseSun);
      if (error) return sendJson(res, 429, { error });
      console.log(`[订单] 创建 ${order.id} 金额 ${fmtSun(order.totalSun)} USDT`);
      return sendJson(res, 201, publicOrder(order));
    } catch {
      return sendJson(res, 400, { error: '请求格式错误' });
    }
  }

  const m = u.pathname.match(/^\/api\/orders\/([0-9a-f]{16})$/);
  if (req.method === 'GET' && m) {
    expireOld();
    const order = orders.find(o => o.id === m[1]);
    if (!order) return sendJson(res, 404, { error: '订单不存在' });
    return sendJson(res, 200, publicOrder(order));
  }

  sendJson(res, 404, { error: 'Not Found' });
});

// ================= 启动 =================
if (require.main === module) {
  load();
  server.listen(PORT, () => {
    console.log(`USDT TRC20 收款服务已启动`);
    console.log(`  收款地址: ${MERCHANT_ADDRESS}`);
    console.log(`  访问地址: http://localhost:${PORT}`);
  });
  setInterval(pollChain, POLL_INTERVAL_MS);
  pollChain();
  initTelegram();
} else {
  // 供测试引用内部逻辑
  module.exports = {
    matchTransfers, parseAmountToSun, createOrder, fmtSun, orders,
    fulfillOrder, bindOrder,
    __setTg: bot => { tg = bot; },
  };
}
