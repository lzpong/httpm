/**
 * httpm - 基于 Node.js 原生模块的单文件、零依赖 HTTP 服务库
 *
 * @name        httpm
 * @version     1.3.1
 * @description 兼容 Express API，内置路由、中间件、静态文件服务、
 *              WebSocket、SSE、流式上传、日志系统等功能
 * @license     MIT
 * @requires    node >= 18.0.0
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
  const hashIdx = urlStr.indexOf('#');
  if (hashIdx !== -1) {
    urlStr = urlStr.substring(0, hashIdx);
  }
  const qIdx = urlStr.indexOf('?');
  if (qIdx === -1) {
    return { pathname: urlStr, query: {} };
  }
  return { pathname: urlStr.substring(0, qIdx), query: _parseQueryString(urlStr.substring(qIdx + 1)) };
}

/**
 * 解析查询字符串为键值对象
 */
function _parseQueryString(qs, plusAsSpace = false) {
  const query = {};
  if (!qs) return query;
  qs.split('&').forEach(pair => {
    const eIdx = pair.indexOf('=');
    if (eIdx === -1) {
      try {
        query[decodeURIComponent(plusAsSpace ? pair.replace(/\+/g, ' ') : pair)] = '';
      } catch (e) {
        // 非法 URI 编码，保留原始值
        query[plusAsSpace ? pair.replace(/\+/g, ' ') : pair] = '';
      }
    } else {
      const key = pair.substring(0, eIdx);
      const val = pair.substring(eIdx + 1);
      try {
        query[decodeURIComponent(plusAsSpace ? key.replace(/\+/g, ' ') : key)] = decodeURIComponent(plusAsSpace ? val.replace(/\+/g, ' ') : val);
      } catch (e) {
        // 非法 URI 编码，保留原始值
        query[plusAsSpace ? key.replace(/\+/g, ' ') : key] = plusAsSpace ? val.replace(/\+/g, ' ') : val;
      }
    }
  });
  return query;
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
 * HTML 实体转义，防止 XSS
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  const lower = ext?.toString().toLowerCase();
  return MIME_TYPES[lower] || 'application/octet-stream';
}

/**
 * 字节单位格式化（B/KB/MB/GB）
 */
function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes === 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / (1024 ** i);
  // 小于 10 时保留 2 位小数，否则保留 1 位，整数不显示小数
  const formatted = value < 10 ? value.toFixed(2) : (value === Math.floor(value) ? value.toString() : value.toFixed(1));
  return formatted + units[i];
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
function isPathSafe(requestPath, rootDir, allowAllFiles = false) {
  const normalized = requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, normalized);
  const root = path.resolve(rootDir);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return false;
  }
  // allowAllFiles=true 时允许访问所有文件（包括 .env、.git 等隐藏文件）
  if (!allowAllFiles) {
    const parts = normalized.split(/[/\\]/);
    for (const part of parts) {
      if (part.startsWith('.')) return false;
    }
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
    // 日志写入失败（如磁盘满 ENOSPC、权限 EACCES）时的处理策略：
    //   false（默认）= 仅控制台打印错误详情，主业务流程继续（业界主流）
    //   true = 控制台打印错误详情后退出进程，便于进程管理器（pm2/systemd）感知并重启
    //   注：配置项名取最常见场景（磁盘满 disk full），实际任何写入错误都会触发退出
    this.exitOnDiskFull = options.exitOnDiskFull === true;
    this._levels = { debug: 0, info: 1, notice: 2, warn: 3, error: 4, fatal: 5 };
    this._colors = {
      debug: '\x1b[1;30m',   // 灰色
      info: '\x1b[1;37m',    // 白色
      notice: '\x1b[1;35m',  // 品红
      warn: '\x1b[1;33m',    // 黄色
      error: '\x1b[1;31m',   // 红色
      fatal: '\x1b[1;31;1m'  // 红色加粗
    };
    this._reset = '\x1b[0m';
    this._stream = null;
    this._streamDate = null;
  }

  /**
   * 统一处理日志写入失败：控制台打印错误详情（含错误码，如 ENOSPC），exitOnDiskFull=true 时退出进程
   * 明确错误原因，避免笼统的"写入失败"，便于运维快速定位（磁盘满/权限/路径等）
   * @param {Error} err - 写入错误对象，通常含 code（如 ENOSPC）和 message
   */
  _handleWriteError(err) {
    const code = err && err.code ? ` [${err.code}]` : '';
    const msg = err && err.message ? err.message : String(err);
    console.error(`[Logger] 日志文件写入失败${code}: ${msg}`);
    if (this.exitOnDiskFull) {
      console.error(`[Logger] exitOnDiskFull=true，进程即将退出。原因${code}: ${msg}`);
      process.exit(1);
    }
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

    // 同一天复用同一个流
    const streamKey = `${year}-${month}-${day}`;
    if (this._stream && this._streamDate === streamKey) {
      return this._stream;
    }
    // 关闭旧流（等待写入完成后再销毁，避免跨日切换时丢失日志）
    // this._stream 已置 null，新日志将写入新流，旧流异步刷盘不会与新流冲突
    if (this._stream) {
      const oldStream = this._stream;
      oldStream.end(() => {
        oldStream.destroy();
      });
      this._stream = null;
    }
    // 创建日志目录: ./log/YYYY/MM/（recursive: true 自动处理已存在的情况）
    const dir = path.join(this.logDir, year, month);
    fs.mkdirSync(dir, { recursive: true });
    // 文件名: name_DD.log 或 DD.log
    const prefix = this.name ? this.name + '_' : '';
    const filePath = path.join(dir, `${prefix}${day}.log`);
    this._stream = fs.createWriteStream(filePath, { flags: 'a' });
    // 监听 error 事件：磁盘满（ENOSPC）、权限不足（EACCES）等异步错误统一交给 _handleWriteError 处理
    // 避免未捕获异常导致进程崩溃，同时控制台打印明确原因，便于运维感知
    this._stream.on('error', (err) => this._handleWriteError(err));
    this._streamDate = streamKey;
    return this._stream;
  }

  _writeFile(level, msg) {
    try {
      const stream = this._getLogStream();
      stream.write(msg + '\n');
    } catch (e) {
      // 同步异常（如 mkdirSync 失败）交给 _handleWriteError 统一处理，打印明确错误码
      this._handleWriteError(e);
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
  fatal(...args) { this.log('fatal', ...args); }
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

    // HEAD 请求同时匹配 GET 路由（Express 兼容行为）
    const methods = [m];
    if (m === 'HEAD') methods.push('GET');

    // 检查 ALL 路由
    const allRoutes = this.routes['ALL'] || [];
    // 检查对应方法路由
    let methodRoutes = [...allRoutes];
    for (const meth of methods) {
      const routes = this.routes[meth] || [];
      methodRoutes = methodRoutes.concat(routes);
    }

    for (const route of methodRoutes) {
      const match = route.pattern.exec(pathname);
      if (match) {
        const params = {};
        route.params.forEach((name, i) => {
          try {
            params[name] = decodeURIComponent(match[i + 1]);
          } catch (e) {
            // 非法 URI 编码，保留原始值
            params[name] = match[i + 1];
          }
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
                try {
                  params[name] = decodeURIComponent(match[i + 1]);
                } catch (e) {
                  // 非法 URI 编码，保留原始值
                  params[name] = match[i + 1];
                }
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
    this._app = null;
    this._res = null;
    this.query = {};
    this.params = {};
    this.body = null;
    this.cookies = {};
    this.signedCookies = {};
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
  // Express 兼容：originalUrl 保留原始 URL（与 url 等价，httpm 中间件不修改 url）
  get originalUrl() { return this._req.url; }
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
   * 获取请求头（Express 兼容），不区分大小写
   * req.get('Content-Type') / req.get('content-type')
   */
  get(name) {
    if (!name) return undefined;
    const lower = name.toLowerCase();
    // 特殊别名
    if (lower === 'referrer' || lower === 'referer') {
      return this._req.headers['referer'] || this._req.headers['referrer'];
    }
    return this._req.headers[lower];
  }

  /**
   * 读取请求体原始数据（带超时保护和大小限制）
   */
  _readBody(timeoutMs = 30000, maxSize = null) {
    return new Promise((resolve, reject) => {
      if (this._bodyParsed) {
        resolve(this._rawBody);
        return;
      }
      const chunks = [];
      let totalSize = 0;
      const limit = maxSize || (this._app?.settings?.maxBodySize) || 128 * 1024 * 1024;
      let timedOut = false;
      // 超时定时器
      const timer = setTimeout(() => {
        timedOut = true;
        this._req.destroy();
        reject(new Error('Request body read timeout', { cause: { timeoutMs } }));
      }, timeoutMs);
      this._req.on('data', chunk => {
        totalSize += chunk.length;
        // 流式大小检查，超限时立即中断
        if (totalSize > limit) {
          clearTimeout(timer);
          this._req.destroy();
          const err = new Error(`Request body exceeds maximum size of ${fmtSize(limit)}`, { cause: { actual: totalSize, maxSize: limit } });
          err.status = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      });
      this._req.on('end', () => {
        clearTimeout(timer);
        this._rawBody = Buffer.concat(chunks);
        this._bodyParsed = true;
        resolve(this._rawBody);
      });
      this._req.on('error', (err) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      });
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
    this._isHead = false;
    this._sse = null;
    // Express 兼容：请求级数据传递，中间件间共享数据
    this.locals = Object.create(null);
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
   * 设置 Location 响应头（Express 兼容）
   * 仅设置头部，不发送响应，常与 res.send() 配合使用
   */
  location(url) {
    this.setHeader('Location', url);
    return this;
  }

  /**
   * 设置响应头（Express 兼容），支持单键和对象批量设置
   * res.set('Content-Type', 'text/html')
   * res.set({ 'Content-Type': 'text/html', 'X-Custom': 'value' })
   */
  set(name, value) {
    if (typeof name === 'object') {
      for (const key of Object.keys(name)) {
        this._res.setHeader(key, name[key]);
      }
    } else {
      this._res.setHeader(name, value);
    }
    return this;
  }

  /**
   * 追加响应头值（Express 兼容），不覆盖已有值
   * 适用于 Set-Cookie、Link 等多值头场景
   */
  append(field, value) {
    const prev = this.getHeader(field);
    if (prev) {
      // 已有值：合并为数组
      const vals = Array.isArray(prev) ? prev : [prev];
      // Express 兼容：value 为数组时展开合并
      if (Array.isArray(value)) {
        vals.push(...value);
      } else {
        vals.push(value);
      }
      this.setHeader(field, vals);
    } else {
      this.setHeader(field, value);
    }
    return this;
  }

  /**
   * 设置 Content-Type（Express 兼容），支持简写
   * res.type('html') → text/html
   * res.type('.html') → text/html
   * res.type('text/html') → text/html
   */
  type(contentType) {
    // 已是完整 MIME 类型，直接设置
    if (contentType.includes('/')) {
      this.setHeader('Content-Type', contentType);
      return this;
    }
    // 简写或带点号扩展名，通过 getMimeType 解析
    const ext = contentType.startsWith('.') ? contentType : '.' + contentType;
    const mime = getMimeType(ext);
    this.setHeader('Content-Type', mime);
    return this;
  }

  /**
   * 代理原生 ServerResponse 事件监听（Express 兼容）
   * res.on('finish', fn) / res.on('close', fn)
   */
  on(event, listener) {
    this._res.on(event, listener);
    return this;
  }

  /**
   * 获取响应头（Express 兼容），不区分大小写
   * res.get('Content-Type')
   */
  get(name) {
    if (!name) return undefined;
    return this._res.getHeader(name);
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
    // Express 兼容：null 序列化为 "null"，undefined 返回空响应
    if (data === undefined) {
      this.setHeader('Content-Length', 0);
      this._send('');
      return;
    }
    if (data === null) {
      this.setHeader('Content-Type', 'text/html; charset=utf-8');
      this.setHeader('Content-Length', 4);
      this._send('null');
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
    // HEAD 请求只发送头部，不发送响应体
    if (this._isHead) {
      this._res.end();
    } else {
      this._res.end(data);
    }
  }

  /**
   * 发送本地文件，内置断点续传、缓存、Gzip 能力
   * Express 兼容签名：sendFile(path), sendFile(path, options), sendFile(path, options, callback), sendFile(path, callback)
   * callback(err) 在发送完成或出错时调用
   */
  sendFile(filePath, options, callback) {
    // 参数归一化：支持 sendFile(path, callback) 形式
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};
    const done = typeof callback === 'function' ? callback : null;
    // 防止回调被多次调用（finish 和 error 可能先后触发）
    let doneCalled = false;
    const doneOnce = (err) => {
      if (done && !doneCalled) { doneCalled = true; done(err); }
    };
    const root = options.root || this._app.settings.rootPath || process.cwd();
    const fullPath = path.resolve(root, filePath);

    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        this.status(404).send('Not Found');
        doneOnce(err || new Error('Not a file'));
        return;
      }

      const mime = getMimeType(path.extname(fullPath));
      // Content-Type 优先级：options.contentType > 已设置的 Content-Type > 自动检测
      if (options.contentType) {
        this.setHeader('Content-Type', options.contentType);
      } else if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', mime);
      }
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
          this.status(304);
          this.removeHeader('Content-Length');
          this._res.statusCode = 304;
          this._res.end();
          doneOnce(null);
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
          this._streamFile(fullPath, range.start, range.end, doneOnce);
          return;
        }
      }

      this.setHeader('Content-Length', stat.size);

      // Gzip 压缩（仅文本类文件）
      const acceptEncoding = this._req?.headers?.['accept-encoding'] || '';
      if (this._app.settings.enableGzip && isTextMime(mime) && acceptEncoding.includes('gzip')) {
        // HEAD 请求不传输内容
        if (this._isHead) {
          this._send('');
          doneOnce(null);
          return;
        }
        this.removeHeader('Content-Length');
        this.setHeader('Content-Encoding', 'gzip');
        this.status(this.statusCode);
        this._headersSent = true;
        const raw = fs.createReadStream(fullPath);
        const gzip = zlib.createGzip();
        // 流错误处理：文件读取或压缩出错时返回 500
        const onError = (streamErr) => {
          raw.destroy();
          gzip.destroy();
          if (!this._res.finished) {
            this._res.statusCode = 500;
            this._res.end('Internal Server Error');
          }
          doneOnce(streamErr);
        };
        raw.on('error', onError);
        gzip.on('error', onError);
        // 流完成时回调
        this._res.on('finish', () => doneOnce(null));
        raw.pipe(gzip).pipe(this._res);
        return;
      }

      this._streamFile(fullPath, 0, stat.size - 1, doneOnce);
    });
  }

  /**
   * 流式发送文件
   */
  _streamFile(fullPath, start, end, callback) {
    // 防止回调被多次调用
    let called = false;
    const done = (err) => {
      if (callback && !called) { called = true; callback(err); }
    };
    if (this._res.finished) {
      done(null);
      return;
    }
    this._res.statusCode = this.statusCode;
    this._headersSent = true;
    // HEAD 请求只发送头部，不传输文件内容
    if (this._isHead) {
      this._res.end();
      done(null);
      return;
    }
    const stream = fs.createReadStream(fullPath, { start, end });
    // 流错误处理：文件读取出错时返回 500
    stream.on('error', (err) => {
      stream.destroy();
      if (!this._res.finished) {
        this._res.statusCode = 500;
        this._res.end('Internal Server Error');
      }
      done(err);
    });
    // 流完成时回调
    this._res.on('finish', () => done(null));
    stream.pipe(this._res);
  }

  /**
   * 触发浏览器文件下载，支持大文件进度展示
   */
  download(filePath, filename, options) {
    // Express 兼容签名：download(path), download(path, filename), download(path, filename, options), download(path, options)
    let name = filename;
    let opts = options;
    if (typeof filename === 'object' && filename !== null) {
      // download(path, options) 形式
      opts = filename;
      name = null;
    }
    name = name || path.basename(filePath);
    opts = opts || {};
    // RFC 6266: 同时提供 filename（兼容旧浏览器）和 filename*（UTF-8，支持非 ASCII 文件名）
    const encodedName = encodeURIComponent(name);
    this.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
    this.sendFile(filePath, opts);
  }

  /**
   * 重定向响应（兼容 Express: redirect(status, url) 或 redirect(url)）
   */
  redirect(...args) {
    if (typeof args[0] === 'number') {
      // redirect(status, url)
      this.status(args[0]);
      this.setHeader('Location', args[1]);
    } else {
      // redirect(url) 默认 302
      this.status(302);
      this.setHeader('Location', args[0]);
    }
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
    // Express 兼容：对象值先 JSON 序列化，便于存储结构化数据
    let rawValue = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
    let encodedValue = encodeURIComponent(rawValue);
    // 签名 Cookie：s:value.signature（s: 前缀不参与编码，签名基于原始值）
    if (opts.signed) {
      const secret = this._app && this._app.settings && this._app.settings.cookieParserSecret;
      if (secret) {
        const sig = crypto.createHmac('sha256', secret).update(rawValue).digest('base64').replace(/=+$/, '');
        encodedValue = 's:' + encodedValue + '.' + sig;
      }
    }
    let str = `${encodeURIComponent(name)}=${encodedValue}`;
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

    // 设置 SSE 标准响应头（仅在 headers 未发送时）
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
    }

    // 监听连接关闭（兼容 HTTP/1.1 和 HTTP/2）
    const onClose = () => {
      this.connected = false;
    };
    this._onClose = onClose;
    res.on('close', onClose);
    // HTTP/1.1 兼容：aborted 事件在请求被客户端中断时触发
    res.on('aborted', onClose);
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
   * 多行文本会按行拆分，每行均以 : 前缀标记为注释，避免破坏 SSE 协议
   */
  comment(text) {
    if (!this.connected) return this;
    // 按行拆分，每行加 : 前缀，确保多行注释不破坏 SSE 协议
    const lines = String(text).split('\n');
    const payload = lines.map(line => `: ${line}`).join('\n') + '\n\n';
    this._res.write(payload);
    return this;
  }

  /**
   * 主动关闭 SSE 连接，移除监听器防止内存泄漏
   */
  close() {
    if (!this.connected) return;
    this.connected = false;
    this._res.removeListener('close', this._onClose);
    this._res.removeListener('aborted', this._onClose);
    this._res.end();
  }
}

// ============================================================
// WebSocket 类
// ============================================================

/**
 * 通用事件触发函数（WebSocket 和 WebSocketServer 共用）
 */
function _emitEvent(handlers, event, args) {
  const list = handlers[event];
  if (list) {
    list.forEach(h => {
      try { h(...args); } catch (e) { console.error(`[httpm] Event handler error on "${event}":`, e); }
    });
  }
}

class WebSocket {
  constructor(socket, pathStr, options = {}) {
    this.socket = socket;
    this.path = pathStr;
    this.id = uid();
    this.connected = true;
    this._lastHeartbeat = Date.now();
    this._handlers = {};
    // 最大帧负载大小（默认 100MB，防止恶意超大帧耗尽内存）
    this._maxPayload = options.maxPayload || 100 * 1024 * 1024;
    // 帧解析状态：缓存不完整帧数据
    this._frameBuffer = Buffer.alloc(0);
    // 分片帧状态
    this._fragmented = false;
    this._fragmentOpcode = 0;
    this._fragmentPayloads = [];
    // 防止 close 事件重复触发
    this._closed = false;
    // 关闭握手状态
    this._closing = false;
    this._closeTimer = null;

    // 监听底层 Pong 帧
    socket.on('pong', () => {
      this._lastHeartbeat = Date.now();
    });

    // 监听连接关闭
    socket.on('close', () => {
      this.connected = false;
      this._emitClose();
    });

    // 监听数据帧
    socket.on('data', (data) => {
      this._frameBuffer = Buffer.concat([this._frameBuffer, data]);
      this._parseFrames();
    });

    // 监听底层错误，传递错误对象
    socket.on('error', (err) => {
      this.connected = false;
      this._emit('error', err);
    });
  }

  /**
   * 循环解析帧缓冲区，处理多帧/半帧
   */
  _parseFrames() {
    while (this._frameBuffer.length >= 2) {
      const result = this._decodeFrame(this._frameBuffer);
      if (result === null) break; // 数据不完整，等待更多数据
      this._frameBuffer = this._frameBuffer.subarray(result.bytesConsumed);
      this._processFrame(result.opcode, result.payload, result.fin, result.oversize);
    }
  }

  /**
   * 从缓冲区解码一个帧，返回 { opcode, payload, fin, bytesConsumed } 或 null（数据不完整）
   */
  _decodeFrame(buf) {
    if (buf.length < 2) return null;

    const firstByte = buf[0];
    const secondByte = buf[1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0F;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    // 解析长度
    if (payloadLength === 126) {
      if (buf.length < 4) return null;
      payloadLength = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buf.length < 10) return null;
      const bigLen = buf.readBigUInt64BE(offset);
      // 超过 Number.MAX_SAFE_INTEGER 时精度丢失，直接视为超限
      if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { opcode: 0xFF, payload: Buffer.alloc(0), fin: true, bytesConsumed: buf.length, oversize: true };
      }
      payloadLength = Number(bigLen);
      offset += 8;
    }

    // 解析掩码
    let mask = null;
    if (isMasked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    // 检查负载数据是否完整
    if (buf.length < offset + payloadLength) return null;

    // 最大负载限制检查，超限时返回错误标记
    if (payloadLength > this._maxPayload) {
      return { opcode: 0xFF, payload: Buffer.alloc(0), fin: true, bytesConsumed: offset + payloadLength, oversize: true };
    }

    // 提取负载
    let payload = buf.subarray(offset, offset + payloadLength);
    if (isMasked && mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    return { opcode, payload, fin, bytesConsumed: offset + payloadLength };
  }

  /**
   * 处理解码后的帧，支持分片帧（continuation frame, opcode=0x00）
   */
  _processFrame(opcode, payload, fin, oversize) {
    // 超限帧：直接关闭连接
    if (oversize) {
      this.close(1009, 'Frame payload too large');
      return;
    }
    // 关闭握手期间忽略数据帧
    if (this._closing && opcode !== 0x08 && opcode !== 0x09 && opcode !== 0x0A) {
      return;
    }
    // 控制帧（close/ping/pong）不分片，立即处理
    if (opcode === 0x08) {
      // 解析 Close 帧状态码和原因（RFC 6455 Section 5.5.1）
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        // RFC 6455 Section 7.4: 状态码 0-999 为非法，1005 表示无状态码
        if (code < 1000) code = 1005;
        reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      }
      // 如果正在关闭握手中，对端已回复 Close 帧，完成握手
      if (this._closing) {
        clearTimeout(this._closeTimer);
        this._closeTimer = null;
        try { this.socket.end(); } catch (e) { /* 忽略 */ }
        this._emitClose(code, reason);
        return;
      }
      // 非关闭握手状态：回复 Close 帧后关闭
      // RFC 6455 Section 7.4.1: 1005/1006 状态码不得在 Close 帧中发送
      this._sendCloseFrame(code === 1005 || code === 1006 ? undefined : code);
      this.connected = false;
      this._emitClose(code, reason);
      return;
    }
    if (opcode === 0x09) {
      this._sendPong(payload);
      return;
    }
    if (opcode === 0x0A) {
      this._lastHeartbeat = Date.now();
      return;
    }

    // 数据帧：处理分片
    if (opcode === 0x00) {
      // 分片续帧：必须有前导帧
      if (!this._fragmented) return;
      this._fragmentPayloads.push(payload);
      if (fin) {
        // 分片结束，合并并触发事件
        const fullPayload = Buffer.concat(this._fragmentPayloads);
        this._emitData(this._fragmentOpcode, fullPayload);
        this._fragmented = false;
        this._fragmentPayloads = [];
      }
    } else {
      // 新消息帧（opcode=0x01/0x02）
      if (fin) {
        // 非分片：直接触发
        this._emitData(opcode, payload);
      } else {
        // 分片开始
        this._fragmented = true;
        this._fragmentOpcode = opcode;
        this._fragmentPayloads = [payload];
      }
    }
  }

  /**
   * 根据操作码触发数据事件
   */
  _emitData(opcode, payload) {
    if (opcode === 0x01) {
      const text = payload.toString('utf8');
      this._emit('data', { type: 'text', data: text });
      this._emit('text', text);
    } else if (opcode === 0x02) {
      this._emit('data', { type: 'binary', data: payload });
      this._emit('binary', payload);
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
      // 发送失败时触发 error 事件，便于用户感知和处理
      this._emit('error', e);
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
  _sendCloseFrame(code, reason) {
    try {
      let payload = Buffer.alloc(0);
      // RFC 6455: Close 帧可携带状态码（2字节）+ 可选原因（UTF-8）
      if (code !== undefined && code !== null) {
        const reasonBuf = reason ? Buffer.from(reason, 'utf8') : Buffer.alloc(0);
        payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
      }
      this._sendFrame(0x08, payload);
    } catch (e) {
      // 忽略关闭帧发送错误
    }
  }

  /**
   * 关闭连接（限时等待对端 Close 帧完成握手）
   * @param {number} [code] 关闭状态码（RFC 6455 Section 7.4）
   * @param {string} [reason] 关闭原因
   */
  close(code, reason) {
    if (this._closed) return;
    // 重要：必须先发送 Close 帧再设 connected=false
    // _sendFrame 内部检查 this.connected，若先断开则 Close 帧无法发出
    this._sendCloseFrame(code, reason);
    // 标记为关闭中，拒绝后续数据帧发送和 _sendFrame 写入
    this.connected = false;
    this._closing = true;
    // 限时等待对端 Close 帧（2秒超时）
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      // 先标记已关闭，防止 socket.destroy 触发 close 事件时重复 _emitClose
      this._closed = true;
      try { this.socket.destroy(); } catch (e) { /* 忽略 */ }
      this._emitClose(code, reason);
    }, 2000);
  }

  /**
   * 安全触发 close 事件（防止重复触发）
   */
  _emitClose(code, reason) {
    if (this._closed) return;
    this._closed = true;
    // 清理关闭握手定时器
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    this._emit('close', code, reason);
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
    _emitEvent(this._handlers, event, args);
  }
}

// ============================================================
// WebSocketServer 类
// ============================================================

/**
 * WebSocket 握手辅助函数：计算 Sec-WebSocket-Accept 值
 */
function WebSocketHandShak(key) {
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
    this._maxPayload = options.maxPayload || 100 * 1024 * 1024;
    this._allowedOrigins = options.allowedOrigins || null;
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

    // Origin 校验（防止跨站 WebSocket 劫持 CSWSH）
    if (this._allowedOrigins) {
      const origin = req.headers['origin'];
      if (!origin || !this._allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return null;
      }
    }

    const accept = WebSocketHandShak(key);

    // 发送握手响应
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`
    ];
    socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

    // 创建 WebSocket 实例
    const ws = new WebSocket(socket, pathname, { maxPayload: this._maxPayload });
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
      // 先收集需移除的连接，遍历结束后统一移除，避免迭代中修改 Map
      const toRemove = [];
      for (const ws of this.connections.values()) {
        if (!ws.connected) {
          toRemove.push(ws);
          continue;
        }
        // 检查心跳超时
        if (now - ws._lastHeartbeat > this._heartbeatInterval + this._heartbeatTimeout) {
          ws.close();
          toRemove.push(ws);
          continue;
        }
        ws._sendPing();
      }
      for (const ws of toRemove) {
        this._removeConnection(ws);
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
  broadcast(pathStr, data, exclude = null) {
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
  broadcastAll(data, exclude = null) {
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
    _emitEvent(this._handlers, event, args);
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
  // JSON/urlencoded 请求体大小限制（语义区别于 maxFieldSize 表单字段）
  const maxBodySize = options.maxBodySize || 128 * 1024 * 1024;

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
      _parseJSON(req, maxBodySize, next);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      _parseUrlencoded(req, maxBodySize, next);
    } else if (contentType.includes('multipart/form-data')) {
      const boundary = _extractBoundary(contentType);
      if (boundary) {
        _parseMultipart(req, boundary, maxFileSize, maxFieldSize, next);
        // 仅 multipart 需要临时文件清理（使用 res.on 保持封装一致性）
        res.on('finish', () => {
          _cleanupTempFiles(req._tempFiles);
        });
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
  };
}

/**
 * 解析 JSON 请求体
 */
function _parseJSON(req, maxSize, next) {
  req._readBody().then(buf => {
    if (buf.length > maxSize) {
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxSize)}`, { cause: { actual: buf.length, maxSize } });
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
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxSize)}`, { cause: { actual: buf.length, maxSize } });
      err.status = 413;
      next(err);
      return;
    }
    const parsed = _parseQueryString(buf.toString('utf8'), true);
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
  // 回看长度：分隔符最大可能被截断的字节数
  const lookBehind = delimiter.length - 1;
  let state = 'INIT'; // INIT, HEADERS, BODY_FIELD, BODY_FILE
  let partHeadersBuf = Buffer.alloc(0);
  let currentField = { name: '', value: '' };
  let currentFile = { name: '', filename: '', contentType: '', size: 0, path: '', stream: null };
  let fieldSize = 0;
  let fileSize = 0;
  let buffer = Buffer.alloc(0);
  let cleanupOnError = false;
  let paused = false;

  // 确保临时目录存在（recursive: true 时目录已存在不报错，无需 existsSync）
  fs.mkdirSync(tempDir, { recursive: true });

  function processBuffer() {
    while (buffer.length > 0) {
      if (state === 'INIT') {
        // 查找第一个分隔符
        const idx = buffer.indexOf(delimiter);
        if (idx === -1) {
          // 保留尾部回看字节，防止分隔符跨 chunk 截断
          if (buffer.length > lookBehind) {
            buffer = buffer.subarray(buffer.length - lookBehind);
          }
          break;
        }
        buffer = buffer.subarray(idx + delimiter.length);
        // 跳过 \r\n
        if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.subarray(2);
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
        partHeadersBuf = Buffer.concat([partHeadersBuf, buffer.subarray(0, headerEnd)]);
        buffer = buffer.subarray(headerEnd + 4);
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
          // 保留尾部回看字节，防止分隔符跨 chunk 截断
          const safeLen = Math.max(0, buffer.length - lookBehind);
          const chunk = buffer.toString('utf8', 0, safeLen);
          fieldSize += safeLen;
          if (fieldSize > maxFieldSize) {
            const err = new Error(`Field exceeds maximum size of ${fmtSize(maxFieldSize)}`, { cause: { actual: fieldSize, maxSize: maxFieldSize } });
            err.status = 413;
            next(err);
            return;
          }
          currentField.value += chunk;
          buffer = buffer.subarray(safeLen);
          break;
        }
        // 字段结束
        const chunk = buffer.toString('utf8', 0, idx);
        fieldSize += idx;
        if (fieldSize > maxFieldSize) {
          const err = new Error(`Field exceeds maximum size of ${fmtSize(maxFieldSize)}`, { cause: { actual: fieldSize, maxSize: maxFieldSize } });
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
        buffer = buffer.subarray(idx + delimiter.length);
        // 跳过 \r\n
        if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.subarray(2);
        }
        state = 'HEADERS';
        partHeadersBuf = Buffer.alloc(0);
      } else if (state === 'BODY_FILE') {
        // 查找分隔符（文件结束）
        const idx = buffer.indexOf(delimiter);
        if (idx === -1) {
          // 还没结束，写入临时文件
          // 保留尾部回看字节，防止分隔符跨 chunk 截断
          const safeLen = Math.max(0, buffer.length - lookBehind);
          const writeData = buffer.subarray(0, safeLen);
          if (!currentFile.stream) {
            currentFile.stream = fs.createWriteStream(currentFile.path);
            // 背压处理：写入流满时暂停请求读取，drain 后恢复
            currentFile.stream.on('drain', () => {
              if (paused) {
                paused = false;
                req._req.resume();
              }
            });
          }
          const canWrite = currentFile.stream.write(writeData);
          // 写入流缓冲区满时暂停请求读取，避免内存积压
          if (!canWrite) {
            paused = true;
            req._req.pause();
          }
          fileSize += writeData.length;
          currentFile.size = fileSize;
          if (fileSize > maxFileSize) {
            if (currentFile.stream) currentFile.stream.destroy();
            const err = new Error(`File exceeds maximum size of ${fmtSize(maxFileSize)}`, { cause: { actual: fileSize, maxSize: maxFileSize, filename: currentFile.filename } });
            err.status = 413;
            next(err);
            return;
          }
          buffer = buffer.subarray(safeLen);
          break;
        }
        // 文件结束
        const fileData = buffer.subarray(0, idx);
        // 去掉文件数据前的 \r\n
        const trimmedData = fileData.length >= 2 && fileData.at(-2) === 0x0D && fileData.at(-1) === 0x0A
          ? fileData.subarray(0, -2)
          : fileData;

        if (!currentFile.stream) {
          currentFile.stream = fs.createWriteStream(currentFile.path);
        }
        currentFile.stream.write(trimmedData);
        // 结束写入（注意：stream.end 为异步操作，极端情况如磁盘满时可能写入不完整，
        // 但 fileInfo 仍会被记录。若需严格保证写入完整性，需改为异步流程）
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

        // 清理上传进度条目
        cleanupOnError = false;
        buffer = buffer.subarray(idx + delimiter.length);
        // 跳过 \r\n
        if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.subarray(2);
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
      currentFile.stream.destroy();
    }
    _cleanupTempFiles(req._tempFiles);
    next(err);
  });
}

/**
 * 异步清理临时文件，避免阻塞事件循环
 */
function _cleanupTempFiles(files) {
  if (!files || files.length === 0) return;
  files.forEach(f => {
    fs.unlink(f, () => { /* 忽略清理失败 */ });
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
          // 签名 Cookie 格式: s:encodedValue.signature
          const unsigned = val.slice(2);
          const dotIdx = unsigned.lastIndexOf('.');
          if (dotIdx !== -1) {
            const encodedValue = unsigned.slice(0, dotIdx);
            const sig = unsigned.slice(dotIdx + 1);
            // 签名是对原始值计算的，需先解码
            let rawValue;
            try {
              rawValue = decodeURIComponent(encodedValue);
            } catch (e) {
              continue;
            }
            const expected = crypto.createHmac('sha256', secret).update(rawValue).digest('base64').replace(/=+$/, '');
            if (sig === expected) {
              req.signedCookies[key] = rawValue;
              // Express 兼容：验证通过后从 req.cookies 中删除，防止误用未验证的签名值
              delete req.cookies[key];
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
      logDir: this.settings.logDir,
      exitOnDiskFull: this.settings.exitOnDiskFull
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
        throw new Error('HTTP2 requires HTTPS configuration (key and cert)', { cause: { https: !!this.settings.https, hasKey: !!(this.settings.https && this.settings.https.key), hasCert: !!(this.settings.https && this.settings.https.cert) } });
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
      heartbeatTimeout: this.settings.wsHeartbeatTimeout,
      maxPayload: this.settings.wsMaxPayload,
      allowedOrigins: this.settings.wsAllowedOrigins
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
    try {
      req.path = decodeURIComponent(parsed.pathname);
    } catch (e) {
      // 非法 URI 编码，返回 400
      res.status(400).send('Bad Request: Invalid URI encoding');
      return;
    }
    req.query = parsed.query;
    // Cookie 由 cookieParser 中间件统一解析，此处不再重复处理

    // HEAD 请求标记：执行路由处理器但丢弃响应体
    if (req.method === 'HEAD') {
      res._isHead = true;
    }

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
      // 防止同一 handler 多次调用 next()
      let handlerCalledNext = false;
      const safeNext = (e) => {
        if (handlerCalledNext && !e) return;
        handlerCalledNext = true;
        next(e);
      };

      try {
        // 路由处理器返回 false → 进入静态文件兜底
        const result = handler(req, res, safeNext);
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
    // 无错误时直接返回（错误处理中间件调用 next() 无参数表示错误已处理）
    if (!err) return;
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
    if (!res.headersSent) {
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
      // 已知方法但无匹配路由，返回 405 Method Not Allowed（RFC 7231 要求必须包含 Allow 头）
      const allowed = this._getAllowedMethods(req.path);
      res.set('Allow', allowed.join(', ')).status(405).json({ error: 'Method Not Allowed', status: 405 });
    } else {
      // 其他未知方法返回 404
      res.status(404).json({ error: 'Not Found', status: 404 });
    }
  }

  /**
   * CORS 预检响应（动态查询该路径支持的 HTTP 方法）
   */
  _handleCORS(req, res) {
    const cors = this.settings.cors;
    if (!cors) {
      res.status(204)._send('');
      return;
    }
    // 动态查找该路径匹配的所有 HTTP 方法
    const allowedMethods = this._getAllowedMethods(req.path);
    // origin 支持字符串、数组、函数：数组时检查请求 Origin 是否在列表中
    let origin = '*';
    const reqOrigin = req.headers['origin'];
    if (typeof cors.origin === 'string') {
      origin = cors.origin;
    } else if (Array.isArray(cors.origin)) {
      origin = (reqOrigin && cors.origin.includes(reqOrigin)) ? reqOrigin : '*';
    } else if (typeof cors.origin === 'function') {
      origin = cors.origin(reqOrigin) || '*';
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    // 当 origin 为具体域名（非 *）时，回显 Vary: Origin
    if (origin !== '*') {
      res.setHeader('Vary', 'Origin');
    }
    // 动态设置允许的方法列表，而非硬编码
    res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', cors.headers || 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', parseInt(cors.maxAge, 10) || 86400);
    // Allow 头告知客户端该路径实际支持的方法
    res.setHeader('Allow', allowedMethods.join(', '));
    if (cors.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.status(204)._send('');
  }

  /**
   * 查询指定路径支持的所有 HTTP 方法（含隐式 HEAD）
   * 用于 OPTIONS Allow 头和 405 Method Not Allowed 响应
   */
  _getAllowedMethods(pathname) {
    const methods = new Set();
    // 遍历所有已注册方法的路由，查找匹配该路径的方法
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const routes = this.routes[method] || [];
      for (const route of routes) {
        if (route.pattern.exec(pathname)) {
          methods.add(method);
          break;
        }
      }
    }
    // 检查 ALL 中间件路由
    const allRoutes = this.routes['ALL'] || [];
    for (const route of allRoutes) {
      if (route.pattern.exec(pathname)) {
        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].forEach(m => methods.add(m));
        break;
      }
    }
    // GET 路由隐式支持 HEAD
    if (methods.has('GET')) methods.add('HEAD');
    // OPTIONS 始终可用（CORS 预检）
    methods.add('OPTIONS');
    return [...methods].sort();
  }

  /**
   * 静态文件服务
   */
  _serveStatic(req, res) {
    const rootPath = this.settings.rootPath || process.cwd();
    // 去掉前导 / 防止被 path.resolve 当作绝对路径
    let requestPath = req.path.replace(/^\/+/, '');

    // 路径安全校验
    if (!isPathSafe(requestPath, rootPath, this.settings.allowAccessToAllFiles)) {
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
        // 目录：查找 index.html（异步检查避免阻塞事件循环）
        const indexPath = path.join(fullPath, 'index.html');
        fs.stat(indexPath, (idxErr) => {
          if (!idxErr) {
            res.sendFile(path.relative(rootPath, indexPath), { root: rootPath });
            return;
          }
          // 展示目录列表
          if (this.settings.showDir) {
            this._serveDirectory(req, res, fullPath, requestPath);
          } else {
            res.status(404).json({ error: 'Not Found', status: 404 });
          }
        });
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
    // 使用 withFileTypes 避免对每个文件做 statSync 调用
    fs.readdir(dirPath, { withFileTypes: true }, (err, entries) => {
      if (err) {
        res.status(500).send('Internal Server Error');
        return;
      }

      // 异步获取文件信息，避免同步阻塞事件循环
      const tasks = entries.map(entry => {
        if (entry.isDirectory()) {
          return Promise.resolve({ name: entry.name, isDirectory: true, size: 0, modified: '' });
        }
        return fs.promises.stat(path.join(dirPath, entry.name))
          .then(stat => ({
            name: entry.name,
            isDirectory: false,
            size: stat.size,
            modified: stat.mtime.toISOString()
          }))
          .catch(() => null);
      });

      Promise.all(tasks).then(results => {
        const items = results.filter(Boolean);
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
      }).catch(() => {
        res.status(500).send('Internal Server Error');
      });
    });
  }

  /**
   * 渲染目录列表 HTML
   */
  _renderDirectoryHTML(requestPath, items) {
    // requestPath 已去掉前导 /，空字符串表示根目录
    // 根目录时显示 '/'，否则显示请求路径
    const displayPath = requestPath || '/';
    // 构建链接前缀：确保以 / 开头并以 / 结尾，用于生成绝对路径 href
    const prefix = '/' + (requestPath ? requestPath.replace(/\/+$/, '') + '/' : '');
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Directory: ${escapeHtml(displayPath)}</title>`;
    html += `<style>body{font-family:-apple-system,sans-serif;margin:20px;background:#f5f5f5}h1{font-size:18px;color:#333}table{width:100%;border-collapse:collapse;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}th{text-align:left;padding:10px 12px;background:#f8f8f8;border-bottom:2px solid #ddd;font-size:13px;color:#666}td{padding:8px 12px;border-bottom:1px solid #eee;font-size:13px}a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}.dir{font-weight:bold}.size{color:#999}</style>`;
    html += `</head><body><h1>Directory: ${escapeHtml(displayPath)}</h1><table><tr><th>Name</th><th>Size</th><th>Modified</th></tr>`;

    // 父目录链接：使用绝对路径返回上一级（根目录时不显示）
    if (requestPath && requestPath !== '/') {
      const parentHref = prefix + '..';
      html += `<tr><td><a href="${escapeHtml(parentHref)}" class="dir">../</a></td><td class="size">-</td><td>-</td></tr>`;
    }

    for (const item of items) {
      // 使用绝对路径 href，避免 URL 缺少尾部斜杠时解析错误
      const href = prefix + item.name;
      const name = item.isDirectory ? item.name + '/' : item.name;
      const size = item.isDirectory ? '-' : fmtSize(item.size);
      const cls = item.isDirectory ? 'dir' : '';
      html += `<tr><td><a href="${escapeHtml(href)}" class="${cls}">${escapeHtml(name)}</a></td><td class="size">${size}</td><td class="size">${item.modified}</td></tr>`;
    }

    html += `</table></body></html>`;
    return html;
  }

  /**
   * 处理 WebSocket 升级请求
   */
  _handleUpgrade(req, socket, head) {
    // 防御性检查：_wss 在 listen() 中初始化，正常流程不会为 null
    if (!this._wss) {
      this._logger.warn('WebSocket server not initialized (call listen() first)');
      socket.destroy();
      return;
    }
    // 校验 Upgrade 头必须为 websocket
    if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
      this._logger.warn('Invalid upgrade header:', req.headers['upgrade'], 'expected: websocket');
      socket.destroy();
      return;
    }
    const ws = this._wss.handleUpgrade(req, socket, head);
    if (!ws) return;

    // 匹配 app.ws() 注册的处理器（支持动态参数路径）
    // _compilePath 始终返回 pattern，静态和动态路径均通过正则精确匹配
    if (this._wsHandlers) {
      const pathname = parseUrl(req.url).pathname;
      for (const entry of this._wsHandlers) {
        let matched = false;
        let params = {};
        const m = entry.pattern.exec(pathname);
        if (m) {
          matched = true;
          entry.params.forEach((name, i) => {
            try {
              params[name] = decodeURIComponent(m[i + 1]);
            } catch (e) {
              // 非法 URI 编码，保留原始值
              params[name] = m[i + 1];
            }
          });
        }
        if (matched) {
          // 将动态参数挂载到 req 上
          if (Object.keys(params).length > 0) {
            req.params = params;
          }
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
      if (typeof cleanup === 'function') {
        res._res.on('close', cleanup);
      }
    });
  }

  /**
   * WebSocket 简化注册：app.ws(path, handler)
   * handler 签名: (ws, req) => cleanupFn|void
   */
  ws(pathStr, handler) {
    if (!this._wsHandlers) this._wsHandlers = [];
    // 支持动态参数路径，复用 Router 的路径编译逻辑
    const { pattern, params } = this._compilePath(pathStr);
    this._wsHandlers.push({ path: pathStr, pattern, params, handler });
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
  maxBodySize: 128 * 1024 * 1024,
  svrPort: 80,
  svrIP: null,

  showDir: false,
  allowAccessToAllFiles: false,
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
  // 日志写入失败（磁盘满/权限等）时是否退出进程：false=仅控制台打印（默认），true=退出进程
  // 注：配置项名取最常见场景（磁盘满 disk full），实际任何写入错误都会触发退出
  exitOnDiskFull: false,

  cors: { origin: '*', headers: 'Content-Type, Authorization', maxAge: 86400 },

  useBodyParser: true,
  useCookieParser: true,
  bodyParserOptions: {},
  cookieParserSecret: null,

  wsHeartbeatInterval: 30000,
  wsHeartbeatTimeout: 30000,
  wsMaxPayload: 100 * 1024 * 1024,
  wsAllowedOrigins: null
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
function staticMiddleware(rootPath, options = {}) {
  return function staticHandler(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    const root = path.resolve(rootPath || process.cwd());
    const allowAll = options.allowAccessToAllFiles || false;
    let requestPath = req.path.replace(/^\/+/, '');
    if (!isPathSafe(requestPath, root, allowAll)) {
      return next();
    }
    const fullPath = path.join(root, requestPath);
    fs.stat(fullPath, (err, stat) => {
      if (err) {
        return next();
      }
      if (stat.isDirectory()) {
        // 目录：尝试 index.html（异步检查避免阻塞事件循环）
        const indexPath = path.join(fullPath, 'index.html');
        fs.stat(indexPath, (idxErr) => {
          if (!idxErr) {
            res.sendFile(path.relative(root, indexPath), { root });
            return;
          }
          return next();
        });
        return;
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
httpm.WebSocketHandShak = WebSocketHandShak;
httpm.escapeHtml = escapeHtml;
httpm.version = '1.3.1';

/**
 * parseQuery：独立导出的 Query 解析函数（复用内部 _parseQueryString）
 */
function parseQuery(qs) {
  return _parseQueryString(qs);
}
httpm.parseQuery = parseQuery;

module.exports = httpm;
