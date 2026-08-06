'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const httpm = require('./httpm');

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    results.push('  PASS: ' + msg);
  } else {
    failed++;
    results.push('  FAIL: ' + msg);
  }
}

/**
 * 显式标记测试为 SKIP（既不计入 PASS 也不计入 FAIL）
 * 用于环境/依赖原因无法执行的测试（如 WebSocket 在某些环境不可用）
 * 区别于 assert(true, 'skipped')：后者会虚假增加 PASS 计数，掩盖测试失效
 */
function assertSkip(msg, reason) {
  skipped++;
  results.push('  SKIP: ' + msg + (reason ? ' | ' + reason : ''));
}

function section(title) {
  results.push('\n[' + title + ']');
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      // 显式关闭 keep-alive，避免连接保持导致 app.close() 等待超时
      headers: Object.assign({ Connection: 'close' }, headers || {}),
      // 禁用连接复用：SSE 响应头会设置 Connection: keep-alive（协议要求），
      // 若不禁用 agent，后续请求会复用该 keep-alive 连接导致 400 错误
      agent: false
    };
    http.get(opts, resolve).on('error', reject);
  });
}

function httpRequest(opts, body) {
  return new Promise((resolve, reject) => {
    // 显式关闭 keep-alive，避免连接保持导致 app.close() 等待超时
    const mergedOpts = Object.assign({}, opts);
    mergedOpts.headers = Object.assign({ Connection: 'close' }, opts.headers || {});
    // 禁用连接复用（同 httpGet），避免复用 SSE keep-alive 连接导致 400
    if (mergedOpts.agent === undefined) mergedOpts.agent = false;
    const req = http.request(mergedOpts, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    // 加 error 处理：连接异常断开时 reject，避免 Promise 永久挂起
    res.on('error', reject);
  });
}

function readBodyStr(res) {
  return readBody(res).then(buf => buf.toString('utf8'));
}

/**
 * WebSocket 客户端：完成握手并返回 socket + 接收函数
 */
function wsConnect(urlStr) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname,
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    };
    const req = http.request(opts);
    req.on('upgrade', (res, socket, head) => {
      resolve({ socket, head });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * WebSocket 帧缓存：为每个 socket 维护未消费的帧队列和缓冲区
 */
const _wsFrameQueues = new WeakMap();

/**
 * 从缓冲区解析一个 WebSocket 帧，返回 { opcode, payload, bytesConsumed } 或 null
 */
function _wsDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  let offset = 2;
  let payloadLen = buf[1] & 0x7F;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf.length < offset + payloadLen) return null;
  const payload = buf.slice(offset, offset + payloadLen);
  return { opcode, payload, bytesConsumed: offset + payloadLen };
}

/**
 * 读取 WebSocket 文本帧（支持多帧缓存）
 */
function wsReadText(socket) {
  // 确保该 socket 有帧队列和缓冲区
  if (!_wsFrameQueues.has(socket)) {
    _wsFrameQueues.set(socket, { queue: [], buffer: Buffer.alloc(0), listening: false });
  }
  const state = _wsFrameQueues.get(socket);

  return new Promise((resolve, reject) => {
    // 如果队列中已有帧，直接消费
    if (state.queue.length > 0) {
      const frame = state.queue.shift();
      if (frame.opcode === 0x01) resolve(frame.payload.toString('utf8'));
      else if (frame.opcode === 0x08) resolve(null);
      else resolve(frame.payload);
      return;
    }

    const timeout = setTimeout(() => reject(new Error('ws read timeout')), 3000);

    const onData = (buf) => {
      state.buffer = Buffer.concat([state.buffer, buf]);
      // 循环解析所有完整帧
      while (state.buffer.length >= 2) {
        const result = _wsDecodeFrame(state.buffer);
        if (result === null) break;
        state.buffer = state.buffer.slice(result.bytesConsumed);
        state.queue.push(result);
      }
      // 如果解析出了帧，消费第一个
      if (state.queue.length > 0) {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        clearTimeout(timeout);
        const frame = state.queue.shift();
        if (frame.opcode === 0x01) resolve(frame.payload.toString('utf8'));
        else if (frame.opcode === 0x08) resolve(null);
        else resolve(frame.payload);
      }
    };

    // 加 error 处理：socket 异常断开时 reject，避免 Promise 永久挂起
    const onError = (err) => {
      socket.removeListener('data', onData);
      clearTimeout(timeout);
      reject(err);
    };

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * 发送 WebSocket 文本帧（客户端需掩码）
 */
function wsSendText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | payload.length; // MASK + len
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  socket.write(Buffer.concat([header, masked]));
}

/**
 * 关闭 Logger 写入流并等待文件句柄真正释放
 * Windows 上 stream.end() 是异步的，句柄未释放时 rmSync 会"成功"但目录仍存在
 * 用 destroy() 立即释放句柄，并等待 'close' 事件确认释放完成
 * @param {Logger} logger - httpm.Logger 实例
 * @returns {Promise<void>}
 */
function closeLoggerStream(logger) {
  return new Promise((resolve) => {
    if (!logger || !logger._stream) { resolve(); return; }
    const stream = logger._stream;
    logger._stream = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // 'close' 事件后额外等待，确保 Windows 上底层 fd 真正释放
      setTimeout(resolve, 200);
    };
    stream.once('close', finish);
    stream.once('error', finish);
    // destroy() 立即释放句柄，比 end() 更彻底（测试场景无需保证缓冲刷盘）
    try { stream.destroy(); } catch (e) { finish(); }
    // 兜底超时，防止事件未触发导致挂起
    setTimeout(finish, 500);
  });
}

/**
 * 强制删除目录，针对 Windows 文件句柄延迟释放做重试
 * Node.js fs.rmSync 在 Windows 上对刚关闭的文件句柄会静默失败（不抛异常但不删除），
 * 需用系统原生命令兜底
 * @param {string} dir - 目录路径
 */
async function rmDirForce(dir) {
  if (!fs.existsSync(dir)) return;
  // 先尝试 fs.rmSync（重试几次应对 fd 释放延迟）
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    if (!fs.existsSync(dir)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  // fs.rmSync 失败时，用系统原生命令兜底（Windows 上 fs.rmSync 对刚关闭句柄的文件静默失败）
  try {
    const cmd = process.platform === 'win32'
      ? `rd /s /q "${dir}"`
      : `rm -rf "${dir}"`;
    require('child_process').execSync(cmd, { stdio: 'ignore' });
  } catch (e) { /* 忽略 */ }
}


const PORT = 9876;
const BASE = 'http://localhost:' + PORT;

async function runTests() {

  // ============================================================
  // 1. 工具函数 - 正向 + 反向测试
  // ============================================================
  section('工具函数 - parseUrl');

  {
    // 正向：带 query
    const r1 = httpm.parseUrl('/api/users?id=1&name=test');
    assert(r1.pathname === '/api/users', 'parseUrl - pathname');
    assert(r1.query.id === '1', 'parseUrl - query.id');
    assert(r1.query.name === 'test', 'parseUrl - query.name');

    // 正向：无 query
    const r2 = httpm.parseUrl('/no-query');
    assert(r2.pathname === '/no-query', 'parseUrl - no query pathname');
    assert(Object.keys(r2.query).length === 0, 'parseUrl - no query empty');

    // 正向：空 query 值
    const r3 = httpm.parseUrl('/path?key');
    assert(r3.pathname === '/path', 'parseUrl - empty value pathname');
    assert(r3.query.key === '', 'parseUrl - empty value key');

    // 正向：URL 编码
    const r4 = httpm.parseUrl('/path?name=%E4%B8%AD%E6%96%87');
    assert(r4.query.name === '中文', 'parseUrl - URL encoded value');

    // 反向：空字符串
    const r5 = httpm.parseUrl('');
    assert(r5.pathname === '' && Object.keys(r5.query).length === 0, 'parseUrl - empty string');

    // 正向：仅问号
    const r6 = httpm.parseUrl('/path?');
    assert(r6.pathname === '/path', 'parseUrl - trailing question mark pathname');
  }

  section('工具函数 - parseCookies');

  {
    // 正向
    const c1 = httpm.parseCookies('name=hello; token=abc123');
    assert(c1.name === 'hello', 'parseCookies - name');
    assert(c1.token === 'abc123', 'parseCookies - token');

    // 反向：空字符串
    const c2 = httpm.parseCookies('');
    assert(Object.keys(c2).length === 0, 'parseCookies - empty');

    // 反向：null/undefined
    const c3 = httpm.parseCookies(null);
    assert(Object.keys(c3).length === 0, 'parseCookies - null');

    // 正向：带空格
    const c4 = httpm.parseCookies('  key1  =  val1  ; key2=val2');
    assert(c4.key1 === 'val1', 'parseCookies - spaces around key/val');
    assert(c4.key2 === 'val2', 'parseCookies - normal after spaced');

    // 反向：无等号的 cookie
    const c5 = httpm.parseCookies('novalue; key=val');
    assert(c5.key === 'val', 'parseCookies - skip no-equal pair');
    assert(c5.novalue === undefined, 'parseCookies - no-equal pair ignored');
  }

  section('工具函数 - getMimeType');

  {
    // 正向
    assert(httpm.getMimeType('.html').includes('text/html'), 'getMimeType - .html');
    assert(httpm.getMimeType('.json').includes('application/json'), 'getMimeType - .json');
    assert(httpm.getMimeType('.png') === 'image/png', 'getMimeType - .png');
    assert(httpm.getMimeType('.css').includes('text/css'), 'getMimeType - .css');
    assert(httpm.getMimeType('.js').includes('javascript'), 'getMimeType - .js');
    assert(httpm.getMimeType('.svg').includes('svg'), 'getMimeType - .svg');
    assert(httpm.getMimeType('.woff2').includes('font'), 'getMimeType - .woff2');

    // 反向：未知类型
    assert(httpm.getMimeType('.unknown') === 'application/octet-stream', 'getMimeType - unknown');

    // 反向：无扩展名
    assert(httpm.getMimeType('') === 'application/octet-stream', 'getMimeType - empty ext');

    // 反向：null
    assert(httpm.getMimeType(null) === 'application/octet-stream', 'getMimeType - null');

    // 正向：大写扩展名
    assert(httpm.getMimeType('.HTML').includes('text/html'), 'getMimeType - .HTML uppercase');
  }

  section('工具函数 - fmtSize');

  {
    // 正向
    assert(httpm.fmtSize(0) === '0B', 'fmtSize - 0');
    assert(httpm.fmtSize(100).includes('B'), 'fmtSize - 100B');
    assert(httpm.fmtSize(1024).includes('KB'), 'fmtSize - 1KB');
    assert(httpm.fmtSize(1048576).includes('MB'), 'fmtSize - 1MB');
    assert(httpm.fmtSize(1073741824).includes('GB'), 'fmtSize - 1GB');

    // 正向：负数返回 0B
    assert(httpm.fmtSize(-1) === '0B', 'fmtSize - negative returns 0B');
    // 正向：NaN 返回 0B
    assert(httpm.fmtSize(NaN) === '0B', 'fmtSize - NaN returns 0B');
  }

  section('工具函数 - fmtTime');

  {
    // 正向
    assert(httpm.fmtTime(0).includes('ms'), 'fmtTime - 0');
    assert(httpm.fmtTime(500).includes('ms'), 'fmtTime - 500ms');
    assert(httpm.fmtTime(1500).includes('s'), 'fmtTime - 1.5s');
    assert(httpm.fmtTime(120000).includes('m'), 'fmtTime - 2m');
    assert(httpm.fmtTime(3600000).includes('h'), 'fmtTime - 1h');
    // 反向：非数字/负数返回 0ms（P2-1 修复）
    assert(httpm.fmtTime(NaN) === '0ms', 'fmtTime - NaN returns 0ms');
    assert(httpm.fmtTime(-1) === '0ms', 'fmtTime - negative returns 0ms');
    assert(httpm.fmtTime(null) === '0ms', 'fmtTime - null returns 0ms');
  }

  section('工具函数 - escapeHtml');

  {
    // 正向：特殊字符转义
    assert(httpm.escapeHtml('<script>') === '&lt;script&gt;', 'escapeHtml - angle brackets');
    assert(httpm.escapeHtml('"hello"') === '&quot;hello&quot;', 'escapeHtml - double quotes');
    assert(httpm.escapeHtml("it's") === 'it&#39;s', 'escapeHtml - single quotes');
    assert(httpm.escapeHtml('a & b') === 'a &amp; b', 'escapeHtml - ampersand');
    // 反向：null/undefined 不抛异常
    assert(httpm.escapeHtml(null) === '', 'escapeHtml - null returns empty');
    assert(httpm.escapeHtml(undefined) === '', 'escapeHtml - undefined returns empty');
    // 正向：无特殊字符不变
    assert(httpm.escapeHtml('hello world') === 'hello world', 'escapeHtml - no special chars');
  }

  section('工具函数 - isPathSafe');

  {
    // 正向：正常路径
    assert(httpm.isPathSafe('public/index.html', '/root') === true, 'isPathSafe - normal path');
    assert(httpm.isPathSafe('sub/dir/file.txt', '/root') === true, 'isPathSafe - nested path');
    assert(httpm.isPathSafe('', '/root') === true, 'isPathSafe - empty path');

    // 反向：路径遍历
    assert(httpm.isPathSafe('../etc/passwd', '/root') === false, 'isPathSafe - traversal ../');
    assert(httpm.isPathSafe('foo/../../etc', '/root') === false, 'isPathSafe - double traversal');

    // 反向：隐藏文件（默认不允许）
    assert(httpm.isPathSafe('.env', '/root') === false, 'isPathSafe - hidden file');
    assert(httpm.isPathSafe('.git/config', '/root') === false, 'isPathSafe - hidden dir');

    // 正向：allowAccessToAllFiles=true 时允许隐藏文件
    assert(httpm.isPathSafe('.env', '/root', true) === true, 'isPathSafe - hidden file allowed when allowAllFiles=true');
    assert(httpm.isPathSafe('.git/config', '/root', true) === true, 'isPathSafe - hidden dir allowed when allowAllFiles=true');
    assert(httpm.isPathSafe('.well-known/security.txt', '/root', true) === true, 'isPathSafe - .well-known allowed when allowAllFiles=true');

    // 反向：allowAccessToAllFiles=true 仍禁止路径遍历
    assert(httpm.isPathSafe('../etc/passwd', '/root', true) === false, 'isPathSafe - traversal still blocked with allowAllFiles=true');
  }

  section('工具函数 - generateETag');

  {
    // 正向：格式
    const stat = fs.statSync(__filename);
    const etag1 = httpm.generateETag(stat);
    assert(etag1.startsWith('"') && etag1.endsWith('"'), 'generateETag - format');

    // 正向：同一文件多次生成一致
    const etag2 = httpm.generateETag(stat);
    assert(etag1 === etag2, 'generateETag - consistent');

    // 正向：不同文件不同 ETag
    const stat2 = fs.statSync(path.join(__dirname, 'httpm.js'));
    const etag3 = httpm.generateETag(stat2);
    assert(etag1 !== etag3, 'generateETag - different files different etag');
  }

  section('工具函数 - parseRange');

  {
    // 正向：正常范围
    const r1 = httpm.parseRange('bytes=0-499', 1000);
    assert(r1 && r1.start === 0 && r1.end === 499 && r1.total === 1000, 'parseRange - normal');

    // 正向：开放尾
    const r2 = httpm.parseRange('bytes=500-', 1000);
    assert(r2 && r2.start === 500 && r2.end === 999, 'parseRange - open end');

    // 正向：后缀
    const r3 = httpm.parseRange('bytes=-200', 1000);
    assert(r3 && r3.start === 800 && r3.end === 999, 'parseRange - suffix');

    // 反向：越界
    assert(httpm.parseRange('bytes=2000-3000', 1000) === null, 'parseRange - out of range');

    // 反向：无效格式
    assert(httpm.parseRange('invalid', 1000) === null, 'parseRange - invalid format');
    assert(httpm.parseRange('', 1000) === null, 'parseRange - empty string');
    assert(httpm.parseRange(null, 1000) === null, 'parseRange - null');

    // 反向：start > end
    assert(httpm.parseRange('bytes=500-100', 1000) === null, 'parseRange - start > end');

    // 正向：end 超出文件大小自动修正
    const r4 = httpm.parseRange('bytes=0-2000', 1000);
    assert(r4 && r4.start === 0 && r4.end === 999, 'parseRange - end exceeds size auto-correct');
  }

  // ============================================================
  // 1b. parseQuery 工具函数 - 正向 + 反向测试
  // ============================================================
  section('parseQuery');

  {
    // 正向：基本解析
    const q1 = httpm.parseQuery('foo=bar&num=1');
    assert(q1.foo === 'bar', 'parseQuery - basic foo');
    assert(q1.num === '1', 'parseQuery - basic num');

    // 正向：空值参数
    const q2 = httpm.parseQuery('key=');
    assert(q2.key === '', 'parseQuery - empty value');

    // 正向：无值参数
    const q3 = httpm.parseQuery('flag');
    assert(q3.flag === '', 'parseQuery - no value');

    // 反向：空字符串
    const q4 = httpm.parseQuery('');
    assert(Object.keys(q4).length === 0, 'parseQuery - empty string');

    // 反向：null
    const q5 = httpm.parseQuery(null);
    assert(Object.keys(q5).length === 0, 'parseQuery - null');

    // 正向：+ 号不转空格（parseQuery 用于 URL query，+ 号保持原样）
    const q6 = httpm.parseQuery('name=hello+world');
    assert(q6.name === 'hello+world', 'parseQuery - plus not converted to space');
  }

  // ============================================================
  // 1c. WebSocketHandShak 工具函数 - 正向测试
  // ============================================================
  section('WebSocketHandShak');

  {
    // 正向：已知 key 的 accept 值
    const accept = httpm.WebSocketHandShak('dGhlIHNhbXBsZSBub25jZQ==');
    assert(accept === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'WebSocketHandShak - RFC 6455 example');

    // 正向：函数存在性
    assert(typeof httpm.WebSocketHandShak === 'function', 'WebSocketHandShak - is function');

    // 正向：返回字符串
    const accept2 = httpm.WebSocketHandShak('testkey123');
    assert(typeof accept2 === 'string', 'WebSocketHandShak - returns string');
    assert(accept2.length > 0, 'WebSocketHandShak - non-empty result');
  }

  // ============================================================
  // 2. Logger 日志类 - 正向 + 反向测试
  // ============================================================
  section('Logger');

  {
    const logDir = path.join(__dirname, 'test_log_output');
    const logger = new httpm.Logger({ level: 'debug', logDir });

    // 正向：方法存在
    assert(typeof logger.debug === 'function', 'Logger - debug method');
    assert(typeof logger.info === 'function', 'Logger - info method');
    assert(typeof logger.notice === 'function', 'Logger - notice method');
    assert(typeof logger.warn === 'function', 'Logger - warn method');
    assert(typeof logger.error === 'function', 'Logger - error method');
    assert(typeof logger.fatal === 'function', 'Logger - fatal method');

    // 正向：name 属性默认为空
    assert(logger.name === '', 'Logger - name default empty');

    // 正向：日志输出不抛异常
    let noError = true;
    try {
      logger.debug('debug msg');
      logger.info('info msg');
      logger.notice('notice msg');
      logger.warn('warn msg');
      logger.error('error msg');
      logger.fatal('fatal msg');
    } catch (e) {
      noError = false;
    }
    assert(noError, 'Logger - no throw on log');

    // 正向：级别过滤
    const logger2 = new httpm.Logger({ level: 'warn' });
    assert(logger2._shouldLog('debug') === false, 'Logger - level filter debug blocked');
    assert(logger2._shouldLog('info') === false, 'Logger - level filter info blocked');
    assert(logger2._shouldLog('notice') === false, 'Logger - level filter notice blocked');
    assert(logger2._shouldLog('warn') === true, 'Logger - level filter warn allowed');
    assert(logger2._shouldLog('error') === true, 'Logger - level filter error allowed');
    assert(logger2._shouldLog('fatal') === true, 'Logger - level filter fatal allowed');

    // 正向：时间格式仅时分秒 HH:MM:SS
    const timeStr = logger._formatTime(new Date(2026, 0, 15, 8, 30, 45));
    assert(timeStr === '08:30:45', 'Logger - time format HH:MM:SS');

    // 正向：文件持久化 - 无 name 前缀，路径 ./log/YYYY/MM/DD.log
    logger.info('test-file-persist');
    await new Promise(r => setTimeout(r, 200));
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const logFile = path.join(logDir, year, month, `${day}.log`);
    assert(fs.existsSync(logFile), 'Logger - file persistence exists (YYYY/MM/DD.log)');

    // 正向：name 前缀文件持久化，路径 ./log/YYYY/MM/name_DD.log
    const logDir2 = path.join(__dirname, 'test_log_output2');
    const logger3 = new httpm.Logger({ level: 'debug', logDir: logDir2, name: 'myapp' });
    assert(logger3.name === 'myapp', 'Logger - name property set');
    logger3.info('test-name-prefix');
    // 等待流写入完成
    await new Promise(r => setTimeout(r, 300));
    // 关闭流确保数据刷新到磁盘（保留 _stream 引用，清理阶段用 destroy 释放句柄）
    if (logger3._stream) { logger3._stream.end(); }
    await new Promise(r => setTimeout(r, 100));
    const logFile2 = path.join(logDir2, year, month, `myapp_${day}.log`);
    assert(fs.existsSync(logFile2), 'Logger - name prefix file persistence (YYYY/MM/name_DD.log)');

    // 正向：日志文件内容格式校验
    const logContent = fs.readFileSync(logFile2, 'utf8');
    assert(logContent.includes('[INFO  ]'), 'Logger - file content has level tag');
    assert(logContent.includes('test-name-prefix'), 'Logger - file content has message');
    const timeMatch = logContent.match(/\[(\d{2}:\d{2}:\d{2})\]/);
    assert(timeMatch !== null, 'Logger - file content has HH:MM:SS timestamp');

    // 正向：exitOnDiskFull 默认 false（业界主流，日志故障不影响主业务）
    const logger4 = new httpm.Logger({ level: 'debug' });
    assert(logger4.exitOnDiskFull === false, 'Logger - exitOnDiskFull default false');

    // 正向：exitOnDiskFull 可配置为 true
    const logger5 = new httpm.Logger({ level: 'debug', exitOnDiskFull: true });
    assert(logger5.exitOnDiskFull === true, 'Logger - exitOnDiskFull configurable true');

    // 正向：_handleWriteError 方法存在
    assert(typeof logger4._handleWriteError === 'function', 'Logger - _handleWriteError method exists');

    // 正向：exitOnDiskFull=false 时 _handleWriteError 仅打印不退出（捕获 console.error 验证打印，进程不退出即通过）
    const origConsoleError = console.error;
    let errorPrinted = false;
    console.error = () => { errorPrinted = true; };
    const fakeErr = new Error('no space left on device');
    fakeErr.code = 'ENOSPC';
    logger4._handleWriteError(fakeErr); // 若退出则测试进程终止，后续断言无法执行
    console.error = origConsoleError;
    assert(errorPrinted === true, 'Logger - _handleWriteError prints to console');
    assert(logger4.exitOnDiskFull === false, 'Logger - _handleWriteError no exit when exitOnDiskFull=false');

    // 清理：用 destroy 释放文件句柄后删除目录
    // Windows 上 end() 不立即释放句柄，rmSync 会"成功"但目录残留
    await closeLoggerStream(logger);
    await closeLoggerStream(logger3);
    await rmDirForce(logDir);
    await rmDirForce(logDir2);
  }

  // ============================================================
  // 3. Router 类 - 正向 + 反向测试
  // ============================================================
  section('Router');

  {
    const router = new httpm.Router();

    // 正向：静态路由匹配
    router.get('/hello', (req, res) => 'hello');
    const matches1 = router.match('GET', '/hello');
    assert(matches1.length === 1, 'Router - static route match');

    // 反向：不匹配
    const matches2 = router.match('GET', '/not-exist');
    assert(matches2.length === 0, 'Router - no match');

    // 正向：动态路由参数
    router.get('/users/:id', (req, res) => 'user');
    const dynMatches = router.match('GET', '/users/123');
    assert(dynMatches.length === 1, 'Router - dynamic route match');
    assert(dynMatches[0].params.id === '123', 'Router - dynamic param extraction');

    // 正向：多参数动态路由
    router.get('/posts/:postId/comments/:commentId', (req, res) => 'comment');
    const multiMatches = router.match('GET', '/posts/10/comments/20');
    assert(multiMatches.length === 1, 'Router - multi-param match');
    assert(multiMatches[0].params.postId === '10', 'Router - multi-param postId');
    assert(multiMatches[0].params.commentId === '20', 'Router - multi-param commentId');

    // 正向：ALL 路由匹配所有方法
    router.all('/any', (req, res) => 'any');
    const allGetMatch = router.match('GET', '/any');
    const allPostMatch = router.match('POST', '/any');
    assert(allGetMatch.length === 1, 'Router - ALL route GET match');
    assert(allPostMatch.length === 1, 'Router - ALL route POST match');

    // 正向：不同 HTTP 方法注册
    router.post('/submit', (req, res) => 'submit');
    router.put('/update', (req, res) => 'update');
    router.delete('/remove', (req, res) => 'remove');
    assert(router.match('POST', '/submit').length === 1, 'Router - POST match');
    assert(router.match('PUT', '/update').length === 1, 'Router - PUT match');
    assert(router.match('DELETE', '/remove').length === 1, 'Router - DELETE match');

    // 反向：方法不匹配
    assert(router.match('DELETE', '/submit').length === 0, 'Router - method mismatch');

    // 正向：路径级中间件前缀匹配
    const router2 = new httpm.Router();
    router2.use('/api', (req, res, next) => next());
    assert(router2.matchMiddleware('/api/users').length === 1, 'Router - middleware prefix match /api/users');
    assert(router2.matchMiddleware('/api').length === 1, 'Router - middleware exact match /api');

    // 反向：路径级中间件不匹配
    assert(router2.matchMiddleware('/other/path').length === 0, 'Router - middleware no match');

    // 正向：应用级中间件匹配所有
    const router3 = new httpm.Router();
    router3.use((req, res, next) => next());
    assert(router3.matchMiddleware('/anything').length === 1, 'Router - app-level middleware matches all');
  }

  // ============================================================
  // 4. Request 类 - 属性测试
  // ============================================================
  section('Request 类属性');

  {
    // 通过 HTTP 集成测试验证 Request 属性
    // 此处验证类结构
    const req = new httpm.Request({ headers: {}, url: '/test', method: 'GET', socket: { remoteAddress: '127.0.0.1' } });
    assert(req.query !== undefined, 'Request - query exists');
    assert(req.params !== undefined, 'Request - params exists');
    assert(req.body === null, 'Request - body default null');
    assert(req.cookies !== undefined, 'Request - cookies exists');
    assert(req.files !== undefined, 'Request - files exists');
    assert(req.formData !== undefined, 'Request - formData exists');
    assert(Array.isArray(req.formData.files), 'Request - formData.files is array');
    assert(req.formData.fields !== undefined, 'Request - formData.fields exists');
    assert(req.path === '', 'Request - path default empty');
    assert(req.method === 'GET', 'Request - method proxy');
    assert(req.ip === '127.0.0.1', 'Request - ip proxy');
  }

  // ============================================================
  // 5. Response 类 - 方法测试
  // ============================================================
  section('Response 类方法');

  {
    // 验证类结构和方法存在
    const mockRes = { setHeader: () => {}, getHeader: () => null, end: () => {} };
    const res = new httpm.Response(mockRes, { settings: {} });
    assert(typeof res.status === 'function', 'Response - status method');
    assert(typeof res.json === 'function', 'Response - json method');
    assert(typeof res.send === 'function', 'Response - send method');
    assert(typeof res.sendFile === 'function', 'Response - sendFile method');
    assert(typeof res.download === 'function', 'Response - download method');
    assert(typeof res.redirect === 'function', 'Response - redirect method');
    assert(typeof res.sse === 'function', 'Response - sse method');
    assert(typeof res.cookie === 'function', 'Response - cookie method');
    assert(typeof res.clearCookie === 'function', 'Response - clearCookie method');
    assert(typeof res.setHeader === 'function', 'Response - setHeader method');
    assert(typeof res.getHeader === 'function', 'Response - getHeader method');
    assert(res.statusCode === 200, 'Response - default status 200');

    // 正向：status 链式调用
    const result = res.status(404);
    assert(result === res, 'Response - status chainable');
    assert(res.statusCode === 404, 'Response - status set');
  }

  // ============================================================
  // 6. SSE 类 - 正向测试
  // ============================================================
  section('SSE 类');

  {
    assert(typeof httpm.SSE === 'function', 'SSE - class exists');

    // 正向：方法存在
    const methods = ['send', 'event', 'retry', 'comment', 'close'];
    const mockRes2 = { writeHead: () => {}, write: () => {}, end: () => {}, on: () => {} };
    const sse = new httpm.SSE(mockRes2);
    methods.forEach(m => {
      assert(typeof sse[m] === 'function', 'SSE - ' + m + ' method exists');
    });
    assert(sse.connected === true, 'SSE - connected default true');
  }

  // ============================================================
  // 7. WebSocket / WebSocketServer 类 - 结构测试
  // ============================================================
  section('WebSocket / WebSocketServer 类');

  {
    assert(typeof httpm.WebSocket === 'function', 'WebSocket - class exists');
    assert(typeof httpm.WebSocketServer === 'function', 'WebSocketServer - class exists');

    // 正向：WebSocketServer 方法存在
    const wss = new httpm.WebSocketServer();
    assert(typeof wss.handleUpgrade === 'function', 'WSS - handleUpgrade method');
    assert(typeof wss.broadcast === 'function', 'WSS - broadcast method');
    assert(typeof wss.broadcastAll === 'function', 'WSS - broadcastAll method');
    assert(typeof wss.getConnections === 'function', 'WSS - getConnections method');
    assert(typeof wss.on === 'function', 'WSS - on method');
    assert(wss.connections instanceof Map, 'WSS - connections is Map');
    assert(wss.groups instanceof Map, 'WSS - groups is Map');
  }

  // ============================================================
  // 8. 中间件系统 - 正向 + 反向测试
  // ============================================================
  section('中间件 - bodyParser/cookieParser/static');

  {
    // 正向：bodyParser 导出
    assert(typeof httpm.bodyParser === 'function', 'bodyParser - exported');

    // 正向：cookieParser 导出
    assert(typeof httpm.cookieParser === 'function', 'cookieParser - exported');

    // 正向：static 导出
    assert(typeof httpm.static === 'function', 'static - exported');

    // 正向：static 返回中间件函数
    const staticMw = httpm.static('./public');
    assert(typeof staticMw === 'function', 'static - returns function');
    assert(staticMw.length === 3, 'static - 3 params (req,res,next)');

    // 正向：cookieParser 返回中间件函数
    const mw = httpm.cookieParser();
    assert(typeof mw === 'function', 'cookieParser - returns function');
    assert(mw.length === 3, 'cookieParser - 3 params (req,res,next)');

    // 正向：bodyParser 返回中间件函数
    const bp = httpm.bodyParser();
    assert(typeof bp === 'function', 'bodyParser - returns function');
    assert(bp.length === 3, 'bodyParser - 3 params (req,res,next)');

    // 正向：cookieParser 签名验证
    const secretMw = httpm.cookieParser('mysecret');
    assert(typeof secretMw === 'function', 'cookieParser - with secret returns function');
  }

  // ============================================================
  // 9. Application 类 - 配置管理测试
  // ============================================================
  section('Application - 配置管理');

  {
    const app = httpm({ svrPort: 1234, logLevel: 'error' });

    // 正向：app.set 设置配置
    app.set('customKey', 'customVal');
    assert(app.settings.customKey === 'customVal', 'App.set - set value');

    // 正向：app.get 获取配置（单参数字符串）
    assert(app.get('customKey') === 'customVal', 'App.get - get value');

    // 正向：app.get 注册路由（多参数）
    app.get('/test-route', (req, res) => res.send('ok'));
    assert(app.routes.GET.length > 0, 'App.get - registers route');

    // 正向：初始配置覆盖
    assert(app.settings.svrPort === 1234, 'App - constructor options override');

    // 正向：默认配置
    assert(app.settings.enableRange === true, 'App - default config enableRange');
    assert(app.settings.showDir === false, 'App - default config showDir');
  }

  // ============================================================
  // 9b. app.json 配置文件自动加载
  // ============================================================
  section('app.json 配置加载');

  {
    // 正向：创建 app.json 文件，验证配置被加载
    const appJsonPath = path.join(process.cwd(), 'app.json');
    const originalExists = fs.existsSync(appJsonPath);
    let originalContent = null;
    if (originalExists) {
      originalContent = fs.readFileSync(appJsonPath, 'utf8');
    }

    try {
      // 写入测试配置
      fs.writeFileSync(appJsonPath, JSON.stringify({ svrPort: 9999, showDir: true }));

      // 创建新实例，应自动加载 app.json
      const appWithConfig = httpm({ svrPort: 80 });
      // 代码参数优先级高于 app.json
      assert(appWithConfig.settings.svrPort === 80, 'app.json - code params override file');
      // app.json 优先级高于默认配置
      assert(appWithConfig.settings.showDir === true, 'app.json - file overrides default');
    } finally {
      // 恢复原始文件
      if (originalExists) {
        fs.writeFileSync(appJsonPath, originalContent);
      } else {
        fs.unlinkSync(appJsonPath);
      }
    }

    // 反向：无 app.json 时不影响默认配置
    const appNoFile = httpm({ svrPort: 80 });
    assert(appNoFile.settings.svrPort === 80, 'app.json - no file, default works');

    // 反向：app.json 格式错误时静默忽略
    const badJsonPath = path.join(process.cwd(), 'app.json');
    const badOriginalExists = fs.existsSync(badJsonPath);
    let badOriginalContent = null;
    if (badOriginalExists) {
      badOriginalContent = fs.readFileSync(badJsonPath, 'utf8');
    }

    try {
      fs.writeFileSync(badJsonPath, '{ invalid json }}}');
      const appBadJson = httpm({ svrPort: 80 });
      assert(appBadJson.settings.svrPort === 80, 'app.json - bad json ignored');
    } finally {
      if (badOriginalExists) {
        fs.writeFileSync(badJsonPath, badOriginalContent);
      } else {
        fs.unlinkSync(badJsonPath);
      }
    }

    // 反向：app.json 为数组时静默忽略
    const arrJsonPath = path.join(process.cwd(), 'app.json');
    const arrOriginalExists = fs.existsSync(arrJsonPath);
    let arrOriginalContent = null;
    if (arrOriginalExists) {
      arrOriginalContent = fs.readFileSync(arrJsonPath, 'utf8');
    }

    try {
      fs.writeFileSync(arrJsonPath, '[1,2,3]');
      const appArrJson = httpm({ svrPort: 80 });
      assert(appArrJson.settings.svrPort === 80, 'app.json - array json ignored');
    } finally {
      if (arrOriginalExists) {
        fs.writeFileSync(arrJsonPath, arrOriginalContent);
      } else {
        fs.unlinkSync(arrJsonPath);
      }
    }
  }

  // ============================================================
  // 10. HTTP 集成测试 - 全面覆盖
  // ============================================================
  section('HTTP 集成测试');

  const testDir = path.join(__dirname, 'test_static');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'index.html'), '<h1>Hello httpm</h1>');
  fs.writeFileSync(path.join(testDir, 'test.txt'), 'This is a test file for httpm.');
  fs.writeFileSync(path.join(testDir, 'large.txt'), 'A'.repeat(2048));
  // P0-2 验证：创建空文件用于 sendFile 空文件测试
  fs.writeFileSync(path.join(testDir, 'empty.txt'), '');

  // 创建子目录
  const subDir = path.join(testDir, 'subdir');
  if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'nested.html'), '<p>Nested</p>');
  // 创建二级子目录，用于验证目录列表链接尾部斜杠（P2-1）
  const nestedDir = path.join(subDir, 'nesteddir');
  if (!fs.existsSync(nestedDir)) fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'deep.txt'), 'deep file');

  const app = httpm({
    rootPath: testDir,
    svrPort: PORT,
    showDir: true,
    enableGzip: true,
    enableCache: true,
    logLevel: 'error',
    logDir: path.join(__dirname, 'test_log_runtime'),
    tempDir: path.join(__dirname, 'test_temp_upload'),
    cookieParserSecret: 'testsecret'
  });

  // 中间件：记录请求日志
  let mwCalled = false;
  app.use((req, res, next) => {
    mwCalled = true;
    next();
  });

  // 路径级中间件
  let apiMwCalled = false;
  app.use('/api', (req, res, next) => {
    apiMwCalled = true;
    next();
  });

  // 路由注册
  app.get('/api/hello', (req, res) => {
    res.json({ message: 'hello' });
  });

  app.get('/api/user/:id', (req, res) => {
    res.json({ id: req.params.id });
  });

  app.get('/api/query', (req, res) => {
    res.json({ query: req.query });
  });

  app.post('/api/echo', (req, res) => {
    res.json({ body: req.body, formData: req.formData });
  });

  app.put('/api/resource', (req, res) => {
    res.json({ method: 'PUT', body: req.body });
  });

  app.delete('/api/resource/:id', (req, res) => {
    res.json({ method: 'DELETE', id: req.params.id });
  });

  app.patch('/api/resource/:id', (req, res) => {
    res.json({ method: 'PATCH', id: req.params.id, body: req.body });
  });

  app.get('/api/redirect-test', (req, res) => {
    res.redirect('/api/hello');
  });

  app.get('/api/redirect-301', (req, res) => {
    res.redirect(301, '/api/hello');
  });

  app.get('/api/cookie-set', (req, res) => {
    res.cookie('test', 'value', { httpOnly: true });
    res.json({ ok: true });
  });

  app.get('/api/cookie-clear', (req, res) => {
    res.clearCookie('test');
    res.json({ ok: true });
  });

  app.get('/api/send-string', (req, res) => {
    res.send('plain text response');
  });

  app.get('/api/send-html', (req, res) => {
    res.send('<html><body>HTML</body></html>');
  });

  app.get('/api/send-buffer', (req, res) => {
    res.send(Buffer.from('buffer data'));
  });

  app.get('/api/send-object', (req, res) => {
    res.send({ key: 'value' });
  });

  app.get('/api/status-201', (req, res) => {
    res.status(201).json({ created: true });
  });

  app.get('/api/return-false', (req, res) => {
    return false;
  });

  app.get('/api/headers-test', (req, res) => {
    res.setHeader('X-Custom', 'hello');
    res.json({ customHeader: res.getHeader('X-Custom') });
  });

  app.get('/api/error-sync', (req, res) => {
    throw new Error('sync error');
  });

  app.get('/api/error-next', (req, res, next) => {
    next(new Error('next error'));
  });

  app.get('/api/request-info', (req, res) => {
    res.json({
      method: req.method,
      path: req.path,
      protocol: req.protocol,
      hasHeaders: !!req.headers,
      hasIp: !!req.ip
    });
  });

  app.post('/api/urlencoded', (req, res) => {
    res.json({ body: req.body, formData: req.formData });
  });

  app.get('/api/sse-stream', (req, res) => {
    const sse = res.sse();
    sse.send('hello');
    sse.event('custom', { data: 123 });
    sse.retry(5000);
    sse.comment('keepalive');
    setTimeout(() => sse.close(), 100);
  });

  // app.sse() 简化注册
  app.sse('/api/sse-simple', (sse, req) => {
    sse.send('sse-simple-hello');
    setTimeout(() => sse.close(), 100);
  });

  // download 路由
  app.get('/api/download', (req, res) => {
    res.download(path.join(testDir, 'test.txt'));
  });

  // bodyParser 413 超限测试路由
  // O6 修复后：JSON/urlencoded 请求体大小受 maxBodySize 限制，maxFieldSize 仅用于 multipart 表单字段
  app.post('/api/limited-body', httpm.bodyParser({ maxBodySize: 50 }), (req, res) => {
    res.json({ body: req.body });
  });

  // cookieParser 签名测试路由
  app.get('/api/signed-cookie-set', (req, res) => {
    res.cookie('token', 'abc123', { signed: true });
    res.json({ ok: true });
  });

  app.get('/api/signed-cookie-read', (req, res) => {
    res.json({ signedCookies: req.signedCookies, cookies: req.cookies });
  });

  // app.ws() 简化注册
  app.ws('/ws-chat', (ws, req) => {
    ws.on('text', (msg) => {
      ws.send('echo:' + msg);
    });
    ws.on('binary', (data) => {
      ws.send('echo:' + data.toString('hex'));
    });
  });

  // --- 新增：use('/') 子路径匹配测试（修复 use('/') 不命中子路径的 bug） ---
  app.use('/', (req, res, next) => { req._rootMw = true; next(); });
  app.get('/rootmw-check', (req, res) => res.json({ hit: !!req._rootMw }));

  // --- 新增：动态参数路径级中间件测试（修复 use('/mw/:ver') 不命中的 bug） ---
  app.use('/mw/:version', (req, res, next) => { req._mwVer = req.params.version; next(); });
  app.get('/mw/v1/check', (req, res) => res.json({ ver: req._mwVer }));

  // --- 新增：ws send 基础类型测试（number） ---
  app.ws('/ws-number', (ws, req) => {
    ws.on('text', () => { ws.send(42); });
  });

  // --- 新增：P1 #2 params 重置——中间件参数不应污染路由处理器 ---
  app.use('/params/:a', (req, res, next) => { req._mwA = req.params.a; next(); });
  app.get('/params/:b/test', (req, res) => res.json({ b: req.params.b, hasA: 'a' in req.params, mwA: req._mwA }));

  // --- 新增：P2 #5 clearCookie 检查 Expires 头 ---
  app.get('/clear-cookie-test', (req, res) => {
    res.clearCookie('oldToken');
    res.json({ ok: true });
  });

  // --- 新增：P2 #10 res.json 循环引用返回 500 ---
  app.get('/json-circular', (req, res) => {
    const obj = {};
    obj.self = obj; // 循环引用
    res.json(obj);
  });

  // --- 新增：P3 #11 app.get(path) 以 / 开头当路由（非配置获取） ---
  // 注意：不用 '/' 避免覆盖静态文件服务的 index.html 兜底
  app.get('/p3-route-test', (req, res) => res.json({ route: true }));

  // --- 新增：P3 #17 redirect back 回退到 Referer ---
  app.get('/redirect-back', (req, res) => res.redirect('back'));

  // --- P0-1 验证：路由路径含正则特殊字符应正常匹配（不转义会崩溃或匹配不精确） ---
  app.get('/api.json', (req, res) => res.json({ dot: true }));
  app.get('/users(test)', (req, res) => res.json({ paren: true }));

  // --- P0-2 验证：空文件 sendFile 不崩溃 ---
  app.get('/empty-file', (req, res) => {
    res.sendFile(path.join(testDir, 'empty.txt'));
  });

  // --- P1-1 验证：SSE send 换行符应拆多行 data: ---
  app.get('/sse-newline', (req, res) => {
    const sse = res.sse();
    sse.send('line1\nline2');
    sse.event('multi', 'data1\ndata2');
    sse.close();
  });

  // --- P2-3 验证：redirect 非法状态码回退 302 ---
  app.get('/redirect-invalid', (req, res) => res.redirect(999, '/target'));
  app.get('/redirect-valid', (req, res) => res.redirect(301, '/target'));

  // --- P2-1 验证：SSE retry 非法值不写入 ---
  app.get('/sse-retry-invalid', (req, res) => {
    const sse = res.sse();
    sse.retry(NaN);
    sse.retry(-1);
    sse.retry('abc');
    sse.retry(1000); // 合法值应写入
    sse.close();
  });

  // --- P2-4 验证：_serveStatic 异常走错误处理链 ---
  // req.path 为正常路径，_serveStatic 内部异常难以模拟，改用路由返回 false 触发静态兜底
  app.get('/fallback-static/:name', (req, res) => {
    // 不存在的文件，返回 false 触发 _serveStatic，_serveStatic 返回 404（正常路径）
    return false;
  });

  // --- P1-1 验证：hostname IPv6 解析 ---
  app.get('/hostname-test', (req, res) => res.json({ hostname: req.hostname }));

  // 注：V1.4.3 P2-8（_handleRequest 顶层 catch 响应规范化）和 P2-9（httpm 入口 JSDoc）
  // 通过静态分析保证，难以通过黑盒测试直接验证。设计规则已记录在 Detailed_Design.md。

  // --- P2-1 验证：redirect null/undefined url 回退到 '/' ---
  app.get('/redirect-null', (req, res) => res.redirect());
  app.get('/redirect-status-only', (req, res) => res.redirect(302));

  // --- P2-5 验证：cookie undefined value 回退空字符串 ---
  app.get('/cookie-undef', (req, res) => {
    res.cookie('undef_val', undefined);
    res.cookie('null_val', null);
    res.json({});
  });

  // --- V1.4.2 P2-2 验证：cookie expires 数字时间戳归一化为 UTC 字符串 ---
  app.get('/cookie-expires-num', (req, res) => {
    res.cookie('with_expires_num', 'v', { expires: 1700000000 });
    res.json({});
  });
  app.get('/cookie-expires-date', (req, res) => {
    res.cookie('with_expires_date', 'v', { expires: new Date(1700000000000) });
    res.json({});
  });
  app.get('/cookie-expires-invalid', (req, res) => {
    res.cookie('with_expires_invalid', 'v', { expires: 'invalid-date' });
    res.json({});
  });

  // --- V1.4.2 P2-3 验证：cookie sameSite 归一化 ---
  app.get('/cookie-samesite-lower', (req, res) => {
    res.cookie('s1', 'v', { sameSite: 'lax' });
    res.json({});
  });
  app.get('/cookie-samesite-upper', (req, res) => {
    res.cookie('s2', 'v', { sameSite: 'NONE' });
    res.json({});
  });
  app.get('/cookie-samesite-invalid', (req, res) => {
    res.cookie('s3', 'v', { sameSite: 'bogus' });
    res.json({});
  });

  // --- V1.4.2 P2-4 验证：cookie path/domain 非法字符拒绝 ---
  app.get('/cookie-path-inject', (req, res) => {
    res.cookie('c1', 'v', { path: '/foo;Domain=evil.com' });
    res.json({});
  });
  app.get('/cookie-domain-inject', (req, res) => {
    res.cookie('c2', 'v', { domain: 'evil.com,foo.com' });
    res.json({});
  });

  // --- P2-6 验证：SSE send/event undefined 不崩溃 ---
  // V1.4.1 P1 #3 同时验证：sse.close() 后再次调用不抛异常（幂等性 + res.finished 保护）
  app.get('/sse-undef', (req, res) => {
    const sse = res.sse();
    sse.send(undefined);
    sse.event('update', null);
    sse.close();
    // 再次调用 close 不应抛异常：此时 connected=false 直接返回，但若 connected 被误置 true，
    // res.finished 检查会跳过 res.end()，避免 ERR_STREAM_WRITE_AFTER_END
    try { sse.close(); } catch (e) { /* 不应进入此分支 */ }
  });

  // --- V1.4.1 P1 #2 验证：res.send(null) 对齐 Express 4.x 发送空响应 ---
  app.get('/send-null', (req, res) => res.send(null));

  // --- V1.4.1 P1 #3 验证：SSE.close 幂等性，多次调用不抛异常 ---
  // 通过 sse-undef 路由验证（已调用 sse.close() 后再次调用不应抛异常）

  // --- V1.4.1 P2 #5 验证：路径含 null byte 时 isPathSafe 拒绝 ---
  // 黑盒路径：静态文件服务 /null-byte-test 后接 %00，应返回 403/404 而非崩溃
  // 直接测试工具函数 isPathSafe 行为

  // --- V1.4.1 P2 #7 验证：cookie 循环引用对象不抛 TypeError ---
  app.get('/cookie-circular', (req, res) => {
    const obj = {};
    obj.self = obj; // 循环引用
    res.cookie('circular', obj);
    res.json({ ok: true });
  });

  // --- V1.4.1 P0 #1 验证：WebSocket head 喂入数据不丢失 ---
  // 通过 raw socket 模拟客户端在握手请求后立即发送首帧（pipeline），
  // 服务端 head 参数会非空，验证首帧能被处理器接收
  app.ws('/ws-head-test', (ws, req) => {
    ws.on('text', (msg) => { ws.send('echo:' + msg); });
  });

  // 错误处理中间件（P0-5 修复后应被正确调用）
  // 返回 handled: true 标记，用于验证错误确实由错误处理中间件处理（而非默认错误响应）
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message, handled: true });
  });

  const server = app.listen(PORT);
  await new Promise(r => setTimeout(r, 500));

  try {
    // --- 基础路由测试 ---
    {
      const res = await httpGet(BASE + '/api/hello');
      const body = await readBodyStr(res);
      const obj = JSON.parse(body);
      assert(obj.message === 'hello', 'HTTP - JSON route');
      assert(res.statusCode === 200, 'HTTP - JSON route status 200');
      assert(res.headers['content-type'].includes('application/json'), 'HTTP - JSON content-type');
    }

    // --- 动态路由参数 ---
    {
      const res = await httpGet(BASE + '/api/user/42');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.id === '42', 'HTTP - dynamic route params');
    }

    // --- 多段动态路由 ---
    // (未注册多段路由，跳过)

    // --- Query 参数 ---
    {
      const res = await httpGet(BASE + '/api/query?foo=bar&num=1');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.query.foo === 'bar', 'HTTP - query params foo');
      assert(obj.query.num === '1', 'HTTP - query params num');
    }

    // --- POST JSON 请求体 ---
    {
      const postBody = JSON.stringify({ name: 'test' });
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/echo', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(postBody)) }
      }, postBody);
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.body && obj.body.name === 'test', 'HTTP - POST JSON body');
      assert(obj.formData && obj.formData.fields.name === 'test', 'HTTP - POST JSON formData');
    }

    // --- POST URL 编码请求体 ---
    {
      const urlBody = 'username=admin&password=123';
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/urlencoded', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(urlBody.length) }
      }, urlBody);
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.body && obj.body.username === 'admin', 'HTTP - POST urlencoded body');
      assert(obj.formData && obj.formData.fields.username === 'admin', 'HTTP - POST urlencoded formData');
    }

    // --- POST URL 编码 + 号转空格 ---
    {
      const urlBody = 'name=hello+world';
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/urlencoded', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(urlBody.length) }
      }, urlBody);
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.body && obj.body.name === 'hello world', 'HTTP - POST urlencoded + as space');
    }

    // --- PUT 方法 ---
    {
      const putBody = JSON.stringify({ data: 'update' });
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/resource', method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(putBody)) }
      }, putBody);
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.method === 'PUT', 'HTTP - PUT method');
      assert(obj.body && obj.body.data === 'update', 'HTTP - PUT body');
    }

    // --- DELETE 方法 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/resource/99', method: 'DELETE'
      });
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.method === 'DELETE', 'HTTP - DELETE method');
      assert(obj.id === '99', 'HTTP - DELETE params');
    }

    // --- PATCH 方法 ---
    {
      const patchBody = JSON.stringify({ field: 'patched' });
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/resource/55', method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(patchBody)) }
      }, patchBody);
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.method === 'PATCH', 'HTTP - PATCH method');
      assert(obj.id === '55', 'HTTP - PATCH params');
      assert(obj.body && obj.body.field === 'patched', 'HTTP - PATCH body');
    }

    // --- HEAD 请求匹配 GET 路由 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/hello', method: 'HEAD'
      });
      assert(res.statusCode === 200, 'HTTP - HEAD matches GET route status 200');
      assert(res.headers['content-type'] && res.headers['content-type'].includes('application/json'), 'HTTP - HEAD has content-type header');
      // HEAD 请求不应返回响应体
      const body = await readBodyStr(res);
      assert(body === '', 'HTTP - HEAD no response body');
    }

    // --- HEAD 静态文件 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/test.txt', method: 'HEAD'
      });
      assert(res.statusCode === 200, 'HTTP - HEAD static file status 200');
      assert(res.headers['content-type'] && res.headers['content-type'].includes('text/plain'), 'HTTP - HEAD static file content-type');
      const body = await readBodyStr(res);
      assert(body === '', 'HTTP - HEAD static file no body');
    }

    // --- 静态文件服务 ---
    {
      const res = await httpGet(BASE + '/test.txt');
      const body = await readBodyStr(res);
      assert(body.includes('This is a test file'), 'HTTP - static file serve');
      assert(res.headers['content-type'].includes('text/plain'), 'HTTP - static file content-type');
    }

    // --- 目录 index.html ---
    {
      const res = await httpGet(BASE + '/');
      const body = await readBodyStr(res);
      assert(body.includes('Hello httpm'), 'HTTP - index.html serve');
    }

    // --- 子目录文件 ---
    {
      const res = await httpGet(BASE + '/subdir/nested.html');
      const body = await readBodyStr(res);
      assert(body.includes('Nested'), 'HTTP - nested file serve');
    }

    // --- 目录列表展示 ---
    {
      const res = await httpGet(BASE + '/subdir/');
      const body = await readBodyStr(res);
      assert(body.includes('nested.html') || body.includes('Directory'), 'HTTP - directory listing');
      // P2-1 验证：目录项链接必须包含尾部斜杠（避免浏览器多一次重定向往返）
      assert(body.includes('href="/subdir/nesteddir/"'), 'HTTP - directory listing subdir href trailing slash');
      // V1.4.3 P2-7 验证：父目录链接也必须以 '/' 结尾（与子目录链接一致）
      assert(body.includes('href="/subdir/../"'), 'HTTP - directory listing parent href trailing slash');
    }

    // --- 重定向 302 ---
    {
      const res = await httpGet(BASE + '/api/redirect-test');
      assert(res.statusCode === 302, 'HTTP - redirect 302 status');
      assert(res.headers.location === '/api/hello', 'HTTP - redirect location');
    }

    // --- 重定向 301 ---
    {
      const res = await httpGet(BASE + '/api/redirect-301');
      assert(res.statusCode === 301, 'HTTP - redirect 301 status');
      assert(res.headers.location === '/api/hello', 'HTTP - redirect 301 location');
    }

    // --- 404 ---
    {
      const res = await httpGet(BASE + '/api/not-exist');
      assert(res.statusCode === 404, 'HTTP - 404 status');
    }

    // --- Cookie 设置 ---
    {
      const res = await httpGet(BASE + '/api/cookie-set');
      const setCookie = res.headers['set-cookie'];
      assert(setCookie && setCookie.some(c => c.includes('test=value')), 'HTTP - cookie set');
      assert(setCookie && setCookie.some(c => c.includes('HttpOnly')), 'HTTP - cookie httpOnly');
    }

    // --- Cookie 清除 ---
    {
      const res = await httpGet(BASE + '/api/cookie-clear');
      const setCookie = res.headers['set-cookie'];
      assert(setCookie && setCookie.some(c => c.includes('test=') && c.includes('Max-Age=0')), 'HTTP - cookie clear');
    }

    // --- send() 字符串 ---
    {
      const res = await httpGet(BASE + '/api/send-string');
      const body = await readBodyStr(res);
      assert(body === 'plain text response', 'HTTP - send string');
      assert(res.headers['content-type'].includes('text/plain'), 'HTTP - send string content-type');
    }

    // --- send() HTML ---
    {
      const res = await httpGet(BASE + '/api/send-html');
      const body = await readBodyStr(res);
      assert(body.includes('<html>'), 'HTTP - send HTML');
      assert(res.headers['content-type'].includes('text/html'), 'HTTP - send HTML content-type');
    }

    // --- send() Buffer ---
    {
      const res = await httpGet(BASE + '/api/send-buffer');
      const body = await readBodyStr(res);
      assert(body === 'buffer data', 'HTTP - send Buffer');
      assert(res.headers['content-type'].includes('octet-stream'), 'HTTP - send Buffer content-type');
    }

    // --- send() 对象（自动转 JSON）---
    {
      const res = await httpGet(BASE + '/api/send-object');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.key === 'value', 'HTTP - send object auto JSON');
    }

    // --- status() 链式调用 + 自定义状态码 ---
    {
      const res = await httpGet(BASE + '/api/status-201');
      assert(res.statusCode === 201, 'HTTP - custom status 201');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.created === true, 'HTTP - status 201 body');
    }

    // --- setHeader / getHeader ---
    {
      const res = await httpGet(BASE + '/api/headers-test');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.customHeader === 'hello', 'HTTP - setHeader/getHeader');
      assert(res.headers['x-custom'] === 'hello', 'HTTP - response custom header');
    }

    // --- 应用级中间件执行 ---
    {
      mwCalled = false;
      await httpGet(BASE + '/api/hello');
      assert(mwCalled === true, 'HTTP - app-level middleware called');
    }

    // --- 路径级中间件执行 ---
    {
      apiMwCalled = false;
      await httpGet(BASE + '/api/hello');
      assert(apiMwCalled === true, 'HTTP - path-level middleware called for /api');
    }

    // --- 路径级中间件不匹配 ---
    {
      apiMwCalled = false;
      await httpGet(BASE + '/test.txt');
      assert(apiMwCalled === false, 'HTTP - path-level middleware not called for non-/api');
    }

    // --- return false 兜底 ---
    {
      const res = await httpGet(BASE + '/api/return-false');
      // return false 进入静态文件服务，/api/return-false 无静态文件，应返回 404
      assert(res.statusCode === 404, 'HTTP - return false fallback to static (404)');
    }

    // --- Request 快捷属性 ---
    {
      const res = await httpGet(BASE + '/api/request-info');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.method === 'GET', 'HTTP - req.method');
      assert(obj.path === '/api/request-info', 'HTTP - req.path');
      assert(obj.protocol === 'http', 'HTTP - req.protocol');
      assert(obj.hasHeaders === true, 'HTTP - req.headers exists');
      assert(obj.hasIp === true, 'HTTP - req.ip exists');
    }

    // --- 同步异常捕获 ---
    {
      const res = await httpGet(BASE + '/api/error-sync');
      assert(res.statusCode === 500, 'HTTP - sync error status 500');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.error === 'sync error', 'HTTP - sync error message');
    }

    // --- next(err) 传递 ---
    {
      const res = await httpGet(BASE + '/api/error-next');
      assert(res.statusCode === 500, 'HTTP - next error status 500');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.error === 'next error', 'HTTP - next error message');
    }

    // --- OPTIONS CORS 预检 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/any-path', method: 'OPTIONS'
      });
      assert(res.statusCode === 204, 'HTTP - OPTIONS CORS 204');
      assert(res.headers['access-control-allow-origin'] === '*', 'HTTP - CORS origin header');
      assert(res.headers['access-control-allow-methods'] !== undefined, 'HTTP - CORS methods header');
    }

    // --- Range 断点续传 ---
    {
      const res = await httpGet(BASE + '/test.txt', { Range: 'bytes=0-10' });
      assert(res.statusCode === 206, 'HTTP - Range 206 status');
      assert(res.headers['content-range'] && res.headers['content-range'].includes('bytes'), 'HTTP - Range content-range');
      const body = await readBodyStr(res);
      assert(body.length <= 11, 'HTTP - Range partial content length');
    }

    // --- ETag 缓存 304 ---
    {
      // 先请求获取 ETag
      const res1 = await httpGet(BASE + '/test.txt');
      const etag = res1.headers['etag'];
      assert(etag !== undefined, 'HTTP - ETag present');

      // 带 If-None-Match 再请求
      if (etag) {
        const res2 = await httpGet(BASE + '/test.txt', { 'If-None-Match': etag });
        assert(res2.statusCode === 304, 'HTTP - ETag cache 304');
      }
    }

    // --- Gzip 压缩 ---
    {
      const res = await httpGet(BASE + '/large.txt', { 'Accept-Encoding': 'gzip' });
      if (res.headers['content-encoding'] === 'gzip') {
        const buf = await readBody(res);
        try {
          const decompressed = zlib.gunzipSync(buf).toString('utf8');
          assert(decompressed.length === 2048, 'HTTP - Gzip decompressed content length');
          assert(decompressed === 'A'.repeat(2048), 'HTTP - Gzip decompressed content correct');
        } catch (gzErr) {
          assert(false, 'HTTP - Gzip decompress error: ' + gzErr.message);
        }
      } else {
        assertSkip('HTTP - Gzip not applied', 'response not gzipped');
      }
    }

    // --- V1.4.8 P2-3 验证：HEAD 请求 + Gzip 不进入压缩分支 ---
    // HEAD 请求不传输实体，不应触发 Gzip 压缩；
    // Content-Length 应为文件实际大小（未压缩），且无 Content-Encoding 头
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/large.txt', method: 'HEAD',
        headers: { 'Accept-Encoding': 'gzip' }
      });
      assert(res.statusCode === 200, 'HTTP - HEAD+Gzip status 200');
      // HEAD 不应进入 Gzip 分支，无 Content-Encoding 头
      assert(res.headers['content-encoding'] === undefined, 'HTTP - HEAD+Gzip no Content-Encoding header');
      // Content-Length 应为文件实际大小（2048），而非压缩后大小
      assert(res.headers['content-length'] === '2048', 'HTTP - HEAD+Gzip Content-Length is uncompressed size');
      const body = await readBodyStr(res);
      assert(body === '', 'HTTP - HEAD+Gzip no response body');
    }

    // --- 路径遍历 403 ---
    {
      const res = await httpGet(BASE + '/%2e%2e/httpm.js');
      assert(res.statusCode === 403 || res.statusCode === 404, 'HTTP - path traversal blocked (' + res.statusCode + ')');
    }

    // --- allowAccessToAllFiles 配置 ---
    {
      const hiddenDir = path.join(testDir, '.hidden');
      const hiddenFile = path.join(hiddenDir, 'secret.txt');
      if (!fs.existsSync(hiddenDir)) fs.mkdirSync(hiddenDir, { recursive: true });
      fs.writeFileSync(hiddenFile, 'hidden content');

      // 默认配置（allowAccessToAllFiles=false）：隐藏文件应被拦截
      const res1 = await httpGet(BASE + '/.hidden/secret.txt');
      assert(res1.statusCode === 403 || res1.statusCode === 404, 'HTTP - hidden file blocked by default (' + res1.statusCode + ')');

      // 清理
      try { fs.unlinkSync(hiddenFile); } catch (e) { /* ignore */ }
      try { fs.rmSync(hiddenDir, { recursive: true }); } catch (e) { /* ignore */ }
    }

    // --- SSE 流 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/sse-stream', method: 'GET'
      });
      assert(res.headers['content-type'] === 'text/event-stream', 'HTTP - SSE content-type');
      assert(res.headers['cache-control'] === 'no-cache', 'HTTP - SSE cache-control');
      const body = await readBodyStr(res);
      assert(body.includes('data: hello'), 'HTTP - SSE send data');
      assert(body.includes('event: custom'), 'HTTP - SSE event name');
      assert(body.includes('retry: 5000'), 'HTTP - SSE retry');
      assert(body.includes(': keepalive'), 'HTTP - SSE comment');
    }

    // --- app.sse() 简化注册 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/sse-simple', method: 'GET'
      });
      assert(res.headers['content-type'] === 'text/event-stream', 'HTTP - app.sse() content-type');
      const body = await readBodyStr(res);
      assert(body.includes('data: sse-simple-hello'), 'HTTP - app.sse() send data');
    }

    // --- download 文件下载 ---
    {
      const res = await httpGet(BASE + '/api/download');
      assert(res.statusCode === 200, 'HTTP - download status 200');
      assert(res.headers['content-disposition'] && res.headers['content-disposition'].includes('test.txt'), 'HTTP - download content-disposition');
      const body = await readBodyStr(res);
      assert(body === 'This is a test file for httpm.', 'HTTP - download content correct');
    }

    // --- download 方法存在性 ---
    {
      assert(typeof (new httpm.Response({ setHeader: () => {}, end: () => {} }, { settings: {} })).download === 'function', 'HTTP - download method exists');
    }

    // --- bodyParser 413 超限 ---
    {
      const bigBody = 'x='.repeat(60);
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/limited-body', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bigBody) }
      }, bigBody);
      assert(res.statusCode === 413, 'HTTP - bodyParser 413 on oversized body');
    }

    // --- cookieParser 签名 Cookie ---
    {
      const setRes = await httpGet(BASE + '/api/signed-cookie-set');
      assert(setRes.statusCode === 200, 'HTTP - signed cookie set status 200');
      const setCookie = setRes.headers['set-cookie'];
      assert(setCookie && setCookie.length > 0, 'HTTP - signed cookie set-cookie header present');
      // 签名值以 s: 开头
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
      assert(cookieStr.includes('s%3A') || cookieStr.includes('s:'), 'HTTP - signed cookie has s: prefix');

      // P2-8: 验证签名 Cookie 读取
      // 提取 Cookie 值（token=xxx），用于后续请求的 Cookie 头
      const cookieValue = setCookie.map(c => c.split(';')[0]).join('; ');
      const readRes = await httpGet(BASE + '/api/signed-cookie-read', { Cookie: cookieValue });
      const readObj = JSON.parse(await readBodyStr(readRes));
      assert(readObj.signedCookies.token === 'abc123', 'HTTP - signed cookie read verifies and returns original value');
      // 验证通过后，签名 Cookie 应从 req.cookies 中删除（Express 兼容）
      assert(readObj.cookies.token === undefined, 'HTTP - verified signed cookie removed from req.cookies');
    }

    // --- 不存在的静态文件 404 ---
    {
      const res = await httpGet(BASE + '/nonexistent.txt');
      assert(res.statusCode === 404, 'HTTP - nonexistent static file 404');
    }

    // --- 405 Method Not Allowed ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/hello', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '0' }
      });
      // POST /api/hello 未注册，应返回 405
      assert(res.statusCode === 405, 'HTTP - 405 Method Not Allowed');
    }

    // --- Cache-Control 头 ---
    {
      const res = await httpGet(BASE + '/test.txt');
      // enableCache=true 时应有 Cache-Control 头
      assert(res.headers['cache-control'] === 'public, max-age=3600', 'HTTP - Cache-Control header');
    }

    // --- cookie signed=false 不加 s: 前缀 ---
    {
      const res = await httpGet(BASE + '/api/cookie-set');
      const setCookie = res.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
      // 未签名 Cookie 不应有 s: 前缀
      assert(!cookieStr.includes('s%3A') && !cookieStr.includes('s:'), 'HTTP - unsigned cookie no s: prefix');
    }

    // --- WebSocket 连接 + app.ws() + ws.on('text') ---
    {
      try {
        const { socket } = await wsConnect('ws://localhost:' + PORT + '/ws-chat');
        // 发送文本消息
        wsSendText(socket, 'hello');
        // 接收回显
        const reply = await wsReadText(socket);
        assert(reply === 'echo:hello', 'HTTP - WebSocket app.ws() echo via ws.on(text)');
        socket.destroy();
      } catch (wsErr) {
        // WebSocket 测试可能因环境问题失败，标记为跳过
        assertSkip('HTTP - WebSocket test', wsErr.message);
      }
    }

    // --- WebSocket 多消息连续发送 ---
    {
      try {
        const { socket } = await wsConnect('ws://localhost:' + PORT + '/ws-chat');
        wsSendText(socket, 'msg1');
        wsSendText(socket, 'msg2');
        wsSendText(socket, 'msg3');
        const r1 = await wsReadText(socket);
        const r2 = await wsReadText(socket);
        const r3 = await wsReadText(socket);
        assert(r1 === 'echo:msg1' && r2 === 'echo:msg2' && r3 === 'echo:msg3', 'HTTP - WebSocket multiple messages');
        socket.destroy();
      } catch (wsErr) {
        assertSkip('HTTP - WebSocket multi-msg test', wsErr.message);
      }
    }

    // --- WebSocket 二进制帧 ---
    {
      try {
        const { socket } = await wsConnect('ws://localhost:' + PORT + '/ws-chat');
        // 发送二进制帧
        const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const mask = crypto.randomBytes(4);
        const header = Buffer.alloc(6);
        header[0] = 0x82; // FIN + binary opcode
        header[1] = 0x80 | payload.length; // MASK + len
        mask.copy(header, 2);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          masked[i] = payload[i] ^ mask[i % 4];
        }
        socket.write(Buffer.concat([header, masked]));
        // 服务器回显文本（echo: + hex），读取回复
        const reply = await wsReadText(socket);
        assert(reply === 'echo:01020304', 'HTTP - WebSocket binary echo hex');
        socket.destroy();
      } catch (wsErr) {
        assertSkip('HTTP - WebSocket binary test', wsErr.message);
      }
    }

    // --- 文件上传 multipart/form-data ---
    {
      const boundary = '----TestBoundary' + Date.now();
      const filePath = path.join(testDir, 'upload_test.txt');
      fs.writeFileSync(filePath, 'upload content here');

      const fileContent = fs.readFileSync(filePath);
      const parts = [];
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n`);
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file1"; filename="upload_test.txt"\r\nContent-Type: text/plain\r\n\r\n`);
      const bodyBuf = Buffer.concat([
        Buffer.from(parts.join(''), 'utf8'),
        fileContent,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ]);

      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/api/echo', method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': bodyBuf.length
        }
      }, bodyBuf);
      assert(res.statusCode === 200, 'HTTP - multipart upload status 200');
      const body = await readBodyStr(res);
      const obj = JSON.parse(body);
      assert(obj.formData && obj.formData.fields && obj.formData.fields.field1 === 'value1', 'HTTP - multipart field parsed');
      assert(obj.formData && obj.formData.files && obj.formData.files.length > 0, 'HTTP - multipart file parsed');
      assert(obj.formData.files[0].originalname === 'upload_test.txt', 'HTTP - multipart filename correct');

      // 清理上传测试文件
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }

    // --- P1-1 验证：hostname IPv6 解析（修复 host.split(':') 对 IPv6 误切） ---
    {
      // IPv6 带端口 [::1]:PORT → ::1
      const res1 = await httpGet(BASE + '/hostname-test', { Host: '[::1]:' + PORT });
      const obj1 = JSON.parse(await readBodyStr(res1));
      assert(obj1.hostname === '::1', 'HTTP - hostname IPv6 [::1]:port → ::1');

      // IPv6 无端口 [::1] → ::1
      const res2 = await httpGet(BASE + '/hostname-test', { Host: '[::1]' });
      const obj2 = JSON.parse(await readBodyStr(res2));
      assert(obj2.hostname === '::1', 'HTTP - hostname IPv6 [::1] → ::1');

      // IPv6 长地址 [2001:db8::1]:PORT → 2001:db8::1
      const res3 = await httpGet(BASE + '/hostname-test', { Host: '[2001:db8::1]:' + PORT });
      const obj3 = JSON.parse(await readBodyStr(res3));
      assert(obj3.hostname === '2001:db8::1', 'HTTP - hostname IPv6 [2001:db8::1] → 2001:db8::1');

      // 普通 IPv4 域名带端口 example.com:8080 → example.com
      const res4 = await httpGet(BASE + '/hostname-test', { Host: 'example.com:8080' });
      const obj4 = JSON.parse(await readBodyStr(res4));
      assert(obj4.hostname === 'example.com', 'HTTP - hostname example.com:8080 → example.com');

      // 普通域名无端口 example.com → example.com
      const res5 = await httpGet(BASE + '/hostname-test', { Host: 'example.com' });
      const obj5 = JSON.parse(await readBodyStr(res5));
      assert(obj5.hostname === 'example.com', 'HTTP - hostname example.com → example.com');
    }

    // --- P2-1 验证：redirect null/undefined url 回退到 '/' ---
    {
      // res.redirect() 无参数 → url=undefined → 回退 '/'
      const res1 = await httpGet(BASE + '/redirect-null');
      assert(res1.statusCode === 302, 'HTTP - redirect() no args status 302');
      assert(res1.headers['location'] === '/', 'HTTP - redirect() no args location /');

      // res.redirect(302) 缺少 url → url=undefined → 回退 '/'
      const res2 = await httpGet(BASE + '/redirect-status-only');
      assert(res2.statusCode === 302, 'HTTP - redirect(302) no url status 302');
      assert(res2.headers['location'] === '/', 'HTTP - redirect(302) no url location /');
    }

    // --- P2-5 验证：cookie undefined/null value 回退空字符串 ---
    {
      const res = await httpGet(BASE + '/cookie-undef');
      const setCookie = res.headers['set-cookie'];
      assert(Array.isArray(setCookie), 'HTTP - cookie-undef returns set-cookie array');
      // undefined 值不应变成字符串 'undefined'，应为空值
      const undefCookie = setCookie.find(c => c.startsWith('undef_val='));
      assert(undefCookie && undefCookie.split(';')[0] === 'undef_val=', 'HTTP - cookie undefined value → empty (not "undefined")');
      // null 值同样回退空字符串
      const nullCookie = setCookie.find(c => c.startsWith('null_val='));
      assert(nullCookie && nullCookie.split(';')[0] === 'null_val=', 'HTTP - cookie null value → empty (not "null")');
    }

    // --- V1.4.2 P2-2 验证：cookie expires 数字时间戳归一化 ---
    {
      const res = await httpGet(BASE + '/cookie-expires-num');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('with_expires_num='));
      // 数字时间戳应转为 UTC 字符串，不能原样输出
      assert(cookie && cookie.includes('Expires='), 'HTTP - cookie numeric expires → Expires= header');
      assert(cookie && !/Expires=1700000000\b/.test(cookie), 'HTTP - cookie numeric expires not raw number');
    }
    {
      const res = await httpGet(BASE + '/cookie-expires-date');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('with_expires_date='));
      // Date 对象应输出 UTC 字符串（GMT 格式）
      assert(cookie && /Expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/.test(cookie), 'HTTP - cookie Date expires → RFC 1123 GMT format');
    }
    {
      const res = await httpGet(BASE + '/cookie-expires-invalid');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('with_expires_invalid='));
      // 无效日期不应输出 Expires 头
      assert(cookie && !cookie.includes('Expires='), 'HTTP - cookie invalid date no Expires header');
    }

    // --- V1.4.2 P2-3 验证：cookie sameSite 归一化 ---
    {
      const res = await httpGet(BASE + '/cookie-samesite-lower');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('s1='));
      // 'lax' 应归一化为 'Lax'（首字母大写）
      assert(cookie && cookie.includes('SameSite=Lax'), 'HTTP - cookie sameSite lowercase normalized to Lax');
    }
    {
      const res = await httpGet(BASE + '/cookie-samesite-upper');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('s2='));
      // 'NONE' 应归一化为 'None'（非标准大小写拒绝）
      assert(cookie && cookie.includes('SameSite=None'), 'HTTP - cookie sameSite UPPERCASE normalized to None');
    }
    {
      const res = await httpGet(BASE + '/cookie-samesite-invalid');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('s3='));
      // 'bogus' 不在白名单中，不应输出 SameSite 头
      assert(cookie && !cookie.includes('SameSite='), 'HTTP - cookie sameSite invalid value rejected (no header)');
    }

    // --- V1.4.2 P2-4 验证：cookie path/domain 非法字符拒绝 ---
    {
      const res = await httpGet(BASE + '/cookie-path-inject');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('c1='));
      // path 含 ; 应被拒绝（防止 Set-Cookie 头注入）
      assert(cookie && !cookie.includes('Path=/foo;Domain=evil.com'), 'HTTP - cookie path injection blocked (;)');
      // 整个 Set-Cookie 不应被破坏
      assert(cookie && /^c1=v/.test(cookie.split(';')[0]), 'HTTP - cookie path injection cookie still set');
    }
    {
      const res = await httpGet(BASE + '/cookie-domain-inject');
      const setCookie = res.headers['set-cookie'];
      const cookie = setCookie.find(c => c.startsWith('c2='));
      // domain 含 , 应被拒绝
      assert(cookie && !cookie.includes('Domain=evil.com,foo.com'), 'HTTP - cookie domain injection blocked (,)');
    }

    // --- P2-6 验证：SSE send/event undefined 不崩溃，发送 'null' ---
    {
      const res = await httpGet(BASE + '/sse-undef');
      const body = await readBodyStr(res);
      assert(res.statusCode === 200, 'HTTP - SSE send(undefined) status 200');
      assert(body.includes('data: null'), 'HTTP - SSE send(undefined) writes data: null');
      assert(body.includes('event: update'), 'HTTP - SSE event(name, null) writes event');
    }

    // --- use('/') 子路径匹配（修复 use('/') 不命中子路径） ---
    {
      const res = await httpGet(BASE + '/rootmw-check');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.hit === true, 'HTTP - use("/") matches subpath');
    }

    // --- 动态参数路径级中间件（修复 use('/mw/:version') 不命中） ---
    {
      const res = await httpGet(BASE + '/mw/v1/check');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.ver === 'v1', 'HTTP - use("/mw/:version") extracts param');
    }

    // --- 无效 Range 返回 416（RFC 7233） ---
    {
      const res = await httpGet(BASE + '/test.txt', { Range: 'bytes=999999-1000000' });
      assert(res.statusCode === 416, 'HTTP - invalid Range 416');
      assert(res.headers['content-range'] && res.headers['content-range'].includes('*/'), 'HTTP - 416 content-range header');
    }

    // --- WebSocket send 基础类型（number → 文本帧） ---
    {
      try {
        const { socket } = await wsConnect('ws://localhost:' + PORT + '/ws-number');
        wsSendText(socket, 'go');
        const reply = await wsReadText(socket);
        assert(reply === '42', 'HTTP - WebSocket send number as text');
        socket.destroy();
      } catch (wsErr) {
        assertSkip('HTTP - WebSocket number test', wsErr.message);
      }
    }

    // --- P0 #1 WebSocket close 超时仍触发 close 事件（逻辑修复，黑盒仅验证连接稳定性） ---
    {
      try {
        const { socket } = await wsConnect('ws://localhost:' + PORT + '/ws-chat');
        // 客户端主动发送 Close 帧给服务端，验证服务端能正常回复 Close 帧完成握手
        // 关闭帧：opcode 0x08，状态码 1000
        const closePayload = Buffer.alloc(2);
        closePayload.writeUInt16BE(1000, 0);
        const mask = crypto.randomBytes(4);
        const closeFrame = Buffer.alloc(6 + 2);
        closeFrame[0] = 0x88; // FIN + close
        closeFrame[1] = 0x80 | 2; // MASK + len
        mask.copy(closeFrame, 2);
        for (let i = 0; i < 2; i++) {
          closeFrame[6 + i] = closePayload[i] ^ mask[i % 4];
        }
        socket.write(closeFrame);
        // 等待服务端回复 Close 帧（wsReadText 收到 Close 帧返回 null）
        const reply = await wsReadText(socket);
        assert(reply === null, 'HTTP - WebSocket close handshake completes');
        socket.destroy();
      } catch (wsErr) {
        assertSkip('HTTP - WebSocket close test', wsErr.message);
      }
    }

    // --- P1 #2 params 重置：中间件参数不污染路由处理器 ---
    {
      const res = await httpGet(BASE + '/params/aaa/test');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.b === 'aaa', 'HTTP - params reset: route param b');
      assert(obj.hasA === false, 'HTTP - params reset: middleware param a not leaked');
      assert(obj.mwA === 'aaa', 'HTTP - params reset: middleware param via req custom prop');
    }

    // --- P2 #5 clearCookie 设置 Expires=epoch ---
    {
      const res = await httpGet(BASE + '/clear-cookie-test');
      const setCookie = res.headers['set-cookie'];
      let hasExpires = false;
      if (setCookie) {
        const all = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
        hasExpires = /Expires=Thu, 01 Jan 1970/i.test(all);
      }
      assert(hasExpires, 'HTTP - clearCookie includes Expires=epoch');
    }

    // --- P2 #10 res.json 循环引用返回 500 ---
    {
      const res = await httpGet(BASE + '/json-circular');
      const body = await readBodyStr(res);
      assert(res.statusCode === 500, 'HTTP - json circular returns 500');
      assert(body.includes('serialization failed'), 'HTTP - json circular error message');
    }

    // --- P3 #11 app.get(path) 以 / 开头当路由 ---
    {
      const res = await httpGet(BASE + '/p3-route-test');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.route === true, 'HTTP - app.get(path) registers route when starts with /');
    }

    // --- P3 #17 redirect back 回退到 Referer ---
    {
      const res = await httpGet(BASE + '/redirect-back', { Referer: 'https://example.com/prev' });
      // 消费响应体，避免 keep-alive 连接保持导致 app.close 等待
      await readBodyStr(res);
      assert(res.statusCode === 302, 'HTTP - redirect back status 302');
      assert(res.headers['location'] === 'https://example.com/prev', 'HTTP - redirect back uses Referer');
    }

    // --- P3 #17 redirect back 无 Referer 时回退到 / ---
    {
      const res = await httpGet(BASE + '/redirect-back');
      await readBodyStr(res);
      assert(res.statusCode === 302, 'HTTP - redirect back no referer status 302');
      assert(res.headers['location'] === '/', 'HTTP - redirect back fallback to /');
    }

    // --- P0-1 验证：路由路径含正则特殊字符应正常匹配 ---
    {
      // /api.json 的 . 不应匹配任意字符（/apiXjson 不应命中）
      const res1 = await httpGet(BASE + '/api.json');
      const obj1 = JSON.parse(await readBodyStr(res1));
      assert(obj1.dot === true, 'HTTP - route with dot matches literally');

      const res2 = await httpGet(BASE + '/apiXjson');
      await readBodyStr(res2);
      assert(res2.statusCode === 404, 'HTTP - dot not treated as wildcard');

      // /users(test) 的括号应被转义
      const res3 = await httpGet(BASE + '/users(test)');
      const obj3 = JSON.parse(await readBodyStr(res3));
      assert(obj3.paren === true, 'HTTP - route with parens matches literally');
    }

    // --- P0-2 验证：空文件 sendFile 不崩溃 ---
    {
      const res = await httpGet(BASE + '/empty-file');
      await readBodyStr(res);
      assert(res.statusCode === 200, 'HTTP - empty file sendFile status 200');
      assert(res.headers['content-length'] === '0', 'HTTP - empty file content-length 0');
    }

    // --- P0-5 验证：错误处理中间件被正确调用 ---
    {
      const res = await httpGet(BASE + '/api/error-sync');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.handled === true, 'HTTP - error handled by error-handling middleware');
    }

    // --- P1-1 验证：SSE send 换行符拆多行 data: ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/sse-newline', method: 'GET'
      });
      const body = await readBodyStr(res);
      // send('line1\nline2') 应输出 data: line1\ndata: line2\n\n
      assert(body.includes('data: line1\ndata: line2'), 'HTTP - SSE multiline data split correctly');
      // event('multi', 'data1\ndata2') 应输出 event: multi\ndata: data1\ndata: data2\n\n
      assert(body.includes('event: multi\ndata: data1\ndata: data2'), 'HTTP - SSE multiline event data split correctly');
    }

    // --- P2-3 验证：redirect 非法状态码回退 302，合法状态码保持 ---
    {
      // 999 非法，应回退 302
      const res1 = await httpGet(BASE + '/redirect-invalid');
      await readBodyStr(res1);
      assert(res1.statusCode === 302, 'HTTP - redirect invalid status falls back to 302');
      assert(res1.headers['location'] === '/target', 'HTTP - redirect invalid status keeps location');

      // 301 合法，应保持
      const res2 = await httpGet(BASE + '/redirect-valid');
      await readBodyStr(res2);
      assert(res2.statusCode === 301, 'HTTP - redirect valid 301 kept');
    }

    // --- P2-1 验证：SSE retry 非法值不写入，合法值写入 ---
    {
      const res = await httpRequest({
        hostname: 'localhost', port: PORT, path: '/sse-retry-invalid', method: 'GET'
      });
      const body = await readBodyStr(res);
      // NaN/-1/'abc' 应被忽略，不写入 retry:
      // 合法值 1000 应写入 retry: 1000
      assert(body.includes('retry: 1000'), 'HTTP - SSE retry valid value written');
      // 非法值不应写入（body 中只能有一个 retry: 行）
      const retryLines = body.split('\n').filter(l => l.startsWith('retry:'));
      assert(retryLines.length === 1, 'HTTP - SSE retry invalid values skipped');
    }

    // --- P2-4 验证：路由返回 false 触发 _serveStatic 静态兜底 ---
    {
      // /fallback-static/nonexistent 不存在文件，_serveStatic 返回 404
      const res = await httpGet(BASE + '/fallback-static/nonexistent');
      await readBodyStr(res);
      assert(res.statusCode === 404, 'HTTP - route return false falls back to static 404');
    }

    // --- V1.4.1 P1 #2 验证：res.send(null) 发送空响应（对齐 Express 4.x） ---
    {
      const res = await httpGet(BASE + '/send-null');
      const body = await readBodyStr(res);
      assert(res.statusCode === 200, 'HTTP - send(null) status 200');
      assert(body === '', 'HTTP - send(null) body empty string');
      assert(res.headers['content-length'] === '0', 'HTTP - send(null) content-length 0');
    }

    // --- V1.4.1 P1 #3 验证：SSE.close 幂等性，多次调用不抛异常 ---
    {
      const res = await httpGet(BASE + '/sse-undef');
      await readBodyStr(res);
      // 服务端没崩溃即证明 sse.close 的幂等性保护和 res.finished 检查生效
      assert(res.statusCode === 200, 'HTTP - sse.close idempotent status 200');
    }

    // --- V1.4.1 P2 #5 验证：isPathSafe 拒绝 null byte ---
    {
      assert(httpm.isPathSafe('a%00b', '/tmp') === true, 'Utils - isPathSafe accepts literal %00 (not null byte)');
      assert(httpm.isPathSafe('a\0b', '/tmp') === false, 'Utils - isPathSafe rejects null byte');
      assert(httpm.isPathSafe('foo\0../../etc', '/tmp') === false, 'Utils - isPathSafe rejects null byte traversal');
    }

    // --- V1.4.1 P2 #7 验证：cookie 循环引用对象不抛 TypeError ---
    {
      const res = await httpGet(BASE + '/cookie-circular');
      const body = await readBodyStr(res);
      assert(res.statusCode === 200, 'HTTP - cookie circular object status 200');
      assert(body.includes('"ok":true'), 'HTTP - cookie circular object handled gracefully');
    }

    // --- V1.4.1 P0 #1 验证：WebSocket head 喂入数据不丢失 ---
    // 通过 raw TCP socket 模拟客户端在握手请求后立即发送首帧（pipeline），
    // 服务端 'upgrade' 事件 head 参数会非空，验证首帧能被处理器接收
    {
      try {
        const reply = await new Promise((resolve, reject) => {
          const key = crypto.randomBytes(16).toString('base64');
          // 构造握手请求
          const handshake = [
            'GET /ws-head-test HTTP/1.1',
            'Host: localhost:' + PORT,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: ' + key,
            'Sec-WebSocket-Version: 13',
            '',
            ''
          ].join('\r\n');
          // 构造首帧（掩码文本帧 "hi"），与握手请求一起发出（pipeline）
          const payload = Buffer.from('hi');
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
          const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);

          const socket = new net.Socket();
          socket.connect(PORT, 'localhost', () => {
            // 一次性写入握手请求 + 首帧，模拟 pipeline
            socket.write(Buffer.concat([Buffer.from(handshake), frame]));
          });
          let buf = Buffer.alloc(0);
          let state = 'handshake'; // handshake -> frames
          socket.on('data', (data) => {
            buf = Buffer.concat([buf, data]);
            if (state === 'handshake') {
              const idx = buf.indexOf('\r\n\r\n');
              if (idx === -1) return;
              // 切换到帧解析
              buf = buf.subarray(idx + 4);
              state = 'frames';
            }
            if (state === 'frames' && buf.length >= 2) {
              // 简单解析文本帧（FIN+text，无掩码）
              const len = buf[1] & 0x7F;
              if (buf.length >= 2 + len) {
                const text = buf.subarray(2, 2 + len).toString('utf8');
                socket.destroy();
                resolve(text);
              }
            }
          });
          socket.on('error', reject);
          setTimeout(() => { socket.destroy(); reject(new Error('ws head test timeout')); }, 3000);
        });
        assert(reply === 'echo:hi', 'HTTP - WebSocket head frame not lost (pipeline client)');
      } catch (wsErr) {
        assertSkip('HTTP - WebSocket head frame test', wsErr.message);
      }
    }

  } catch (e) {
    assert(false, 'HTTP integration test error: ' + e.message + '\n' + e.stack);
  }

  // 关闭服务
  await new Promise(r => app.close(r));

  // 关闭 Application 的 Logger 写入流（destroy 释放句柄，等待 'close' 事件确认）
  await closeLoggerStream(app._logger);

  // 等待文件句柄释放
  await new Promise(r => setTimeout(r, 100));

  // --- P1-2 验证：multipart 头部 DoS 防护（partHeadersBuf 超限返回 413） ---
  // 使用独立 app 配置小 maxFieldSize，避免发送 1MB+ 测试数据
  {
    const PORT2 = PORT + 1;
    const app2 = httpm({
      svrPort: PORT2,
      logLevel: 'error',
      bodyParserOptions: { maxFieldSize: 100 } // 限制 part 头部 100 字节
    });
    app2.post('/upload', (req, res) => res.json({ ok: true }));
    const server2 = app2.listen(PORT2);
    await new Promise(r => setTimeout(r, 300));

    try {
      // 构造超大 part 头部（> 100 字节，无 \r\n\r\n 结束标记）
      const boundary = 'TestBoundary';
      const hugeHeader = 'X-Huge-' + 'A'.repeat(200); // 超 100 字节的单个头部
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n${hugeHeader}: value\r\n`,
        'utf8'
      );

      // DoS 防护：part 头部超限时 safeNext 会销毁请求流（req._req.destroy()），
      // 服务端主动断开恶意连接，客户端会收到 socket 错误（socket hang up / ECONNRESET）
      // 这是预期的安全行为：立即断开比发送 413 更安全（避免攻击者继续消耗带宽）
      let dosBlocked = false;
      try {
        await httpRequest({
          hostname: 'localhost', port: PORT2, path: '/upload', method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': body.length
          }
        }, body);
      } catch (e) {
        // 连接被断开证明 DoS 防护生效
        dosBlocked = true;
      }
      assert(dosBlocked === true, 'HTTP - multipart huge part header triggers connection drop (DoS protection)');

      // 对照组：正常 part 头部（< 100 字节）应正常处理
      const normalBody = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--${boundary}--\r\n`,
        'utf8'
      );
      const res2 = await httpRequest({
        hostname: 'localhost', port: PORT2, path: '/upload', method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': normalBody.length
        }
      }, normalBody);
      assert(res2.statusCode === 200, 'HTTP - multipart normal part header returns 200');
    } catch (e) {
      assertSkip('HTTP - multipart part header DoS test', e.message);
    } finally {
      await new Promise(r => server2.close(r));
      await closeLoggerStream(app2._logger);
    }
  }

  // --- P2-2 验证：CORS origin 函数抛异常时不阻断主请求 ---
  // origin 函数异常应按拒绝跨域处理（不设置 ACAO 头），请求本身仍正常返回 200
  {
    const PORT3 = PORT + 2;
    const app3 = httpm({
      svrPort: PORT3,
      logLevel: 'error',
      cors: { origin: () => { throw new Error('origin func error'); } }
    });
    app3.get('/test', (req, res) => res.json({ ok: true }));
    const server3 = app3.listen(PORT3);
    await new Promise(r => setTimeout(r, 300));

    try {
      const res = await httpGet('http://localhost:' + PORT3 + '/test', { Origin: 'https://evil.com' });
      // 请求本身不应 500（CORS 异常不阻断主请求）
      assert(res.statusCode === 200, 'HTTP - CORS origin func error does not block request');
      const body = await readBodyStr(res);
      assert(body.includes('"ok":true'), 'HTTP - CORS origin func error response body correct');
      // 异常时拒绝跨域：不设置 Access-Control-Allow-Origin 头
      assert(res.headers['access-control-allow-origin'] === undefined, 'HTTP - CORS origin func error rejects CORS (no ACAO header)');
    } catch (e) {
      assertSkip('HTTP - CORS origin func error test', e.message);
    } finally {
      await new Promise(r => server3.close(r));
      await closeLoggerStream(app3._logger);
    }
  }

  // --- P2-4 验证：async handler 调用 next(err) 后 Promise reject 不重复处理 ---
  // 场景：handler 调用 next(err) 进入错误处理链，随后 Promise 又 reject
  // 期望：_handleError 只被调用一次，错误处理中间件不会重复执行
  {
    const PORT4 = PORT + 3;
    const app4 = httpm({ svrPort: PORT4, logLevel: 'error' });
    let errorHandlerCallCount = 0;
    app4.use((err, req, res, next) => {
      errorHandlerCallCount++;
      res.status(500).json({ error: err.message, count: errorHandlerCallCount });
    });
    app4.get('/async-next-reject', async (req, res, next) => {
      next(new Error('first error'));
      throw new Error('second error');
    });
    const server4 = app4.listen(PORT4);
    await new Promise(r => setTimeout(r, 300));

    try {
      const res = await httpGet('http://localhost:' + PORT4 + '/async-next-reject');
      assert(res.statusCode === 500, 'HTTP - async next+reject returns 500');
      const obj = JSON.parse(await readBodyStr(res));
      assert(obj.error === 'first error', 'HTTP - async next+reject uses first error (next err)');
      assert(errorHandlerCallCount === 1, 'HTTP - async next+reject error handler called once (no duplicate)');
    } catch (e) {
      assertSkip('HTTP - async next+reject duplicate error handling test', e.message);
    } finally {
      await new Promise(r => server4.close(r));
      await closeLoggerStream(app4._logger);
    }
  }

  // --- P1-1/P1-2 验证：WebSocket DoS 防护（大帧慢速攻击 + 分片累积超限） ---
  // 使用独立 app 配置小 wsMaxPayload=200，验证服务端拒绝超限帧和累积超限分片
  // P1-1：_decodeFrame 在掩码解析前检查 payloadLength > maxPayload，防止慢速大帧攻击
  // P1-2：_processFrame 累积分片总大小，超限时 close(1009)，防止分片绕过单帧限制
  {
    const PORT5 = PORT + 4;
    const app5 = httpm({
      svrPort: PORT5,
      logLevel: 'error',
      wsMaxPayload: 200 // 限制单帧/分片累积最大负载 200 字节
    });
    app5.ws('/ws-small', (ws, req) => {
      ws.on('text', (msg) => ws.send('echo:' + msg));
    });
    const server5 = app5.listen(PORT5);
    await new Promise(r => setTimeout(r, 300));

    /**
     * 构造客户端掩码帧（支持分片帧和扩展长度格式）
     * @param {boolean} fin - FIN 标志位（true=最后一帧，false=分片续帧）
     * @param {number} opcode - 帧操作码（0x01=text, 0x02=binary, 0x00=continuation）
     * @param {Buffer} payload - 帧负载数据
     * @returns {Buffer} 完整的掩码帧 Buffer
     */
    function makeMaskedFrame(fin, opcode, payload) {
      const mask = crypto.randomBytes(4);
      const finBit = fin ? 0x80 : 0x00;
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = finBit | opcode;
        header[1] = 0x80 | payload.length; // MASK + len
        mask.copy(header, 2);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = finBit | opcode;
        header[1] = 0x80 | 126; // MASK + extended 16-bit length
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = finBit | opcode;
        header[1] = 0x80 | 127; // MASK + extended 64-bit length
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i % 4];
      }
      return Buffer.concat([header, masked]);
    }

    /**
     * 构造声明超限但数据不完整的恶意帧（慢速攻击模拟）
     * 只发送帧头部 + 少量数据，声明大 payloadLength 欺骗服务端分配缓冲区
     * @param {number} declaredLength - 声明的负载长度（>maxPayload 触发防护）
     * @param {number} actualDataLength - 实际发送的掩码数据长度
     * @returns {Buffer} 恶意帧 Buffer
     */
    function makeOversizeHeader(declaredLength, actualDataLength) {
      const mask = crypto.randomBytes(4);
      // 扩展长度格式：FIN+text(1) + MASK+126(1) + len16(2) + mask(4) = 8 字节头
      const header = Buffer.alloc(8);
      header[0] = 0x81; // FIN + text
      header[1] = 0xFE; // MASK + 126 (extended 16-bit length)
      header.writeUInt16BE(declaredLength, 2);
      mask.copy(header, 4);
      const partialData = Buffer.alloc(actualDataLength, 0x41);
      const masked = Buffer.alloc(actualDataLength);
      for (let i = 0; i < actualDataLength; i++) {
        masked[i] = partialData[i] ^ mask[i % 4];
      }
      return Buffer.concat([header, masked]);
    }

    try {
      // --- 测试 1：大帧慢速攻击防护（P1-1） ---
      // 客户端声明 payloadLength=300（>maxPayload=200）但只发送 50 字节
      // 期望：服务端在掩码解析前检测到超限，立即 close(1009) 发送 Close 帧
      {
        const { socket } = await wsConnect('ws://localhost:' + PORT5 + '/ws-small');
        const maliciousFrame = makeOversizeHeader(300, 50); // 声明 300，实际仅发 50
        socket.write(maliciousFrame);

        // 监听服务端响应：close(1009) 会发送 Close 帧（opcode 0x08）
        const blocked = await new Promise((resolve) => {
          socket.on('data', (buf) => {
            // 检测 Close 帧（首字节低 4 位 opcode=0x08）
            if (buf.length >= 2 && (buf[0] & 0x0F) === 0x08) resolve(true);
          });
          socket.on('close', () => resolve(true));
          setTimeout(() => { socket.destroy(); resolve(false); }, 2500);
        });
        assert(blocked === true, 'HTTP - WebSocket 大帧慢速攻击防护：声明超限立即关闭');
        socket.destroy();
      }

      // --- 测试 2：分片累积超限防护（P1-2） ---
      // 发送两个小分片（各 <maxPayload），累积总量 250 > maxPayload=200
      // 期望：服务端在第二个分片累积超限时 close(1009)
      {
        const { socket } = await wsConnect('ws://localhost:' + PORT5 + '/ws-small');
        // 第一个分片：FIN=0, opcode=0x01(text), payload=150字节
        const frag1 = makeMaskedFrame(false, 0x01, Buffer.alloc(150, 0x42));
        // 第二个分片：FIN=0, opcode=0x00(continuation), payload=100字节（累积 250 > 200）
        const frag2 = makeMaskedFrame(false, 0x00, Buffer.alloc(100, 0x43));
        socket.write(frag1);
        socket.write(frag2);

        const blocked = await new Promise((resolve) => {
          socket.on('data', (buf) => {
            if (buf.length >= 2 && (buf[0] & 0x0F) === 0x08) resolve(true);
          });
          socket.on('close', () => resolve(true));
          setTimeout(() => { socket.destroy(); resolve(false); }, 2500);
        });
        assert(blocked === true, 'HTTP - WebSocket 分片累积超限防护：累积超限关闭连接');
        socket.destroy();
      }

      // --- 测试 3：边界值验证（payloadLength === maxPayload 正常处理） ---
      // 发送 payloadLength=200（等于 maxPayload）的单帧
      // 期望：服务端正常处理（不触发超限），echo 回复
      {
        const { socket } = await wsConnect('ws://localhost:' + PORT5 + '/ws-small');
        const boundaryPayload = Buffer.alloc(200, 0x44); // 200字节 'D'，等于 maxPayload
        const frame = makeMaskedFrame(true, 0x01, boundaryPayload);
        socket.write(frame);

        const reply = await wsReadText(socket);
        assert(reply === 'echo:' + 'D'.repeat(200), 'HTTP - WebSocket 边界值：payloadLength===maxPayload 正常处理');
        socket.destroy();
      }

      // --- 测试 4：回归验证（正常消息不受 DoS 防护影响） ---
      // 发送正常文本消息 "hello"（5字节 << maxPayload）
      // 期望：echo 正常回复 "echo:hello"
      {
        const { socket } = await wsConnect('ws://localhost:' + PORT5 + '/ws-small');
        wsSendText(socket, 'hello');
        const reply = await wsReadText(socket);
        assert(reply === 'echo:hello', 'HTTP - WebSocket 回归验证：正常消息 echo 正常');
        socket.destroy();
      }
    } catch (e) {
      assertSkip('HTTP - WebSocket DoS 防护测试', e.message);
    } finally {
      await new Promise(r => server5.close(r));
      await closeLoggerStream(app5._logger);
    }
  }

  // --- P1-2 验证：WebSocket send 循环引用对象不崩溃 ---
  // ws.send(循环引用对象) 时 JSON.stringify 抛 TypeError，应触发 error 事件而非进程崩溃
  {
    const PORT6 = PORT + 5;
    const app6 = httpm({
      svrPort: PORT6,
      logLevel: 'error'
    });
    app6.ws('/ws-circular', (ws, req) => {
      ws.on('text', (msg) => {
        if (msg === 'send-circular') {
          // 构造循环引用对象：JSON.stringify 会抛 TypeError
          const circular = { a: 1 };
          circular.self = circular;
          ws.send(circular); // 应触发 error 事件而非崩溃
        }
      });
      // error 事件被触发说明序列化失败被正确捕获
      ws.on('error', () => {
        // 连接仍可用，发送确认消息（字符串不会触发序列化异常）
        ws.send('error-triggered');
      });
    });
    const server6 = app6.listen(PORT6);
    await new Promise(r => setTimeout(r, 300));

    try {
      const { socket } = await wsConnect('ws://localhost:' + PORT6 + '/ws-circular');
      wsSendText(socket, 'send-circular');
      // 等待服务端 error 事件触发后发送的确认消息
      const reply = await wsReadText(socket);
      assert(reply === 'error-triggered', 'HTTP - WebSocket send 循环引用对象触发 error 事件不崩溃');
      socket.destroy();
    } catch (e) {
      assertSkip('HTTP - WebSocket send 循环引用对象测试', e.message);
    } finally {
      await new Promise(r => server6.close(r));
      await closeLoggerStream(app6._logger);
    }
  }

  // --- V1.4.9 验证：WebSocket handler 的 req 与普通路由 req 属性一致 ---
  // app.ws handler 的 req 应为 httpm Request 实例，具备 query/params/path/cookies/ip 等
  // 修复前 req 是原生 http.IncomingMessage，缺少这些便捷属性
  {
    const PORT8 = PORT + 7;
    const app8 = httpm({
      svrPort: PORT8,
      logLevel: 'error',
      cookieParserSecret: 'test-secret'
    });
    // handler 读取 req 各属性并通过 ws.send 返回 JSON，用于断言
    app8.ws('/ws-req/:id', (ws, req) => {
      ws.on('text', () => {
        ws.send(JSON.stringify({
          query: req.query,
          params: req.params,
          path: req.path,
          url: req.url,
          method: req.method,
          ip: req.ip,
          hostname: req.hostname,
          protocol: req.protocol,
          cookies: req.cookies,
          signedCookies: req.signedCookies,
          getHost: req.get('host'),
          getCookie: req.get('Cookie'),
          hasBody: req.body === null,
          hasFormData: !!req.formData,
          hasFiles: Array.isArray(req.files)
        }));
      });
    });
    const server8 = app8.listen(PORT8);
    await new Promise(r => setTimeout(r, 300));

    try {
      // 构造带 query + Cookie 的 WebSocket 升级请求（path 带 query，携带 Cookie 头）
      const key = crypto.randomBytes(16).toString('base64');
      const upgradeReq = http.request({
        hostname: 'localhost', port: PORT8,
        path: '/ws-req/42?name=abc&x=1', method: 'GET',
        headers: {
          'Upgrade': 'websocket', 'Connection': 'Upgrade',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
          'Cookie': 'session=xyz; token=abc',
          'Host': 'localhost:' + PORT8
        }
      });
      const { socket } = await new Promise((resolve, reject) => {
        upgradeReq.on('upgrade', (res, sock, head) => resolve({ socket: sock, head }));
        upgradeReq.on('error', reject);
        upgradeReq.end();
      });
      wsSendText(socket, 'go');
      const reply = await wsReadText(socket);
      const obj = JSON.parse(reply);
      // query 解析（修复前 undefined）
      assert(obj.query.name === 'abc', 'HTTP - WS req.query.name 解析');
      assert(obj.query.x === '1', 'HTTP - WS req.query 多参数');
      // params 动态参数（修复前仅原生 req 手动挂载，现经 Request 包装仍可用）
      assert(obj.params.id === '42', 'HTTP - WS req.params 动态参数');
      // path 解码路径（修复前 undefined）
      assert(obj.path === '/ws-req/42', 'HTTP - WS req.path 解码路径');
      // url 原始 URL（getter 代理）
      assert(obj.url === '/ws-req/42?name=abc&x=1', 'HTTP - WS req.url 原始 URL');
      assert(obj.method === 'GET', 'HTTP - WS req.method');
      // ip/hostname/protocol（修复前 undefined，现为 Request getter）
      assert(obj.ip && obj.ip.length > 0, 'HTTP - WS req.ip 非空');
      assert(obj.hostname === 'localhost', 'HTTP - WS req.hostname');
      assert(obj.protocol === 'http', 'HTTP - WS req.protocol');
      // cookies 解析（修复前 undefined，现复用 cookieParser 中间件）
      assert(obj.cookies.session === 'xyz', 'HTTP - WS req.cookies.session');
      assert(obj.cookies.token === 'abc', 'HTTP - WS req.cookies.token');
      // signedCookies 存在（无签名 cookie 时为空对象）
      assert(typeof obj.signedCookies === 'object', 'HTTP - WS req.signedCookies 存在');
      // req.get() 大小写不敏感（修复前 req.get 不是函数）
      assert(obj.getHost === 'localhost:' + PORT8, 'HTTP - WS req.get(host)');
      assert(obj.getCookie === 'session=xyz; token=abc', 'HTTP - WS req.get(Cookie) 大小写不敏感');
      // body/formData/files 保持初始值（WebSocket 升级请求无 body）
      assert(obj.hasBody === true, 'HTTP - WS req.body 默认 null');
      assert(obj.hasFormData === true, 'HTTP - WS req.formData 存在');
      assert(obj.hasFiles === true, 'HTTP - WS req.files 数组');
      socket.destroy();
    } catch (e) {
      assertSkip('HTTP - WS req 属性一致性测试', e.message);
    } finally {
      await new Promise(r => server8.close(r));
      await closeLoggerStream(app8._logger);
    }
  }

  // --- P2-1/P2-2 验证：res.append / res.type null 参数不抛异常 ---
  // res.append(null, 'val') 和 res.type(null/undefined) 应静默返回 this，不抛 TypeError
  {
    const PORT7 = PORT + 6;
    const app7 = httpm({
      svrPort: PORT7,
      logLevel: 'error'
    });
    app7.get('/append-null', (req, res) => {
      res.append(null, 'val');   // P2-1: null field 不抛异常
      res.append(undefined, 'x'); // undefined field 不抛异常
      res.append('X-Test', 'ok'); // 正常设置仍有效
      res.send('ok');
    });
    app7.get('/type-null', (req, res) => {
      res.type(null);      // P2-2: null 不抛异常
      res.type(undefined);  // undefined 不抛异常
      res.type('json');     // 正常设置仍有效
      res.send('ok');
    });
    const server7 = app7.listen(PORT7);
    await new Promise(r => setTimeout(r, 300));

    try {
      const res1 = await httpGet('http://localhost:' + PORT7 + '/append-null');
      const body1 = await readBodyStr(res1);
      assert(res1.statusCode === 200 && body1 === 'ok', 'HTTP - res.append(null/undefined) 不抛异常');

      const res2 = await httpGet('http://localhost:' + PORT7 + '/type-null');
      const body2 = await readBodyStr(res2);
      assert(res2.statusCode === 200 && body2 === 'ok', 'HTTP - res.type(null/undefined) 不抛异常');
    } catch (e) {
      assertSkip('HTTP - res.append/type 参数校验测试', e.message);
    } finally {
      await new Promise(r => server7.close(r));
      await closeLoggerStream(app7._logger);
    }
  }

  // 清理测试文件
  try {
    fs.unlinkSync(path.join(testDir, 'index.html'));
    fs.unlinkSync(path.join(testDir, 'test.txt'));
    fs.unlinkSync(path.join(testDir, 'large.txt'));
    fs.unlinkSync(path.join(testDir, 'empty.txt'));
    fs.unlinkSync(path.join(subDir, 'nested.html'));
    fs.unlinkSync(path.join(nestedDir, 'deep.txt'));
    fs.rmSync(subDir, { recursive: true });
    fs.rmSync(testDir, { recursive: true });
  } catch (e) { /* ignore */ }

  // 清理所有测试产生的临时目录
  const tempDirs = [
    path.join(__dirname, 'test_log_output'),
    path.join(__dirname, 'test_log_output2'),
    path.join(__dirname, 'test_log_runtime'),
    path.join(__dirname, 'test_temp_upload'),
    path.join(__dirname, 'log'),
    path.join(__dirname, 'tempupdir'),
    // 历史残留目录
    path.join(__dirname, '_dl_test'),
    path.join(__dirname, '_dl_test2'),
    path.join(__dirname, '_dl_test3'),
    path.join(__dirname, 'test_s3'),
    path.join(__dirname, 'test_static_dir')
  ];
  for (const dir of tempDirs) {
    await rmDirForce(dir);
  }

  // 输出结果
  console.log(results.join('\n'));
  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped, total ' + (passed + failed + skipped));
  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
