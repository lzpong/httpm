/**
 * httpm - 基于 Node.js 原生模块的单文件、零依赖 HTTP 服务库
 *
 * @name        httpm
 * @version     1.0.0
 * @description 兼容 Express API，内置路由、中间件、静态文件服务、
 *              WebSocket、SSE、流式上传、日志系统等功能
 * @license     MIT
 * @requires    node >= 14.0.0
 * @module      httpm
 * @author      lzpong
 * @link        https://gitee.com/lzpong/httpm
 *
 * 核心特性：
 *   - 单文件架构，零第三方依赖
 *   - Express 兼容：路由、中间件、请求/响应 API
 *   - 静态文件服务：Range 断点续传、ETag/Last-Modified 缓存、Gzip 压缩
 *   - WebSocket：路径分组、心跳保活、广播、文本/二进制子事件
 *   - SSE：服务端推送事件，支持 event/data/retry/comment
 *   - 流式文件上传：multipart/form-data 解析，内存零占用
 *   - 日志系统：彩色控制台输出 + 文件持久化，按级别过滤
 *   - Cookie 签名：HMAC-SHA256 签名与验证
 *   - 配置管理：默认配置 → app.json → 代码参数 → 运行时 app.set()
 */

'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ============================================================
// 工具函数层
// ============================================================

/**
 * 解析 URL，拆分路径与 Query 参数
 */
function parseUrl(urlStr) {
  const qIdx = urlStr.indexOf('?');
  if (qIdx === -1) {
    return { pathname: urlStr, query: {} };
  }
  const pathname = urlStr.substring(0, qIdx);
  const qs = urlStr.substring(qIdx + 1);
  const query = {};
  if (qs) {
    qs.split('&').forEach(pair => {
      const eIdx = pair.indexOf('=');
      if (eIdx === -1) {
        query[decodeURIComponent(pair)] = '';
      } else {
        query[decodeURIComponent(pair.substring(0, eIdx))] = decodeURIComponent(pair.substring(eIdx + 1));
      }
    });
  }
  return { pathname, query };
}

/**
 * 解析 Cookie 字符串为键值对象
 */
function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  cookieStr.split(';').forEach(pair => {
    const eIdx = pair.indexOf('=');
    if (eIdx === -1) return;
    const key = pair.substring(0, eIdx).trim();
    const val = pair.substring(eIdx + 1).trim();
    cookies[key] = val;
  });
  return cookies;
}

/**
 * MIME 类型映射表
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
};

/**
 * 根据文件后缀匹配标准 MIME 类型
 */
function getMimeType(ext) {
  if (!ext) return 'application/octet-stream';
  const lower = ext.toLowerCase();
  return MIME_TYPES[lower] || 'application/octet-stream';
}

/**
 * 字节单位格式化（B/KB/MB/GB）
 */
function fmtSize(bytes) {
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + units[i];
}

/**
 * 毫秒时间格式化（ms/s/m）
 */
function fmtTime(ms) {
  if (ms < 1000) return ms.toFixed(0) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(2) + 's';
  return (ms / 60000).toFixed(2) + 'm';
}

/**
 * 路径安全校验，防遍历攻击
 */
function isPathSafe(requestPath, rootDir) {
  // 去掉前导斜杠，防止 path.resolve 将其视为绝对路径
  const normalized = requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, normalized);
  const root = path.resolve(rootDir);
  // 确保解析后的路径在根目录内
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return false;
  }
  // 禁止访问隐藏文件/目录（以 . 开头）
  const parts = normalized.split(/[/\\]/);
  for (const part of parts) {
    if (part.startsWith('.')) return false;
  }
  return true;
}

/**
 * 根据文件信息生成 ETag 缓存标识
 */
function generateETag(stat) {
  const hash = crypto.createHash('md5');
  hash.update(stat.size.toString(36));
  hash.update(stat.mtimeMs.toString(36));
  return '"' + hash.digest('hex') + '"';
}

/**
 * 解析 Range 请求头，提取字节分段范围
 * 返回 { start, end, total } 或 null
 */
function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  // 格式: bytes=start-end 或 bytes=start- 或 bytes=-suffix
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? parseInt(match[1], 10) : null;
  let end = match[2] ? parseInt(match[2], 10) : null;
  if (start === null && end === null) return null;
  if (start === null) {
    // bytes=-suffix: 请求最后 suffix 字节
    start = Math.max(0, fileSize - end);
    end = fileSize - 1;
  } else if (end === null) {
    // bytes=start-: 从 start 到文件末尾
    end = fileSize - 1;
  }
  if (start > end || start >= fileSize) return null;
  // end 超出文件大小时修正为文件末尾
  if (end >= fileSize) end = fileSize - 1;
  return { start, end, total: fileSize };
}

/**
 * 判断 MIME 类型是否为文本类（可压缩）
 */
function isTextMime(mime) {
  return /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/.test(mime);
}

/**
 * 生成唯一 ID
 */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// ============================================================
// Logger 日志类
// ============================================================

class Logger {
  constructor(options = {}) {
    this.name = options.name || '';
    this.level = options.level || 'info';
    this.logDir = options.logDir || './log';
    this._levels = { debug: 0, info: 1, notice: 2, warn: 3, error: 4 };
    this._colors = {
      debug: '\x1b[1;30m',   // 灰色
      info: '\x1b[1;37m',    // 白色
      notice: '\x1b[1;35m',  // 品红
      warn: '\x1b[1;33m',    // 黄色
      error: '\x1b[1;31m'    // 红色
    };
    this._reset = '\x1b[0m';
    this._stream = null;
    this._streamDate = null;
  }

  _shouldLog(level) {
    const current = this._levels[this.level] || 1;
    const target = this._levels[level] || 1;
    return target >= current;
  }

  _formatTime(date) {
    const pad = n => n.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  _getLogStream() {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const dateStr = `${day}`;

    // 同一天复用同一个流
    const streamKey = `${year}-${month}-${day}`;
    if (this._stream && this._streamDate === streamKey) {
      return this._stream;
    }
    // 关闭旧流
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
    // 创建日志目录: ./log/YYYY/MM/
    const dir = path.join(this.logDir, year, month);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 文件名: name_DD.log 或 DD.log
    const prefix = this.name ? this.name + '_' : '';
    const filePath = path.join(dir, `${prefix}${day}.log`);
    this._stream = fs.createWriteStream(filePath, { flags: 'a' });
    this._streamDate = streamKey;
    return this._stream;
  }

  _writeFile(level, msg) {
    try {
      const stream = this._getLogStream();
      stream.write(msg + '\n');
    } catch (e) {
      // 文件写入失败静默处理
    }
  }

  log(level, ...args) {
    if (!this._shouldLog(level)) return;
    const timestamp = this._formatTime(new Date());
    const color = this._colors[level] || '';
    const levelTag = level.toUpperCase().padEnd(6);
    const msg = `[${timestamp}] [${levelTag}] ${args.join(' ')}`;

    // 控制台彩色输出
    console.log(`${color}${msg}${this._reset}`);
    // 文件持久化（无颜色码）
    this._writeFile(level, msg);
  }

  debug(...args) { this.log('debug', ...args); }
  info(...args) { this.log('info', ...args); }
  notice(...args) { this.log('notice', ...args); }
  warn(...args) { this.log('warn', ...args); }
  error(...args) { this.log('error', ...args); }
}

// ============================================================
// Router 类
// ============================================================

class Router {
  constructor() {
    this.routes = { GET: [], POST: [], PUT: [], DELETE: [], PATCH: [], HEAD: [], OPTIONS: [], ALL: [] };
    this.middlewareStack = [];
  }

  /**
   * 编译动态路由路径为正则表达式
   */
  _compilePath(pathStr) {
    const params = [];
    // 将 :param 替换为正则捕获组
    const patternStr = pathStr.replace(/:([^/]+)/g, (_, name) => {
      params.push(name);
      return '([^/]+)';
    });
    const pattern = new RegExp('^' + patternStr + '$');
    return { pattern, params };
  }

  /**
   * 注册路由
   */
  _addRoute(method, pathStr, ...handlers) {
    const { pattern, params } = this._compilePath(pathStr);
    const route = {
      method: method.toUpperCase(),
      path: pathStr,
      pattern,
      params,
      handlers
    };
    const key = method.toUpperCase();
    if (this.routes[key]) {
      this.routes[key].push(route);
    }
    // 同时注册到 ALL
    if (key !== 'ALL') {
      // ALL 路由单独处理，不在此处添加
    }
    return this;
  }

  /**
   * 注册路径级/应用级中间件
   */
  use(...args) {
    if (typeof args[0] === 'string') {
      // 路径级中间件
      const pathStr = args[0];
      const handlers = args.slice(1);
      const { pattern, params } = this._compilePath(pathStr);
      this.middlewareStack.push({ path: pathStr, pattern, params, handlers });
    } else {
      // 应用级中间件
      const handlers = args;
      this.middlewareStack.push({ path: '/', pattern: null, params: [], handlers });
    }
    return this;
  }

  /**
   * 路由匹配：查找匹配的路由并提取参数
   */
  match(method, pathname) {
    const results = [];
    const m = method.toUpperCase();

    // 检查 ALL 路由
    const allRoutes = this.routes['ALL'] || [];
    // 检查对应方法路由
    const methodRoutes = this.routes[m] || [];
    const candidates = [...allRoutes, ...methodRoutes];

    for (const route of candidates) {
      const match = route.pattern.exec(pathname);
      if (match) {
        const params = {};
        route.params.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        results.push({ route, params, handlers: route.handlers });
      }
    }
    return results;
  }

  /**
   * 匹配路径级中间件（前缀匹配）
   */
  matchMiddleware(pathname) {
    const results = [];
    for (const mw of this.middlewareStack) {
      if (!mw.pattern) {
        // 应用级中间件，匹配所有路径
        results.push({ middleware: mw, params: {} });
      } else {
        // 路径级中间件：前缀匹配
        // 中间件路径 /api 应匹配 /api、/api/users、/api/users/123 等
        const mwPath = mw.path;
        if (pathname === mwPath || pathname.startsWith(mwPath + '/')) {
          const params = {};
          // 如果有动态参数，也需要提取
          if (mw.params.length > 0) {
            const match = mw.pattern.exec(pathname);
            if (match) {
              mw.params.forEach((name, i) => {
                params[name] = decodeURIComponent(match[i + 1]);
              });
            }
          }
          results.push({ middleware: mw, params });
        }
      }
    }
    return results;
  }

  // HTTP 方法快捷注册
  get(pathStr, ...handlers) { return this._addRoute('GET', pathStr, ...handlers); }
  post(pathStr, ...handlers) { return this._addRoute('POST', pathStr, ...handlers); }
  put(pathStr, ...handlers) { return this._addRoute('PUT', pathStr, ...handlers); }
  delete(pathStr, ...handlers) { return this._addRoute('DELETE', pathStr, ...handlers); }
  patch(pathStr, ...handlers) { return this._addRoute('PATCH', pathStr, ...handlers); }
  head(pathStr, ...handlers) { return this._addRoute('HEAD', pathStr, ...handlers); }
  options(pathStr, ...handlers) { return this._addRoute('OPTIONS', pathStr, ...handlers); }
  all(pathStr, ...handlers) { return this._addRoute('ALL', pathStr, ...handlers); }
}

// ============================================================
// Request 类
// ============================================================

class Request {
  constructor(incomingMessage) {
    this._req = incomingMessage;
    this.query = {};
    this.params = {};
    this.body = null;
    this.cookies = {};
    this.files = [];
    this.path = '';
    this.formData = {
      fields: {},
      files: []
    };
    this._tempFiles = [];
    this._bodyParsed = false;
    this._rawBody = null;
  }

  // 通用快捷属性代理
  get method() { return this._req.method; }
  get url() { return this._req.url; }
  get headers() { return this._req.headers; }
  get ip() {
    // 优先取代理头
    const fwd = this._req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return this._req.socket?.remoteAddress || '';
  }
  get hostname() { return this._req.headers['host']?.split(':')[0] || ''; }
  get protocol() {
    return (this._req.socket?.encrypted || this._req.connection?.encrypted) ? 'https' : 'http';
  }

  /**
   * 读取请求体原始数据
   */
  _readBody() {
    return new Promise((resolve, reject) => {
      if (this._bodyParsed) {
        resolve(this._rawBody);
        return;
      }
      const chunks = [];
      this._req.on('data', chunk => chunks.push(chunk));
      this._req.on('end', () => {
        this._rawBody = Buffer.concat(chunks);
        this._bodyParsed = true;
        resolve(this._rawBody);
      });
      this._req.on('error', reject);
    });
  }
}

// ============================================================
// Response 类
// ============================================================

class Response {
  constructor(serverResponse, app) {
    this._res = serverResponse;
    this._app = app;
    this.statusCode = 200;
    this._headersSent = false;
    this._sse = null;
  }

  // 代理原生响应方法
  get finished() { return this._res.finished; }
  get headersSent() { return this._res.headersSent || this._headersSent; }

  setHeader(name, value) {
    this._res.setHeader(name, value);
    return this;
  }

  getHeader(name) {
    return this._res.getHeader(name);
  }

  removeHeader(name) {
    this._res.removeHeader(name);
    return this;
  }

  /**
   * 设置 HTTP 状态码，支持链式调用
   */
  status(code) {
    this.statusCode = code;
    return this;
  }

  /**
   * 输出 JSON 格式响应
   */
  json(data) {
    const body = JSON.stringify(data);
    this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.setHeader('Content-Length', Buffer.byteLength(body));
    this._send(body);
  }

  /**
   * 通用输出，支持字符串、HTML、Buffer、对象
   */
  send(data) {
    if (data === undefined || data === null) {
      this.setHeader('Content-Length', 0);
      this._send('');
      return;
    }
    if (Buffer.isBuffer(data)) {
      this.setHeader('Content-Type', 'application/octet-stream');
      this.setHeader('Content-Length', data.length);
      this._send(data);
      return;
    }
    if (typeof data === 'object') {
      this.json(data);
      return;
    }
    const str = String(data);
    // 自动判断内容类型
    if (!this.getHeader('Content-Type')) {
      if (str.startsWith('<!DOCTYPE') || str.startsWith('<html') || str.startsWith('<HTML')) {
        this.setHeader('Content-Type', 'text/html; charset=utf-8');
      } else {
        this.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
    }
    this.setHeader('Content-Length', Buffer.byteLength(str));
    this._send(str);
  }

  /**
   * 内部发送方法
   */
  _send(data) {
    if (this._res.finished) return;
    this._res.statusCode = this.statusCode;
    this._headersSent = true;
    this._res.end(data);
  }

  /**
   * 发送本地文件，内置断点续传、缓存、Gzip 能力
   */
  sendFile(filePath, options = {}) {
    const root = options.root || this._app.settings.rootPath || process.cwd();
    const fullPath = path.resolve(root, filePath);

    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        this.status(404).send('Not Found');
        return;
      }

      const mime = getMimeType(path.extname(fullPath));
      this.setHeader('Content-Type', mime);
      this.setHeader('Accept-Ranges', 'bytes');

      // ETag 缓存校验
      if (this._app.settings.enableCache !== false) {
        const etag = generateETag(stat);
        this.setHeader('ETag', etag);
        this.setHeader('Last-Modified', stat.mtime.toUTCString());
        // 设置 Cache-Control 头
        if (this._app.settings.cacheControl) {
          this.setHeader('Cache-Control', this._app.settings.cacheControl);
        }

        const ifNoneMatch = this._req?.headers?.['if-none-match'];
        const ifModifiedSince = this._req?.headers?.['if-modified-since'];
        if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime)) {
          this.status(304)._send('');
          return;
        }
      }

      // Range 断点续传
      const rangeHeader = this._req?.headers?.['range'];
      if (this._app.settings.enableRange !== false && rangeHeader) {
        const range = parseRange(rangeHeader, stat.size);
        if (range) {
          this.status(206);
          this.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${range.total}`);
          this.setHeader('Content-Length', range.end - range.start + 1);
          this._streamFile(fullPath, range.start, range.end, stat.size);
          return;
        }
      }

      this.setHeader('Content-Length', stat.size);

      // Gzip 压缩（仅文本类文件）
      const acceptEncoding = this._req?.headers?.['accept-encoding'] || '';
      if (this._app.settings.enableGzip && isTextMime(mime) && acceptEncoding.includes('gzip')) {
        this.removeHeader('Content-Length');
        this.setHeader('Content-Encoding', 'gzip');
        this._res.statusCode = this.statusCode;
        this._headersSent = true;
        const raw = fs.createReadStream(fullPath);
        const gzip = zlib.createGzip();
        raw.pipe(gzip).pipe(this._res);
        return;
      }

      this._streamFile(fullPath, 0, stat.size - 1, stat.size);
    });
  }

  /**
   * 流式发送文件
   */
  _streamFile(fullPath, start, end, total) {
    if (this._res.finished) return;
    this._res.statusCode = this.statusCode;
    this._headersSent = true;
    const stream = fs.createReadStream(fullPath, { start, end });
    // 大文件进度展示（>1MB）
    if (total > 1024 * 1024) {
      const name = path.basename(fullPath);
      const totalSize = end - start + 1;
      let sent = 0;
      const startTime = Date.now();
      let lastLine = '';
      stream.on('data', (chunk) => {
        sent += chunk.length;
        const pct = ((sent / totalSize) * 100).toFixed(1);
        const elapsed = Date.now() - startTime;
        const speed = elapsed > 0 ? sent / (elapsed / 1000) : 0;
        const line = `\r[${name}] ${fmtSize(sent)}/${fmtSize(totalSize)} ${pct}% ${fmtSize(speed)}/s ${fmtTime(elapsed)}`;
        if (line !== lastLine) {
          process.stdout.write(line);
          lastLine = line;
        }
      });
      stream.on('end', () => {
        if (sent > 0) process.stdout.write('\n');
      });
    }
    stream.pipe(this._res);
  }

  /**
   * 触发浏览器文件下载，支持大文件进度展示
   */
  download(filePath, filename) {
    const name = filename || path.basename(filePath);
    this.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    this.sendFile(filePath);
  }

  /**
   * 重定向响应
   */
  redirect(url, code = 302) {
    this.status(code);
    this.setHeader('Location', url);
    this.setHeader('Content-Length', 0);
    this._send('');
  }

  /**
   * 创建 SSE 推送实例
   */
  sse() {
    if (this._sse) return this._sse;
    this._sse = new SSE(this._res);
    return this._sse;
  }

  /**
   * 设置响应 Cookie
   */
  cookie(name, value, opts = {}) {
    let cookieValue = value;
    // 签名 Cookie：s:value.signature
    if (opts.signed) {
      const secret = this._app && this._app.settings && this._app.settings.cookieParserSecret;
      if (secret) {
        const sig = crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
        cookieValue = 's:' + value + '.' + sig;
      }
    }
    let str = `${encodeURIComponent(name)}=${encodeURIComponent(cookieValue)}`;
    if (opts.maxAge !== undefined) str += `; Max-Age=${opts.maxAge}`;
    if (opts.domain) str += `; Domain=${opts.domain}`;
    if (opts.path) str += `; Path=${opts.path}`;
    if (opts.secure) str += '; Secure';
    if (opts.httpOnly) str += '; HttpOnly';
    if (opts.sameSite) str += `; SameSite=${opts.sameSite}`;
    const existing = this.getHeader('Set-Cookie');
    const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
    cookies.push(str);
    this.setHeader('Set-Cookie', cookies);
    return this;
  }

  /**
   * 清除 Cookie
   */
  clearCookie(name, opts = {}) {
    this.cookie(name, '', { ...opts, maxAge: 0 });
    return this;
  }
}

// ============================================================
// SSE 类
// ============================================================

class SSE {
  constructor(res) {
    this._res = res;
    this.connected = true;

    // 设置 SSE 标准响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // 监听连接关闭
    res.on('close', () => {
      this.connected = false;
    });
  }

  /**
   * 发送普通消息，自动兼容字符串/JSON 对象
   */
  send(data) {
    if (!this.connected) return this;
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    this._res.write(`data: ${msg}\n\n`);
    return this;
  }

  /**
   * 发送自定义命名事件
   */
  event(name, data) {
    if (!this.connected) return this;
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    this._res.write(`event: ${name}\ndata: ${msg}\n\n`);
    return this;
  }

  /**
   * 设置客户端重连间隔（毫秒）
   */
  retry(ms) {
    if (!this.connected) return this;
    this._res.write(`retry: ${ms}\n\n`);
    return this;
  }

  /**
   * 发送注释消息（可作为心跳保活）
   */
  comment(text) {
    if (!this.connected) return this;
    this._res.write(`: ${text}\n\n`);
    return this;
  }

  /**
   * 主动关闭 SSE 连接
   */
  close() {
    if (!this.connected) return;
    this.connected = false;
    this._res.end();
  }
}

// ============================================================
// WebSocket 类
// ============================================================

class WebSocket {
  constructor(socket, pathStr) {
    this.socket = socket;
    this.path = pathStr;
    this.id = uid();
    this.connected = true;
    this._lastHeartbeat = Date.now();
    this._handlers = {};

    // 监听底层 Pong 帧
    socket.on('pong', () => {
      this._lastHeartbeat = Date.now();
    });

    // 监听连接关闭
    socket.on('close', () => {
      this.connected = false;
      this._emit('close');
    });

    // 监听数据帧
    socket.on('data', (data) => {
      this._handleFrame(data);
    });

    socket.on('error', () => {
      this.connected = false;
      this._emit('error');
    });
  }

  /**
   * 解析 WebSocket 帧
   */
  _handleFrame(data) {
    if (data.length < 2) return;

    const firstByte = data[0];
    const secondByte = data[1];
    const opcode = firstByte & 0x0F;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    // 解析长度
    if (payloadLength === 126) {
      payloadLength = data.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      payloadLength = Number(data.readBigUInt64BE(offset));
      offset += 8;
    }

    // 解析掩码
    let mask = null;
    if (isMasked) {
      mask = data.slice(offset, offset + 4);
      offset += 4;
    }

    // 提取负载
    let payload = data.slice(offset, offset + payloadLength);
    if (isMasked && mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    switch (opcode) {
      case 0x01: { // 文本帧
        const text = payload.toString('utf8');
        this._emit('message', text);
        this._emit('text', text);
        break;
      }
      case 0x02: { // 二进制帧
        this._emit('message', payload);
        this._emit('binary', payload);
        break;
      }
      case 0x08: // 关闭帧
        this._sendCloseFrame();
        this.connected = false;
        this._emit('close');
        break;
      case 0x09: // Ping 帧
        this._sendPong(payload);
        break;
      case 0x0A: // Pong 帧
        this._lastHeartbeat = Date.now();
        break;
    }
  }

  /**
   * 发送数据，自动区分文本、JSON 对象、二进制 Buffer
   */
  send(data) {
    if (!this.connected) return;
    if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      this._sendFrame(0x01, Buffer.from(JSON.stringify(data)));
    } else if (typeof data === 'string') {
      this._sendFrame(0x01, Buffer.from(data));
    } else if (Buffer.isBuffer(data)) {
      this._sendFrame(0x02, data);
    }
  }

  /**
   * 构造并发送 WebSocket 帧
   */
  _sendFrame(opcode, payload) {
    if (!this.connected) return;
    const frames = [];

    // 第一字节：FIN + opcode
    frames.push(Buffer.from([0x80 | opcode]));

    // 第二字节：长度（服务端发送不掩码）
    if (payload.length < 126) {
      frames.push(Buffer.from([payload.length]));
    } else if (payload.length < 65536) {
      const buf = Buffer.alloc(3);
      buf[0] = 126;
      buf.writeUInt16BE(payload.length, 1);
      frames.push(buf);
    } else {
      const buf = Buffer.alloc(9);
      buf[0] = 127;
      buf.writeBigUInt64BE(BigInt(payload.length), 1);
      frames.push(buf);
    }

    frames.push(payload);
    const frame = Buffer.concat(frames);
    try {
      this.socket.write(frame);
    } catch (e) {
      this.connected = false;
    }
  }

  /**
   * 发送 Ping 帧
   */
  _sendPing() {
    this._sendFrame(0x09, Buffer.alloc(0));
  }

  /**
   * 发送 Pong 帧
   */
  _sendPong(payload) {
    this._sendFrame(0x0A, payload || Buffer.alloc(0));
  }

  /**
   * 发送关闭帧
   */
  _sendCloseFrame() {
    try {
      this._sendFrame(0x08, Buffer.alloc(0));
    } catch (e) {
      // 忽略关闭帧发送错误
    }
  }

  /**
   * 关闭连接
   */
  close() {
    this._sendCloseFrame();
    this.connected = false;
    try { this.socket.end(); } catch (e) { /* 忽略 */ }
    this._emit('close');
  }

  /**
   * 事件注册
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  /**
   * 触发事件
   */
  _emit(event, ...args) {
    const handlers = this._handlers[event];
    if (handlers) {
      handlers.forEach(h => {
        try { h(...args); } catch (e) { /* 忽略 */ }
      });
    }
  }
}

// ============================================================
// WebSocketServer 类
// ============================================================

/**
 * WebSocket 握手辅助函数：计算 Sec-WebSocket-Accept 值
 */
function WebSocketHandShark(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

class WebSocketServer {
  constructor(options = {}) {
    this.connections = new Map(); // id -> WebSocket
    this.groups = new Map();      // path -> Set<WebSocket>
    this._heartbeatInterval = options.heartbeatInterval || 30000;
    this._heartbeatTimeout = options.heartbeatTimeout || 30000;
    this._timer = null;
    this._handlers = {};
  }

  /**
   * 处理新的 WebSocket 升级请求
   */
  handleUpgrade(req, socket, head) {
    const pathname = parseUrl(req.url).pathname;

    // 执行 WebSocket 握手
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return null;
    }

    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    // 发送握手响应
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`
    ];
    socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

    // 创建 WebSocket 实例
    const ws = new WebSocket(socket, pathname);
    this.connections.set(ws.id, ws);

    // 按路径分组
    if (!this.groups.has(pathname)) {
      this.groups.set(pathname, new Set());
    }
    this.groups.get(pathname).add(ws);

    // 启动心跳
    this._startHeartbeat();

    // 监听连接关闭，自动清理
    ws.on('close', () => {
      this._removeConnection(ws);
    });

    // 触发 connection 事件
    this._emit('connection', ws, req);

    return ws;
  }

  /**
   * 移除连接
   */
  _removeConnection(ws) {
    this.connections.delete(ws.id);
    const group = this.groups.get(ws.path);
    if (group) {
      group.delete(ws);
      if (group.size === 0) {
        this.groups.delete(ws.path);
      }
    }
    // 无连接时停止心跳
    if (this.connections.size === 0) {
      this._stopHeartbeat();
    }
  }

  /**
   * 启动全局心跳定时器
   */
  _startHeartbeat() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      const now = Date.now();
      for (const ws of this.connections.values()) {
        if (!ws.connected) {
          this._removeConnection(ws);
          continue;
        }
        // 检查心跳超时
        if (now - ws._lastHeartbeat > this._heartbeatInterval + this._heartbeatTimeout) {
          ws.close();
          this._removeConnection(ws);
          continue;
        }
        ws._sendPing();
      }
    }, this._heartbeatInterval);
  }

  /**
   * 停止心跳定时器
   */
  _stopHeartbeat() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 按路径广播消息
   */
  broadcastTo(pathStr, data, exclude = null) {
    const group = this.groups.get(pathStr);
    if (!group) return;
    for (const ws of group) {
      if (ws.connected && ws !== exclude) {
        ws.send(data);
      }
    }
  }

  /**
   * 全局广播消息
   */
  broadcast(data, exclude = null) {
    for (const ws of this.connections.values()) {
      if (ws.connected && ws !== exclude) {
        ws.send(data);
      }
    }
  }

  /**
   * 获取指定路径的所有连接
   */
  getConnections(pathStr) {
    if (pathStr) {
      return Array.from(this.groups.get(pathStr) || []);
    }
    return Array.from(this.connections.values());
  }

  /**
   * 事件注册
   */
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  /**
   * 触发事件
   */
  _emit(event, ...args) {
    const handlers = this._handlers[event];
    if (handlers) {
      handlers.forEach(h => {
        try { h(...args); } catch (e) { /* 忽略 */ }
      });
    }
  }
}

// ============================================================
// 内置中间件
// ============================================================

/**
 * bodyParser 中间件：解析各类请求体
 */
function bodyParser(options = {}) {
  const maxFileSize = options.maxFileSize || 128 * 1024 * 1024;
  const maxFieldSize = options.maxFieldSize || 1024 * 1024;

  return function bodyParserMiddleware(req, res, next) {
    // 初始化 formData
    req.formData = { fields: { ...req.query }, files: [] };
    req.files = [];
    req._tempFiles = [];

    const contentType = req.headers['content-type'] || '';

    // 有 Content-Type 才尝试解析，否则跳过
    if (!contentType) {
      req.body = null;
      next();
      return;
    }

    if (contentType.includes('application/json')) {
      _parseJSON(req, maxFieldSize, next);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      _parseUrlencoded(req, maxFieldSize, next);
    } else if (contentType.includes('multipart/form-data')) {
      const boundary = _extractBoundary(contentType);
      if (boundary) {
        _parseMultipart(req, boundary, maxFileSize, maxFieldSize, next);
      } else {
        next();
      }
    } else {
      // 其他类型：原始 Buffer 存储
      req._readBody().then(buf => {
        req.body = buf.length > 0 ? buf : null;
        next();
      }).catch(next);
    }

    // 监听响应完成，自动清理临时文件
    res._res.on('finish', () => {
      _cleanupTempFiles(req._tempFiles);
    });
  };
}

/**
 * 解析 JSON 请求体
 */
function _parseJSON(req, maxSize, next) {
  req._readBody().then(buf => {
    if (buf.length > maxSize) {
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxSize)}`);
      err.status = 413;
      next(err);
      return;
    }
    try {
      req.body = JSON.parse(buf.toString('utf8'));
      // 合并到 formData.fields
      if (typeof req.body === 'object' && req.body !== null) {
        Object.assign(req.formData.fields, req.body);
      }
    } catch (e) {
      req.body = null;
    }
    next();
  }).catch(next);
}

/**
 * 解析 URL 编码请求体
 */
function _parseUrlencoded(req, maxSize, next) {
  req._readBody().then(buf => {
    if (buf.length > maxSize) {
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxSize)}`);
      err.status = 413;
      next(err);
      return;
    }
    const str = buf.toString('utf8');
    const parsed = {};
    str.split('&').forEach(pair => {
      const eIdx = pair.indexOf('=');
      if (eIdx === -1) {
        parsed[decodeURIComponent(pair)] = '';
      } else {
        parsed[decodeURIComponent(pair.substring(0, eIdx))] = decodeURIComponent(pair.substring(eIdx + 1));
      }
    });
    req.body = parsed;
    Object.assign(req.formData.fields, parsed);
    next();
  }).catch(next);
}

/**
 * 从 Content-Type 中提取 boundary
 */
function _extractBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  return match ? (match[1] || match[2]) : null;
}

/**
 * 流式解析 multipart/form-data
 * 基于状态机实现，边接收边解析边写入临时文件
 */
function _parseMultipart(req, boundary, maxFileSize, maxFieldSize, next) {
  const tempDir = req._app?.settings?.tempDir || 'tempupdir';
  const delimiter = Buffer.from('--' + boundary);
  const endDelimiter = Buffer.from('--' + boundary + '--');
  let state = 'INIT'; // INIT, HEADERS, BODY_FIELD, BODY_FILE
  let partHeadersBuf = Buffer.alloc(0);
  let currentField = { name: '', value: '' };
  let currentFile = { name: '', filename: '', contentType: '', size: 0, path: '', stream: null };
  let fieldSize = 0;
  let fileSize = 0;
  let buffer = Buffer.alloc(0);
  let cleanupOnError = false;

  // 确保临时目录存在
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  function processBuffer() {
    while (buffer.length > 0) {
      if (state === 'INIT') {
        // 查找第一个分隔符
        const idx = buffer.indexOf(delimiter);
        if (idx === -1) break;
        buffer = buffer.slice(idx + delimiter.length);
        // 跳过 \r\n
        if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.slice(2);
        }
        state = 'HEADERS';
        partHeadersBuf = Buffer.alloc(0);
      } else if (state === 'HEADERS') {
        // 查找头部结束标记 \r\n\r\n
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // 累积 Buffer 避免多字节截断
          partHeadersBuf = Buffer.concat([partHeadersBuf, buffer]);
          buffer = Buffer.alloc(0);
          break;
        }
        partHeadersBuf = Buffer.concat([partHeadersBuf, buffer.slice(0, headerEnd)]);
        buffer = buffer.slice(headerEnd + 4);
        const partHeaders = partHeadersBuf.toString('utf8');

        // 解析 Content-Disposition
        const nameMatch = partHeaders.match(/name="([^"]+)"/);
        const filenameMatch = partHeaders.match(/filename="([^"]+)"/);
        const ctMatch = partHeaders.match(/Content-Type:\s*(.+)/i);

        if (filenameMatch) {
          // 文件字段
          currentFile = {
            name: nameMatch ? nameMatch[1] : '',
            filename: filenameMatch[1],
            contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            size: 0,
            path: path.join(tempDir, `${uid()}_${filenameMatch[1]}`),
            stream: null
          };
          fileSize = 0;
          state = 'BODY_FILE';
          cleanupOnError = true;
        } else {
          // 普通字段
          currentField = { name: nameMatch ? nameMatch[1] : '', value: '' };
          fieldSize = 0;
          state = 'BODY_FIELD';
        }
      } else if (state === 'BODY_FIELD') {
        // 查找分隔符（字段结束）
        const idx = buffer.indexOf(delimiter);
        if (idx === -1) {
          // 还没结束，缓存数据（但检查大小限制）
          const chunk = buffer.toString('utf8');
          fieldSize += chunk.length;
          if (fieldSize > maxFieldSize) {
            const err = new Error(`Field exceeds maximum size of ${fmtSize(maxFieldSize)}`);
            err.status = 413;
            next(err);
            return;
          }
          currentField.value += chunk;
          buffer = Buffer.alloc(0);
          break;
        }
        // 字段结束
        const chunk = buffer.toString('utf8', 0, idx);
        fieldSize += chunk.length;
        if (fieldSize > maxFieldSize) {
          const err = new Error(`Field exceeds maximum size of ${fmtSize(maxFieldSize)}`);
          err.status = 413;
          next(err);
          return;
        }
        currentField.value += chunk;
        // 去掉末尾的 \r\n
        if (currentField.value.endsWith('\r\n')) {
          currentField.value = currentField.value.slice(0, -2);
        }
        req.formData.fields[currentField.name] = currentField.value;
        buffer = buffer.slice(idx + delimiter.length);
        // 跳过 \r\n
        if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.slice(2);
        }
        state = 'HEADERS';
        partHeadersBuf = Buffer.alloc(0);
      } else if (state === 'BODY_FILE') {
        // 查找分隔符（文件结束）
        const idx = buffer.indexOf(delimiter);
        if (idx === -1) {
          // 还没结束，写入临时文件
          if (!currentFile.stream) {
            currentFile.stream = fs.createWriteStream(currentFile.path);
          }
          currentFile.stream.write(buffer);
          fileSize += buffer.length;
          currentFile.size = fileSize;
          if (fileSize > maxFileSize) {
            if (currentFile.stream) currentFile.stream.close();
            const err = new Error(`File exceeds maximum size of ${fmtSize(maxFileSize)}`);
            err.status = 413;
            next(err);
            return;
          }
          // 进度展示（>1MB）
          if (fileSize > 1024 * 1024) {
            _showUploadProgress(currentFile.filename, fileSize, maxFileSize);
          }
          buffer = Buffer.alloc(0);
          break;
        }
        // 文件结束
        const fileData = buffer.slice(0, idx);
        // 去掉文件数据前的 \r\n
        const trimmedData = fileData.length >= 2 && fileData[fileData.length - 2] === 0x0D && fileData[fileData.length - 1] === 0x0A
          ? fileData.slice(0, -2)
          : fileData;

        if (!currentFile.stream) {
          currentFile.stream = fs.createWriteStream(currentFile.path);
        }
        currentFile.stream.write(trimmedData);
        currentFile.stream.end();
        fileSize += trimmedData.length;
        currentFile.size = fileSize;

        // 保存文件信息
        const fileInfo = {
          fieldname: currentFile.name,
          originalname: currentFile.filename,
          encoding: '7bit',
          mimetype: currentFile.contentType,
          size: currentFile.size,
          path: currentFile.path
        };
        req.formData.files.push(fileInfo);
        req.files.push(fileInfo);
        req._tempFiles.push(currentFile.path);

        cleanupOnError = false;
        buffer = buffer.slice(idx + delimiter.length);
        // 跳过 \r\n
        if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.slice(2);
        }
        state = 'HEADERS';
        partHeadersBuf = Buffer.alloc(0);
      }
    }
  }

  // 监听请求数据流
  req._req.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  });

  req._req.on('end', () => {
    // 处理剩余缓冲区
    processBuffer();
    req.body = req.formData.fields;
    next();
  });

  req._req.on('error', (err) => {
    // 客户端断开，清理临时文件
    if (cleanupOnError && currentFile.stream) {
      currentFile.stream.close();
    }
    _cleanupTempFiles(req._tempFiles);
    next(err);
  });
}

/**
 * 上传进度展示
 */
let _lastProgressLine = '';
function _showUploadProgress(filename, current, total) {
  const pct = ((current / total) * 100).toFixed(1);
  const line = `[${filename}] ${fmtSize(current)}/${fmtSize(total)} ${pct}%`;
  if (line !== _lastProgressLine) {
    process.stdout.write('\r' + line);
    _lastProgressLine = line;
  }
}

/**
 * 清理临时文件
 */
function _cleanupTempFiles(files) {
  if (!files || files.length === 0) return;
  files.forEach(f => {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) { /* 忽略清理失败 */ }
  });
}

/**
 * cookieParser 中间件：解析 Cookie
 */
function cookieParser(secret) {
  return function cookieParserMiddleware(req, res, next) {
    const cookieHeader = req.headers['cookie'] || '';
    req.cookies = parseCookies(cookieHeader);

    // 如果有 secret，对 Cookie 进行签名验证
    if (secret) {
      req.signedCookies = {};
      for (const [key, val] of Object.entries(req.cookies)) {
        if (val.startsWith('s:')) {
          // 签名 Cookie 格式: s:value.signature
          const unsigned = val.slice(2);
          const dotIdx = unsigned.lastIndexOf('.');
          if (dotIdx !== -1) {
            const value = unsigned.slice(0, dotIdx);
            const sig = unsigned.slice(dotIdx + 1);
            const expected = crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
            if (sig === expected) {
              req.signedCookies[key] = value;
            }
          }
        }
      }
    }
    next();
  };
}

// ============================================================
// Application 类
// ============================================================

class Application extends Router {
  constructor(options = {}) {
    super();
    // 配置加载优先级：默认配置 → app.json → 代码初始化参数 → 运行时 app.set()
    const fileConfig = _loadAppJson();
    this.settings = { ...defaultConfig, ...fileConfig, ...options };
    this.server = null;
    this._wss = null;
    this._logger = new Logger({
      level: this.settings.logLevel,
      logDir: this.settings.logDir
    });

    // 自动注册内置中间件
    if (this.settings.useBodyParser !== false) {
      this.use(bodyParser(this.settings.bodyParserOptions || {}));
    }
    if (this.settings.useCookieParser !== false) {
      this.use(cookieParser(this.settings.cookieParserSecret));
    }
  }

  /**
   * 设置全局运行时配置
   */
  set(name, value) {
    if (value === undefined) return this.settings[name];
    this.settings[name] = value;
    // 同步更新日志级别
    if (name === 'logLevel') {
      this._logger.level = value;
    }
    return this;
  }

  /**
   * 获取配置（当参数为字符串且非路由路径时）或注册 GET 路由
   */
  get(...args) {
    // 单个字符串参数且不是路径格式 → 获取配置
    if (args.length === 1 && typeof args[0] === 'string') {
      return this.settings[args[0]];
    }
    // 否则调用 Router 的 get 方法注册路由
    return Router.prototype.get.apply(this, args);
  }

  /**
   * 启动网络服务，监听端口
   */
  listen(port, callback) {
    const listenPort = port || this.settings.svrPort;
    const ip = this.settings.svrIP;

    // 创建服务器
    if (this.settings.http2) {
      // HTTP2 模式
      if (!this.settings.https || !this.settings.https.key || !this.settings.https.cert) {
        throw new Error('HTTP2 requires HTTPS configuration (key and cert)');
      }
      const opts = {
        key: fs.readFileSync(this.settings.https.key),
        cert: fs.readFileSync(this.settings.https.cert),
        allowHTTP1: true
      };
      if (this.settings.https.ca) opts.ca = fs.readFileSync(this.settings.https.ca);
      this.server = http2.createSecureServer(opts, this._handleRequest.bind(this));
    } else if (this.settings.https && this.settings.https.key && this.settings.https.cert) {
      // HTTPS 模式
      const opts = {
        key: fs.readFileSync(this.settings.https.key),
        cert: fs.readFileSync(this.settings.https.cert)
      };
      if (this.settings.https.ca) opts.ca = fs.readFileSync(this.settings.https.ca);
      if (this.settings.https.pfx) opts.pfx = fs.readFileSync(this.settings.https.pfx);
      this.server = https.createServer(opts, this._handleRequest.bind(this));
    } else {
      // HTTP 模式
      this.server = http.createServer(this._handleRequest.bind(this));
    }

    // 设置超时
    if (this.settings.timeout) {
      this.server.timeout = this.settings.timeout;
    }
    if (this.settings.keepAliveTimeout) {
      this.server.keepAliveTimeout = this.settings.keepAliveTimeout;
    }

    // 初始化 WebSocket 服务
    this._wss = new WebSocketServer({
      heartbeatInterval: this.settings.wsHeartbeatInterval,
      heartbeatTimeout: this.settings.wsHeartbeatTimeout
    });

    // 监听 WebSocket 升级请求
    this.server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    // 监听端口
    this.server.listen(listenPort, ip, () => {
      const addr = this.server.address();
      const protocol = this.settings.https ? 'https' : 'http';
      this._logger.info(`Server running at ${protocol}://${addr.address === '::' ? 'localhost' : addr.address}:${addr.port}/`);
      if (callback) callback();
    });

    return this.server;
  }

  /**
   * 停止服务，释放端口资源
   */
  close(callback) {
    if (this._wss) {
      // 关闭所有 WebSocket 连接
      for (const ws of this._wss.connections.values()) {
        ws.close();
      }
      this._wss._stopHeartbeat();
    }
    if (this.server) {
      this.server.close(callback);
    } else if (callback) {
      callback();
    }
  }

  /**
   * 处理 HTTP 请求（核心入口）
   */
  _handleRequest(incomingMessage, serverResponse) {
    const req = new Request(incomingMessage);
    const res = new Response(serverResponse, this);
    req._app = this;
    req._res = res;
    res._req = req;

    // 基础解析
    const parsed = parseUrl(incomingMessage.url);
    req.path = decodeURIComponent(parsed.pathname);
    req.query = parsed.query;

    // 解析 Cookie（中间件会再次处理，此处先做基础解析）
    req.cookies = parseCookies(incomingMessage.headers['cookie'] || '');

    // 构建中间件 + 路由处理器执行链
    this._dispatch(req, res);
  }

  /**
   * 分发请求到中间件链和路由处理器
   */
  _dispatch(req, res) {
    // 收集所有匹配的中间件和路由
    const stack = [];

    // 1. 应用级和路径级中间件（跳过错误处理中间件，4参数函数）
    const mwMatches = this.matchMiddleware(req.path);
    for (const mw of mwMatches) {
      for (const handler of mw.middleware.handlers) {
        if (handler.length === 4) continue; // 错误处理中间件不在正常链中执行
        stack.push({ handler, params: mw.params });
      }
    }

    // 2. 路由处理器
    const routeMatches = this.match(req.method, req.path);
    for (const match of routeMatches) {
      Object.assign(req.params, match.params);
      for (const handler of match.handlers) {
        stack.push({ handler, params: match.params });
      }
    }

    let idx = 0;

    const next = (err) => {
      // 错误处理：跳到错误处理中间件
      if (err) {
        this._handleError(err, req, res, stack, idx);
        return;
      }

      if (idx >= stack.length) {
        // 中间件和路由都执行完毕，进入默认兜底处理
        this._defaultHandler(req, res);
        return;
      }

      const item = stack[idx++];
      const handler = item.handler;

      try {
        // 路由处理器返回 false → 进入静态文件兜底
        const result = handler(req, res, next);
        if (result === false) {
          this._serveStatic(req, res);
          return;
        }
        // 支持 async/await
        if (result && typeof result.then === 'function') {
          result.then(r => {
            if (r === false) {
              this._serveStatic(req, res);
            }
          }).catch(err => {
            this._handleError(err, req, res, stack, idx);
          });
        }
      } catch (err) {
        this._handleError(err, req, res, stack, idx);
      }
    };

    next();
  }

  /**
   * 错误处理：查找错误处理中间件（4 个参数）
   */
  _handleError(err, req, res, stack, startIdx) {
    // 从当前栈中查找错误处理中间件
    for (let i = startIdx; i < stack.length; i++) {
      const handler = stack[i].handler;
      if (handler.length === 4) {
        try {
          handler(err, req, res, (e) => {
            this._handleError(e || null, req, res, stack, i + 1);
          });
          return;
        } catch (e) {
          err = e;
          continue;
        }
      }
    }
    // 没有错误处理中间件，使用默认错误响应
    const status = err.status || 500;
    const msg = err.message || 'Internal Server Error';
    this._logger.error(`[${status}] ${req.method} ${req.path} - ${msg}`);
    if (!res.headersSent && !res._res.headersSent) {
      res.status(status).json({ error: msg, status });
    }
  }

  /**
   * 默认兜底处理逻辑
   */
  _defaultHandler(req, res) {
    const method = req.method.toUpperCase();

    if (method === 'GET' || method === 'HEAD') {
      // 尝试静态文件服务
      this._serveStatic(req, res);
    } else if (method === 'OPTIONS') {
      // CORS 预检响应
      this._handleCORS(req, res);
    } else if (method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH') {
      // 已知方法但无匹配路由，返回 405 Method Not Allowed
      res.status(405).json({ error: 'Method Not Allowed', status: 405 });
    } else {
      // 其他未知方法返回 404
      res.status(404).json({ error: 'Not Found', status: 404 });
    }
  }

  /**
   * CORS 预检响应
   */
  _handleCORS(req, res) {
    const cors = this.settings.cors;
    if (!cors) {
      res.status(204)._send('');
      return;
    }
    const origin = typeof cors.origin === 'string' ? cors.origin : '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', cors.headers || 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', cors.maxAge || '86400');
    if (cors.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.status(204)._send('');
  }

  /**
   * 静态文件服务
   */
  _serveStatic(req, res) {
    const rootPath = this.settings.rootPath || process.cwd();
    // 去掉前导 / 防止被 path.resolve 当作绝对路径
    let requestPath = req.path.replace(/^\/+/, '');

    // 路径安全校验
    if (!isPathSafe(requestPath, rootPath)) {
      res.status(403).send('Forbidden');
      return;
    }

    const fullPath = path.join(rootPath, requestPath);

    fs.stat(fullPath, (err, stat) => {
      if (err) {
        res.status(404).json({ error: 'Not Found', status: 404 });
        return;
      }

      if (stat.isDirectory()) {
        // 目录：查找 index.html
        const indexPath = path.join(fullPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(path.relative(rootPath, indexPath), { root: rootPath });
          return;
        }
        // 展示目录列表
        if (this.settings.showDir) {
          this._serveDirectory(req, res, fullPath, requestPath);
        } else {
          res.status(404).json({ error: 'Not Found', status: 404 });
        }
        return;
      }

      // 文件：发送
      res.sendFile(requestPath, { root: rootPath });
    });
  }

  /**
   * 目录列表展示
   */
  _serveDirectory(req, res, dirPath, requestPath) {
    fs.readdir(dirPath, (err, files) => {
      if (err) {
        res.status(500).send('Internal Server Error');
        return;
      }

      const items = files.map(f => {
        try {
          const stat = fs.statSync(path.join(dirPath, f));
          return {
            name: f,
            isDirectory: stat.isDirectory(),
            size: stat.size,
            modified: stat.mtime.toISOString()
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);

      // 排序：目录在前
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // 生成 HTML 目录列表
      const html = this._renderDirectoryHTML(requestPath, items);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });
  }

  /**
   * 渲染目录列表 HTML
   */
  _renderDirectoryHTML(requestPath, items) {
    const parentPath = path.dirname(requestPath);
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Directory: ${requestPath}</title>`;
    html += `<style>body{font-family:-apple-system,sans-serif;margin:20px;background:#f5f5f5}h1{font-size:18px;color:#333}table{width:100%;border-collapse:collapse;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}th{text-align:left;padding:10px 12px;background:#f8f8f8;border-bottom:2px solid #ddd;font-size:13px;color:#666}td{padding:8px 12px;border-bottom:1px solid #eee;font-size:13px}a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}.dir{font-weight:bold}.size{color:#999}</style>`;
    html += `</head><body><h1>Directory: ${requestPath}</h1><table><tr><th>Name</th><th>Size</th><th>Modified</th></tr>`;

    // 父目录链接
    if (requestPath !== '/') {
      html += `<tr><td><a href="${parentPath}" class="dir">../</a></td><td class="size">-</td><td>-</td></tr>`;
    }

    for (const item of items) {
      const href = path.join(requestPath, item.name);
      const name = item.isDirectory ? item.name + '/' : item.name;
      const size = item.isDirectory ? '-' : fmtSize(item.size);
      const cls = item.isDirectory ? 'dir' : '';
      html += `<tr><td><a href="${href}" class="${cls}">${name}</a></td><td class="size">${size}</td><td class="size">${item.modified}</td></tr>`;
    }

    html += `</table></body></html>`;
    return html;
  }

  /**
   * 处理 WebSocket 升级请求
   */
  _handleUpgrade(req, socket, head) {
    const ws = this._wss.handleUpgrade(req, socket, head);
    if (!ws) return;

    // 匹配 app.ws() 注册的处理器
    if (this._wsHandlers) {
      const pathname = parseUrl(req.url).pathname;
      for (const entry of this._wsHandlers) {
        if (pathname === entry.path || pathname.startsWith(entry.path + '/')) {
          const cleanup = entry.handler(ws, req);
          if (typeof cleanup === 'function') {
            ws.on('close', cleanup);
          }
          break;
        }
      }
    }
  }

  /**
   * 获取 WebSocketServer 实例
   */
  get wss() {
    return this._wss;
  }

  /**
   * SSE 简化注册：app.sse(path, handler)
   * handler 签名: (sse, req) => cleanupFn|void
   */
  sse(pathStr, handler) {
    this.get(pathStr, (req, res) => {
      const sseInstance = res.sse();
      const cleanup = handler(sseInstance, req);
      // 连接关闭时执行清理
      res._res.on('close', () => {
        if (typeof cleanup === 'function') cleanup();
      });
    });
  }

  /**
   * WebSocket 简化注册：app.ws(path, handler)
   * handler 签名: (ws, req) => cleanupFn|void
   */
  ws(pathStr, handler) {
    if (!this._wsHandlers) this._wsHandlers = [];
    this._wsHandlers.push({ path: pathStr, handler });
  }
}

// ============================================================
// 默认配置
// ============================================================

/**
 * 自动加载 app.json 配置文件
 * 查找顺序：当前工作目录 → 模块所在目录
 * 文件不存在或格式错误时静默返回空对象，不影响启动
 */
function _loadAppJson() {
  const candidates = [
    path.join(process.cwd(), 'app.json'),
    path.join(__dirname, 'app.json')
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const config = JSON.parse(content);
        if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
          return config;
        }
      }
    } catch (e) {
      // 解析失败或读取失败，静默忽略
    }
  }
  return {};
}

const defaultConfig = {
  rootPath: process.cwd(),
  tempDir: 'tempupdir',
  maxFileSize: 128 * 1024 * 1024,
  maxFieldSize: 1024 * 1024,
  svrPort: 80,
  svrIP: null,

  showDir: false,
  enableCache: false,
  enableGzip: false,
  enableRange: true,
  cacheControl: 'public, max-age=3600',

  timeout: 120000,
  keepAliveTimeout: 65000,

  https: null,
  http2: false,

  logLevel: 'info',
  logDir: './log',

  cors: { origin: '*', headers: 'Content-Type, Authorization', maxAge: '86400' },

  useBodyParser: true,
  useCookieParser: true,
  bodyParserOptions: {},
  cookieParserSecret: null,

  wsHeartbeatInterval: 30000,
  wsHeartbeatTimeout: 30000
};

// ============================================================
// 导出接口层
// ============================================================

/**
 * httpm 入口函数，创建 Application 实例
 */
function httpm(options) {
  return new Application(options);
}

// 导出类
httpm.Application = Application;
httpm.Router = Router;
httpm.Request = Request;
httpm.Response = Response;
httpm.SSE = SSE;
httpm.WebSocket = WebSocket;
httpm.WebSocketServer = WebSocketServer;
httpm.Logger = Logger;

// 导出中间件
httpm.bodyParser = bodyParser;
httpm.cookieParser = cookieParser;

/**
 * static 中间件：Express 兼容的静态文件服务
 * 用法: app.use(httpm.static('public'))
 */
function staticMiddleware(rootPath) {
  return function staticHandler(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    const root = path.resolve(rootPath || process.cwd());
    let requestPath = req.path.replace(/^\/+/, '');
    if (!isPathSafe(requestPath, root)) {
      return next();
    }
    const fullPath = path.join(root, requestPath);
    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        return next();
      }
      res.sendFile(requestPath, { root });
    });
  };
}
httpm.static = staticMiddleware;

// 导出工具函数
httpm.parseUrl = parseUrl;
httpm.parseCookies = parseCookies;
httpm.getMimeType = getMimeType;
httpm.fmtSize = fmtSize;
httpm.fmtTime = fmtTime;
httpm.isPathSafe = isPathSafe;
httpm.generateETag = generateETag;
httpm.parseRange = parseRange;
httpm.WebSocketHandShark = WebSocketHandShark;

/**
 * parseQuery：独立导出的 Query 解析函数
 */
function parseQuery(qs) {
  const query = {};
  if (!qs) return query;
  qs.split('&').forEach(pair => {
    const eIdx = pair.indexOf('=');
    if (eIdx === -1) {
      query[decodeURIComponent(pair)] = '';
    } else {
      query[decodeURIComponent(pair.substring(0, eIdx))] = decodeURIComponent(pair.substring(eIdx + 1));
    }
  });
  return query;
}
httpm.parseQuery = parseQuery;

module.exports = httpm;
