/**
 * httpm - 基于 Node.js 原生模块的单文件、零依赖 HTTP 服务库
 *
 * @name        httpm
 * @version     1.5.9
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
 *   - WebSocket：路径分组、心跳保活、广播、文本/二进制子事件、动态参数路由
 *   - SSE：服务端推送事件，支持 event/data/retry/comment
 *   - 流式文件上传：multipart/form-data 解析，内存零占用
 *   - 日志系统：彩色控制台输出 + 文件持久化，按级别过滤
 *   - CORS：内置跨域支持，预检缓存、凭证、自定义头
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
const util = require('util');
const { StringDecoder } = require('string_decoder');

// ============================================================
// 工具函数层
// ============================================================



/**
 * 解析 URL，拆分路径与 Query 参数
 * 非字符串输入返回空 pathname + 空 query，避免抛异常（导出函数需防御）
 */
function parseUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return { pathname: '', query: {} };
  const hashIdx = urlStr.indexOf('#');
  if (hashIdx !== -1) {
    urlStr = urlStr.substring(0, hashIdx);
  }
  const qIdx = urlStr.indexOf('?');
  if (qIdx === -1) {
    return { pathname: urlStr, query: {} };
  }
  return { pathname: urlStr.substring(0, qIdx), query: parseQuery(urlStr.substring(qIdx + 1)) };
}

/**
 * 解析查询字符串为键值对象
 */
function parseQuery(qs, plusAsSpace = false) {
  const query = {};
  if (!qs) return query;
  qs.split('&').forEach(pair => {
    const eIdx = pair.indexOf('=');
    if (eIdx === -1) {
      // 无等号：整个 pair 作为 key，值为空字符串
      const key = plusAsSpace ? pair.replace(/\+/g, ' ') : pair;
      // 跳过空 key（如 "?&foo=bar" 中的空段），避免污染 query 对象
      if (!key) return;
      // 防御原型污染：与有等号分支保持一致，拒绝 __proto__/constructor/prototype 等危险键
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      try {
        query[decodeURIComponent(key)] = '';
      } catch (e) {
        // 非法 URI 编码，保留原始值
        query[key] = '';
      }
    } else {
      const key = pair.substring(0, eIdx);
      const val = pair.substring(eIdx + 1);
      // 跳过空 key（如 "=value" 形式），避免污染 query 对象
      if (!key) return;
      const decodedKey = plusAsSpace ? key.replace(/\+/g, ' ') : key;
      const decodedVal = plusAsSpace ? val.replace(/\+/g, ' ') : val;
      // 防御原型污染：拒绝 __proto__/constructor/prototype 等危险键（攻击者可借此覆盖对象原型）
      if (decodedKey === '__proto__' || decodedKey === 'constructor' || decodedKey === 'prototype') return;
      try {
        query[decodeURIComponent(decodedKey)] = decodeURIComponent(decodedVal);
      } catch (e) {
        // 非法 URI 编码，保留原始值
        query[decodedKey] = decodedVal;
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
    // 过滤空键（如 "=value" 形式），避免污染 cookies 对象
    if (!key) return;
    const rawVal = pair.substring(eIdx + 1).trim();
    // Cookie 值可能含 URL 编码（如 name=%E4%B8%AD%E6%96%87），尝试解码
    // 解码失败（非法编码）保留原始值，避免抛异常
    let val;
    try {
      val = decodeURIComponent(rawVal);
    } catch (e) {
      val = rawVal;
    }
    // 防御原型污染：拒绝 __proto__/constructor/prototype 等危险键
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    cookies[key] = val;
  });
  return cookies;
}

/**
 * HTML 实体转义，防止 XSS
 */
function escapeHtml(str) {
  // 非字符串入参先做 String 转换，避免 null/undefined 触发 TypeError
  str = str == null ? '' : String(str);
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
 * 字节单位格式化（B/KB/MB/GB/TB/PB）
 */
function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes === 0) return '0B';
  // 补充 PB 单位，避免 PB 级字节越界返回 undefined
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // 限制 i 上限，超过 units 范围时沿用最大单位（PB）
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** i);
  // 小于 10 时保留 2 位小数，否则保留 1 位，整数不显示小数
  const formatted = value < 10 ? value.toFixed(2) : (value === Math.floor(value) ? value.toString() : value.toFixed(1));
  return formatted + units[i];
}

/**
 * 毫秒时间格式化（ms/s/m/h）
 */
function fmtTime(ms) {
  // 防御非数字/负数，避免 toFixed 抛 TypeError 或返回 NaN
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return ms.toFixed(0) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(2) + 's';
  if (ms < 3600000) return (ms / 60000).toFixed(2) + 'm';
  return (ms / 3600000).toFixed(2) + 'h';
}

/**
 * 路径安全校验，防遍历攻击
 */
function isPathSafe(requestPath, rootDir, allowAllFiles = false) {
  // 防御非字符串入参：null/undefined/数字等会导致 replace/path.resolve 抛异常
  if (typeof requestPath !== 'string' || typeof rootDir !== 'string') return false;
  // 拒绝 null byte：部分 fs API（如旧版 Node）会截断含 \0 的路径，可能导致路径注入
  // 明确拒绝比依赖底层 fs 行为更安全
  if (requestPath.indexOf('\0') !== -1) return false;
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
  // 防御非 stat 对象：null/undefined 或缺少 size/mtimeMs 属性会导致 toString 抛异常
  if (!stat || typeof stat.size !== 'number' || typeof stat.mtimeMs !== 'number') {
    return '"' + uid() + '"'; // 返回随机值，强制缓存失效
  }
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
    // 防止多次 process.exit：error 事件可能连续触发，重复 exit 无意义且可能产生竞态
    this._exiting = false;
    // 背压告警标志：stream.write 返回 false 时表示内部缓冲已满，仅告警一次避免日志风暴
    this._backpressureWarned = false;
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
    if (this.exitOnDiskFull && !this._exiting) {
      this._exiting = true;
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
        // destroy 通常不抛异常，但流已损坏/fd 已释放时可能抛
        // 跨日切换是日志核心路径，异常会导致后续日志全部丢失，用 try/catch 保护
        try { oldStream.destroy(); } catch (e) { /* 忽略销毁错误 */ }
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
    // 重置 _stream 和 _streamDate：流已损坏，下次写入会重建新流，避免持续往坏流写入丢失日志
    this._stream.on('error', (err) => {
      this._stream = null;
      this._streamDate = null;
      this._handleWriteError(err);
    });
    this._streamDate = streamKey;
    return this._stream;
  }

  _writeFile(level, msg) {
    try {
      const stream = this._getLogStream();
      // stream.write 返回 false 表示内部缓冲已满（背压），高并发日志场景下可能丢失日志
      // 仅告警一次避免日志风暴，监听 drain 事件后重置标志
      const ok = stream.write(msg + '\n');
      if (!ok && !this._backpressureWarned) {
        this._backpressureWarned = true;
        console.warn('[Logger] Write backpressure detected, logs may be delayed or lost');
        stream.once('drain', () => { this._backpressureWarned = false; });
      }
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
    // Error 对象特殊处理：输出 message + stack，比 util.inspect 更清晰
    // 普通对象用 util.inspect 格式化，避免输出 [object Object]
    const formatted = args.map(a => {
      if (a instanceof Error) {
        return a.stack || (a.name + ': ' + a.message);
      }
      if (typeof a === 'object' && a !== null) {
        return util.inspect(a);
      }
      return a;
    });
    const msg = `[${timestamp}] [${levelTag}] ${formatted.join(' ')}`;

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
   * 注意：路径中可能含正则特殊字符（如 . ( [ + ? 等），必须先转义非参数部分，
   * 否则 new RegExp 会抛 SyntaxError，或 . 匹配任意字符导致路由匹配不精确
   */
  _compilePath(pathStr) {
    const params = [];
    // 收集参数名（基于原始路径，避免转义影响 :param 识别）
    pathStr.replace(/:([^/]+)/g, (_, name) => { params.push(name); return ''; });
    // 按 :param 占位符分段，对非参数段转义正则特殊字符，再拼接捕获组 ([^/]+)
    // 例：'/api.json' → '/api\.json'；'/users(test)' → '/users\(test\)'
    const patternStr = pathStr.split(/:[^/]+/).map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^/]+)');
    // 精确匹配正则（路由使用）
    const pattern = new RegExp('^' + patternStr + '$');
    // 前缀匹配正则（中间件使用）：路径之后可跟子路径
    //   /api/:version → ^/api/([^/]+)(?=/|$)，匹配 /api/v1、/api/v1/users，不匹配 /apixyz
    //   /             → ^/，匹配所有以 / 开头的路径（根路径中间件等价应用级，修复 use('/') 不命中子路径）
    const prefixPattern = pathStr === '/'
      ? /^\//
      : new RegExp('^' + patternStr + '(?=/|$)');
    return { pattern, params, prefixPattern };
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
    } else {
      // 未知 HTTP 方法静默忽略但打印警告，便于调用方排查路由未命中问题
      // 支持 GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS/ALL，其他方法（如 CONNECT/TRACE）不支持
      console.warn(`[httpm] Unsupported HTTP method "${key}", route "${pathStr}" ignored. Supported: GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS/ALL`);
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
      const { pattern, params, prefixPattern } = this._compilePath(pathStr);
      this.middlewareStack.push({ path: pathStr, pattern, params, prefixPattern, handlers });
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

    // 对应方法路由优先（GET/HEAD 等）
    let methodRoutes = [];
    for (const meth of methods) {
      const routes = this.routes[meth] || [];
      methodRoutes = methodRoutes.concat(routes);
    }
    // ALL 通用路由优先级恒最低：追加到特定方法路由之后
    // （README 声明：精准静态路由 > 动态参数路由 > ALL 通用路由 > 静态文件服务）
    const allRoutes = this.routes['ALL'] || [];
    methodRoutes = methodRoutes.concat(allRoutes);

    for (const route of methodRoutes) {
      const match = route.pattern.exec(pathname);
      if (match) {
        results.push({ route, params: this._extractParams(route.params, match), handlers: route.handlers });
      }
    }
    return results;
  }

  /**
   * 提取路由参数：decodeURIComponent 解码 + 非法编码降级保留原始值
   * Router.match / matchMiddleware / _handleUpgrade 三处复用
   * @param {string[]} paramNames - 参数名数组
   * @param {RegExpExecArray} match - 正则匹配结果（match[i+1] 为第 i 个参数值）
   * @returns {Object} 参数键值对象
   */
  _extractParams(paramNames, match) {
    const params = {};
    paramNames.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(match[i + 1]);
      } catch (e) {
        // 非法 URI 编码，保留原始值
        params[name] = match[i + 1];
      }
    });
    return params;
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
        continue;
      }
      // 路径级中间件：用前缀正则匹配，正确处理 use('/') 和动态参数路径
      // prefixPattern 通过 (?=/|$) 边界约束：
      //   - use('/') 命中所有以 / 开头的路径
      //   - use('/api/:version') 命中 /api/v1 及其子路径，并提取 version 参数
      const match = mw.prefixPattern.exec(pathname);
      if (match) {
        results.push({ middleware: mw, params: this._extractParams(mw.params, match) });
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
    // 仅在 trustProxy=true 时信任 X-Forwarded-For（默认 false，防止客户端伪造 IP）
    // 反向代理场景需手动开启：httpm({ trustProxy: true })
    if (this._app?.settings?.trustProxy) {
      const fwd = this._req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',')[0].trim();
    }
    // HTTP/2 模式下 IncomingMessage.socket 不存在，需通过 stream.session.socket 获取
    return this._req.socket?.remoteAddress || this._req.stream?.session?.socket?.remoteAddress || '';
  }
  get hostname() {
    // 解析 Host 头，正确处理 IPv6 地址（如 [::1]:8080、[::1]）
    // 原实现 host.split(':')[0] 对 IPv6 会返回 '[' 或 '2001' 等错误值
    // 对齐 Express 行为：剥离端口后，IPv6 方括号也一并剥离（[::1] → ::1）
    const parseHost = (h) => {
      if (!h) return '';
      let host = h;
      try {
        // 补全协议构造 URL，u.hostname 会自动剥离端口
        // [::1]:8080 → [::1]，example.com:8080 → example.com
        host = new URL('http://' + h).hostname;
      } catch (e) {
        // 极端非法 Host 头回退到 split(':')，保证不抛异常
        host = h.split(':')[0];
      }
      // 剥离 IPv6 方括号，对齐 Express（Express 4.x hostname getter 会 strip brackets）
      if (host[0] === '[' && host[host.length - 1] === ']') {
        host = host.substring(1, host.length - 1);
      }
      return host;
    };
    // trustProxy=true 时优先取 X-Forwarded-Host（反向代理后的真实主机名）
    if (this._app?.settings?.trustProxy) {
      const fwh = this._req.headers['x-forwarded-host'];
      if (fwh) return parseHost(fwh);
    }
    return parseHost(this._req.headers['host']);
  }
  get protocol() {
    // HTTP/2 模式下 IncomingMessage.socket 不存在，需通过 stream.session.socket 获取底层 socket
    // 与 req.ip 保持一致的 HTTP/2 兼容回退（第七轮 P2-1 修复 req.ip 时遗漏了 protocol）
    const sock = this._req.socket || this._req.stream?.session?.socket;
    return (sock?.encrypted || this._req.connection?.encrypted) ? 'https' : 'http';
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
      // 命名监听器：超时/超限/错误路径显式移除，避免 destroy 后残留监听器（轻微资源残留）
      const cleanupListeners = () => {
        this._req.removeListener('data', onData);
        this._req.removeListener('end', onEnd);
        this._req.removeListener('error', onError);
      };
      // 超时定时器
      const timer = setTimeout(() => {
        timedOut = true;
        cleanupListeners();
        this._req.destroy();
        reject(new Error('Request body read timeout', { cause: { timeoutMs } }));
      }, timeoutMs);
      const onData = (chunk) => {
        totalSize += chunk.length;
        // 流式大小检查，超限时立即中断
        if (totalSize > limit) {
          clearTimeout(timer);
          cleanupListeners();
          this._req.destroy();
          const err = new Error(`Request body exceeds maximum size of ${fmtSize(limit)}`, { cause: { actual: totalSize, maxSize: limit } });
          err.status = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        clearTimeout(timer);
        // 正常完成后移除监听器，与超时/超限/错误路径保持一致
        cleanupListeners();
        this._rawBody = Buffer.concat(chunks);
        this._bodyParsed = true;
        resolve(this._rawBody);
      };
      const onError = (err) => {
        clearTimeout(timer);
        cleanupListeners();
        if (!timedOut) reject(err);
      };
      this._req.on('data', onData);
      this._req.on('end', onEnd);
      this._req.on('error', onError);
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
  // 使用 writableEnded 替代废弃的 finished 属性（Node.js 16+ 推荐）
  // destroyed 覆盖 socket 异常关闭场景（writableEnded 可能为 false 但连接已断开）
  get finished() { return this._res.writableEnded || this._res.destroyed; }
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
    // 防御 null/undefined field，避免 getHeader(field) 抛 TypeError
    if (!field) return this;
    // 防御 null/undefined value，避免写入无效头值
    if (value === null || value === undefined) return this;
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
    // 防御 null/undefined，避免 contentType.includes('/') 抛 TypeError
    if (!contentType) return this;
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
    // 校验状态码为 100-599 范围内的整数，避免无效状态码（如 99/600/小数/非数字）
    // 导致客户端解析失败或 HTTP 协议违规
    // 无效时保持默认 200，并记录 warn 日志提示调用方
    if (Number.isInteger(code) && code >= 100 && code <= 599) {
      this.statusCode = code;
    } else {
      this._app?._logger?.warn(`[Response] invalid status code: ${code}, expected integer 100-599, fallback to 200`);
    }
    return this;
  }

  /**
   * 输出 JSON 格式响应
   * 序列化失败（如循环引用）时返回 500，避免异常冒泡暴露内部细节
   */
  json(data) {
    let body;
    try {
      body = JSON.stringify(data);
    } catch (e) {
      // 序列化失败（如循环引用、BigInt 等）：记录日志并返回 500 友好响应
      // 注意：不能递归调用 this.json，否则再次抛异常；直接用 _send 输出固定错误体
      // 传 Error 对象给 Logger，会输出 message + stack，便于定位序列化失败原因
      try { this._app?._logger?.error('JSON.stringify failed:', e); } catch (logErr) { /* 忽略日志失败 */ }
      this.status(500);
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
      const errBody = '{"error":"Response serialization failed","status":500}';
      this.setHeader('Content-Length', Buffer.byteLength(errBody));
      this._send(errBody);
      return;
    }
    // JSON.stringify 对 undefined/function/Symbol 返回 undefined（既不抛异常也不是字符串）
    // 随后 Buffer.byteLength(undefined) 会抛 TypeError，导致请求无法正常结束、连接挂起
    // 与 Express 行为对齐：对 undefined 发送 'undefined' 字符串
    if (body === undefined) body = 'undefined';
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
      // Express 4.x 兼容：null 在 case 'object' 分支被转为空字符串，发送空响应
      // 不发 'null' 字符串（与 JSON.stringify(null) 行为不同）
      this.setHeader('Content-Type', 'text/html; charset=utf-8');
      this.setHeader('Content-Length', 0);
      this._send('');
      return;
    }
    if (Buffer.isBuffer(data)) {
      // 仅在用户未设置 Content-Type 时补充默认值，与字符串分支行为一致
      // 用户通过 res.type('image/png') 设置的 Content-Type 不应被 send(Buffer) 覆盖
      // 对齐 Express 4.x 行为
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/octet-stream');
      }
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
    // writableEnded 表示 end() 已调用，替代废弃的 finished 属性（Node.js 16+ 推荐）
    if (this._res.writableEnded) return;
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
    // 路径遍历防护：解析后的绝对路径必须在 root 之下，防止 ../ 逃逸
    const resolvedRoot = path.resolve(root);
    if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) {
      this.status(403).send('Forbidden');
      doneOnce(new Error('Path traversal blocked'));
      return;
    }

    fs.stat(fullPath, (err, stat) => {
      if (err) {
        // 区分 ENOENT(404 文件不存在) 和 EACCES(403 权限不足)，HTTP 语义更准确
        // EACCES 表示文件存在但无访问权限，ENOENT 表示路径不存在
        // 其他错误（如 ENOTDIR、EMFILE）统一回退 404，保持兼容性
        if (err.code === 'EACCES') {
          this.status(403).send('Forbidden');
        } else {
          this.status(404).send('Not Found');
        }
        doneOnce(err);
        return;
      }
      if (!stat.isFile()) {
        this.status(404).send('Not Found');
        doneOnce(new Error('Not a file'));
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
        // RFC 7232 Section 3.2: If-None-Match 支持 * （匹配任意 ETag）和逗号分隔的多 ETag
        // 客户端可能发送 If-None-Match: "etag1", "etag2" 或 If-None-Match: *
        let etagMatch = false;
        if (ifNoneMatch) {
          if (ifNoneMatch.trim() === '*') {
            etagMatch = true;
          } else {
            // 按逗号拆分，逐个比较（ETag 值已含引号，直接字符串比较）
            const etags = ifNoneMatch.split(',').map(s => s.trim());
            etagMatch = etags.includes(etag);
          }
        }
        if (etagMatch || (ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime)) {
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
        // parseRange 返回 null 有两种情况，处理需符合 RFC 7233：
        // 1. 格式错误（如 bytes=abc、bytes=-）：服务器应忽略 Range 头，返回 200 全文
        // 2. 格式合法但范围不满足（如 bytes=1000- 但文件只有 500 字节）：返回 416 Range Not Satisfiable
        // 通过重新校验格式区分两种情况，避免对格式错误的请求误返回 416
        const formatValid = /^bytes=\d+-\d*$|^bytes=\d*-\d+$/.test(rangeHeader);
        if (formatValid) {
          // 格式合法但范围不满足：返回 416，并附带 Content-Range: bytes */size 告知实际大小
          this.status(416);
          this.setHeader('Content-Range', `bytes */${stat.size}`);
          this.setHeader('Content-Length', 0);
          this._send('');
          doneOnce(null);
          return;
        }
        // 格式错误：忽略 Range 头，继续走 200 全文流程（不 return）
      }

      this.setHeader('Content-Length', stat.size);

      // 空文件特判：stat.size === 0 时 end = -1 会导致 createReadStream 抛 RangeError
      // 直接 end 响应，不创建读取流（HEAD 和 GET 行为一致，仅 end 头部）
      if (stat.size === 0) {
        this._res.statusCode = this.statusCode;
        this._headersSent = true;
        this._res.end();
        doneOnce(null);
        return;
      }

      // Gzip 压缩（仅文本类文件）
      // HEAD 请求不进入 Gzip 分支：HEAD 不传输实体无需压缩；且流式 Gzip 无法预知压缩后大小，
      // 若 HEAD 进入此分支会因未移除 Content-Length 导致响应头与 GET 实际返回的压缩内容大小不一致。
      // HEAD 走下方 _streamFile 快速路径（内部 HEAD 检查直接 end 不传输），
      // 返回 Content-Length: stat.size（未压缩大小）且无 Content-Encoding 头，符合业界主流服务器行为
      const acceptEncoding = this._req?.headers?.['accept-encoding'] || '';
      if (this._app.settings.enableGzip && isTextMime(mime) && acceptEncoding.includes('gzip') && !this._isHead) {
        this.removeHeader('Content-Length');
        this.setHeader('Content-Encoding', 'gzip');
        // 直接写入底层响应对象的状态码（this.status() 是链式 getter/setter，赋值给自己是 no-op）
        this._res.statusCode = this.statusCode;
        this._headersSent = true;
        const raw = fs.createReadStream(fullPath);
        const gzip = zlib.createGzip();
        // 流错误处理：文件读取或压缩出错时返回 500
        const onError = (streamErr) => {
          raw.destroy();
          gzip.destroy();
          if (!this._res.writableEnded) {
            this._res.statusCode = 500;
            this._res.end('Internal Server Error');
          }
          doneOnce(streamErr);
        };
        raw.on('error', onError);
        gzip.on('error', onError);
        // 目标（响应）异常或客户端断开时销毁源流和压缩流，防止文件描述符泄漏
        const onDestError = () => { raw.destroy(); gzip.destroy(); };
        this._res.on('error', onDestError);
        this._res.on('close', onDestError);
        // 流完成时回调并移除监听器，避免 finish 后 close 事件重复触发 onDestError（幂等但不优雅）
        this._res.on('finish', () => {
          this._res.removeListener('error', onDestError);
          this._res.removeListener('close', onDestError);
          doneOnce(null);
        });
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
    if (this._res.writableEnded) {
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
      if (!this._res.writableEnded) {
        this._res.statusCode = 500;
        this._res.end('Internal Server Error');
      }
      done(err);
    });
    // 目标（响应）异常或客户端断开时销毁源流，防止文件描述符泄漏
    // pipe 不会自动销毁源流，高并发下客户端频繁断开会耗尽 fd
    const onDestError = () => { stream.destroy(); };
    this._res.on('error', onDestError);
    this._res.on('close', onDestError);
    // 流完成时移除监听器并回调，避免 close 事件重复触发 onDestError（与 Gzip 流处理一致）
    // 不移除时 finish 后 close 仍会触发 onDestError 执行不必要的 destroy，且 res 上监听器累积
    this._res.on('finish', () => {
      this._res.removeListener('error', onDestError);
      this._res.removeListener('close', onDestError);
      done(null);
    });
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
   * url='back' 时取 Referrer 头回退到上一页，无 Referrer 时回退到 '/'
   */
  redirect(...args) {
    let url;
    if (typeof args[0] === 'number') {
      // redirect(status, url)
      // 严格白名单校验：仅 301/302/303/307/308 是真正的重定向状态码
      // 300(Multiple Choices)/304(Not Modified)/305(已废弃)/306(未使用) 不是重定向语义
      // 非白名单值回退 302，避免误用导致客户端行为异常
      const code = args[0];
      const VALID_REDIRECT_CODES = [301, 302, 303, 307, 308];
      this.status(VALID_REDIRECT_CODES.includes(code) ? code : 302);
      url = args[1];
    } else {
      // redirect(url) 默认 302
      this.status(302);
      url = args[0];
    }
    // Express 兼容：'back' 特殊值回退到 Referer
    if (url === 'back') {
      url = this._req?.headers?.['referer'] || this._req?.headers?.['referrer'] || '/';
    }
    // 防御：url 缺失（null/undefined）时回退到根路径，避免 encodeURI(undefined) = 'undefined'
    // 场景：res.redirect() 无参数、res.redirect(302) 缺少 url
    if (url == null) url = '/';
    // HTTP 协议要求 Location 头为 ASCII，非 ASCII 字符需编码（含中文、空格等）
    // encodeURI 保留 : / ? # [ ] @ ! $ & ' ( ) * + , ; = 等合法 URL 字符
    try {
      url = encodeURI(url);
    } catch (e) {
      // 已编码的 URL 再 encodeURI 可能抛 URIError，忽略保持原值
    }
    // 防御头注入：Location 头不允许 CR/LF（Node setHeader 遇换行会抛 TypeError）
    if (/[\r\n\v\b\t]/.test(url)) url = url.replace(/[\r\n\v\b\t]/g, '');
    this.setHeader('Location', url);
    this.setHeader('Content-Length', 0);
    this._send('');
  }

  /**
   * 创建 SSE 推送实例
   */
  sse() {
    if (this._sse) return this._sse;
    // 同步 httpm Response 的 statusCode 到底层 ServerResponse
    // 仅 _send/_sendFile 等输出方法会同步 statusCode，SSE 直接 writeHead 不会经过 _send
    // 不同步会导致用户通过 res.status(201) 设置的状态码被 SSE 构造函数忽略（始终 200）
    this._res.statusCode = this.statusCode || 200;
    // 传入底层 IncomingMessage（this._req._req）以便 SSE 监听 'aborted' 事件
    // ServerResponse 无 aborted 事件，必须监听 IncomingMessage
    const incomingMsg = this._req?._req;
    this._sse = new SSE(this._res, incomingMsg);
    return this._sse;
  }

  /**
   * 设置响应 Cookie
   */
  cookie(name, value, opts = {}) {
    // 防御：value 为 undefined/null 时回退到空字符串
    // 避免encodeURIComponent(undefined) = 'undefined'，设置 cookie 值为字符串 "undefined"
    if (value == null) value = '';
    // Express 兼容：对象值先 JSON 序列化，便于存储结构化数据
    // 循环引用等异常场景 JSON.stringify 抛 TypeError，回退到空字符串避免冒泡到调用方
    let rawValue;
    if (typeof value === 'object' && value !== null) {
      try { rawValue = JSON.stringify(value); } catch (e) { rawValue = ''; }
    } else {
      rawValue = value;
    }
    // String() 统一转换，避免 Symbol 等类型导致 encodeURIComponent 抛 TypeError
    let encodedValue = encodeURIComponent(String(rawValue));
    // 签名 Cookie：s:value.signature（s: 前缀不参与编码，签名基于原始值）
    if (opts.signed) {
      const secret = this._app && this._app.settings && this._app.settings.cookieParserSecret;
      if (secret) {
        // crypto.createHmac().update() 要求 string/Buffer/TypedArray 入参
        // value 为 number/boolean/bigint 时 rawValue 是非字符串，update 会抛 TypeError
        // 用 String() 转换确保安全传入 HMAC，且不改变签名语义（签名基于值的字符串表示）
        const sig = crypto.createHmac('sha256', secret).update(String(rawValue)).digest('base64').replace(/=+$/, '');
        encodedValue = 's:' + encodedValue + '.' + sig;
      } else {
        // signed:true 但无 secret 配置时静默不签名，调用方可能误以为 cookie 已签名
        // 安全敏感场景（如会话管理）下静默降级可能导致签名校验失效，记录 warn 日志提示
        this._app?._logger?.warn('[Cookie] signed cookie requested but no secret configured (cookieParserSecret not set)');
      }
    }
    let str = `${encodeURIComponent(name)}=${encodedValue}`;
    if (opts.maxAge !== undefined) str += `; Max-Age=${opts.maxAge}`;
    // Express 兼容：支持 expires 选项（Date 对象/数字时间戳/字符串）
    // 统一归一化为 Date.toUTCString()，无效日期不输出头（避免 Set-Cookie 解析失败）
    if (opts.expires) {
      const date = opts.expires instanceof Date ? opts.expires : new Date(opts.expires);
      if (!isNaN(date.getTime())) str += `; Expires=${date.toUTCString()}`;
    }
    // 防御 cookie 头注入：path/domain 含 ; , 空格会破坏 Set-Cookie 结构
    // 攻击者可通过 path="/foo;Domain=evil.com" 污染其他域名的 Cookie
    if (opts.domain && !/[;,\s]/.test(opts.domain)) str += `; Domain=${opts.domain}`;
    else if (opts.domain) this._app?._logger?.warn('[Cookie] domain contains invalid characters (;, ,\\s)');
    if (opts.path && !/[;,\s]/.test(opts.path)) str += `; Path=${opts.path}`;
    else if (opts.path) this._app?._logger?.warn('[Cookie] path contains invalid characters (;, ,\\s)');
    if (opts.secure) str += '; Secure';
    if (opts.httpOnly) str += '; HttpOnly';
    if (opts.sameSite) {
      // RFC 6265bis 规定 SameSite 值为 Strict/Lax/None 大小写敏感
      // 归一化为小写并仅接受白名单值，避免 'lax'/'NONE' 等非标准值被发送
      // Express 兼容：sameSite: true 等同于 'strict'（布尔值 true 是常见简写）
      const normalized = opts.sameSite === true ? 'strict' : String(opts.sameSite).toLowerCase();
      if (['strict', 'lax', 'none'].includes(normalized)) {
        // SameSite=None 必须配合 Secure，否则浏览器会拒绝该 Cookie（Chrome 80+ 强制）
        // 此处仅记录警告日志，不强制阻断，保持调用方灵活性
        if (normalized === 'none' && !opts.secure) {
          this._app?._logger?.warn('[Cookie] SameSite=None without Secure may be rejected by browser');
        }
        // 归一化为首字母大写（Strict/Lax/None），符合 RFC 规范
        str += `; SameSite=${normalized.charAt(0).toUpperCase() + normalized.slice(1)}`;
      }
    }
    const existing = this.getHeader('Set-Cookie');
    const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
    cookies.push(str);
    this.setHeader('Set-Cookie', cookies);
    return this;
  }

  /**
   * 清除 Cookie
   * 同时设置 maxAge=0 和 expires=epoch（1970-01-01），兼容不支持 Max-Age 的旧浏览器
   */
  clearCookie(name, opts = {}) {
    this.cookie(name, '', { ...opts, maxAge: 0, expires: new Date(0) });
    return this;
  }
}

// ============================================================
// SSE 类
// ============================================================

class SSE {
  constructor(res, req) {
    this._res = res;
    this._req = req; // 保存 req 以便移除 aborted 监听器
    this.connected = true;

    // 设置 SSE 标准响应头（仅在 headers 未发送时）
    // 沿用 res 当前状态码（默认 200），避免覆盖用户主动设置的状态码
    // CORS 头由 _applyCORSHeaders 在 _handleRequest 中统一设置，此处不硬编码 ACAO
    // 避免覆盖用户的 cors.origin 配置（如 credentials=true 场景）
    // 校验状态码：SSE 必须是 2xx 成功响应，204(No Content)/304(Not Modified) 等无实体状态码
    // 会导致 writeHead 后 write 抛 ERR_STREAM_WRITE_AFTER_END 或客户端不读取实体
    if (!res.headersSent) {
      const code = (res.statusCode >= 200 && res.statusCode <= 299) ? res.statusCode : 200;
      res.writeHead(code, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
    }

    // 监听连接关闭（兼容 HTTP/1.1 和 HTTP/2）
    const onClose = () => {
      this.connected = false;
    };
    this._onClose = onClose;
    res.on('close', onClose);
    // HTTP/1.1 兼容：客户端中断请求时触发（ServerResponse 无 aborted 事件，必须监听 req）
    // 注意：req 可能是 httpm Request 对象（无 on 方法）或底层 IncomingMessage，需校验
    if (req && typeof req.on === 'function') req.on('aborted', onClose);
  }

  /**
   * 统一写入 SSE 数据，处理底层响应流异常
   * this._res.write 在响应已结束、客户端断开或底层 socket 错误时可能抛异常，
   * 用 try/catch 包裹，失败时调用 close() 清理连接资源，避免未捕获异常
   * @param {string} payload - 已格式化的 SSE 协议文本
   * @returns {boolean} true=写入成功，false=写入失败（连接已关闭）
   */
  _write(payload) {
    if (!this.connected) return false;
    try {
      this._res.write(payload);
      return true;
    } catch (e) {
      // 写入失败（客户端断开/响应已结束），关闭连接清理资源
      this.close();
      return false;
    }
  }

  /**
   * 序列化 SSE 消息体（send/event 共用）：
   * - null/undefined → 'null'（避免 JSON.stringify 返回 undefined 导致 split 抛 TypeError）
   * - 字符串 → 原样
   * - 其他 → JSON.stringify，循环引用/BigInt 失败时返回 null 表示跳过本次发送
   * @returns {string|null} 序列化结果；null 表示序列化失败应跳过
   */
  _serializeData(data) {
    if (data == null) return 'null';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data);
    } catch (e) {
      // 循环引用/BigInt 序列化失败：跳过本次发送，避免污染事件流
      return null;
    }
  }

  /**
   * 发送普通消息，自动兼容字符串/JSON 对象
   * SSE 规范：data 中含换行符时需拆成多行 data: 前缀，接收端用 \n 拼回
   */
  send(data) {
    if (!this.connected) return this;
    const msg = this._serializeData(data);
    if (msg === null) return this;
    // 按行拆分，每行加 data: 前缀，确保多行消息不破坏 SSE 协议
    const lines = msg.split('\n');
    this._write(lines.map(l => `data: ${l}`).join('\n') + '\n\n');
    return this;
  }

  /**
   * 发送自定义命名事件
   * event name 中含换行符属于协议违规，直接忽略该事件避免破坏流
   */
  event(name, data) {
    if (!this.connected) return this;
    if (typeof name !== 'string' || name.includes('\n')) return this;
    const msg = this._serializeData(data);
    if (msg === null) return this;
    const lines = msg.split('\n');
    this._write(`event: ${name}\n` + lines.map(l => `data: ${l}`).join('\n') + '\n\n');
    return this;
  }

  /**
   * 设置客户端重连间隔（毫秒）
   * 非数字/负数/NaN 时忽略，避免写入非法值破坏 SSE 协议导致客户端解析失败
   */
  retry(ms) {
    if (!this.connected) return this;
    // 校验为非负有限数字，避免写入 NaN/undefined 破坏 SSE 协议
    if (!Number.isFinite(ms) || ms < 0) return this;
    this._write(`retry: ${ms}\n\n`);
    return this;
  }

  /**
   * 发送注释消息（可作为心跳保活）
   * 多行文本会按行拆分，每行均以 : 前缀标记为注释，避免破坏 SSE 协议
   */
  comment(text) {
    if (!this.connected) return this;
    // 按行拆分，每行加 : 前缀，确保多行注释不破坏 SSE 协议
    const lines = String(text == null ? '' : text).split('\n');
    const payload = lines.map(line => `: ${line}`).join('\n') + '\n\n';
    this._write(payload);
    return this;
  }

  /**
   * 主动关闭 SSE 连接，移除监听器防止内存泄漏
   * res 已 finished（如 res.send/res.end 已调用）时不再调用 end：
   *   1. 避免触发 ERR_STREAM_WRITE_AFTER_END 异步 'error' 事件（try/catch 无法捕获）
   *   2. 避免底层 socket 被强制关闭导致客户端收到 aborted 错误
   * try/catch 作为双重保护，兜底其他异常（如 socket 已销毁）
   */
  close() {
    if (!this.connected) return;
    this.connected = false;
    this._res.removeListener('close', this._onClose);
    // 移除 req 上的 aborted 监听器，避免内存泄漏（需校验 on/removeListener 方法存在）
    if (this._req && typeof this._req.removeListener === 'function') {
      this._req.removeListener('aborted', this._onClose);
    }
    // res 已 writableEnded 时跳过 end，避免触发异步 'error' 事件
    // 统一使用 writableEnded（Node.js 16+ 推荐），替代废弃的 finished 属性
    if (this._res.writableEnded) return;
    try { this._res.end(); } catch (e) { /* socket 已销毁等异常，忽略 */ }
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
    // 分片累积总大小（防止分片累积绕过单帧 maxPayload 检查）
    // 攻击者可发送大量小分片（每个 < maxPayload）累积成巨大消息，最后 concat 时耗尽内存
    this._fragmentTotalSize = 0;
    // 防止 close 事件重复触发
    this._closed = false;
    // 关闭握手状态
    this._closing = false;
    this._closeTimer = null;

    // 监听底层 Pong 帧
    socket.on('pong', () => {
      this._lastHeartbeat = Date.now();
    });

    // 监听对端关闭发送方向（FIN）：主动销毁 socket 加速清理
    // WebSocket 协议无半关闭语义，客户端 FIN 即视为断开连接，应立即清理
    // 若仅监听 'close'，Windows 等 platform 上 socket 可能停留半开状态延迟触发 'close'，
    // 导致 server._connections 不归零、server.close() 挂起（连接泄漏）
    socket.on('end', () => {
      this.connected = false;
      try { socket.destroy(); } catch (e) { /* socket 已销毁则忽略 */ }
    });

    // 监听连接关闭
    // socket 异常断开（未走 WebSocket Close 帧握手）时，_emitClose 无参数
    // 按 RFC 6455 Section 7.4.1，异常关闭应使用 1006 状态码（仅用于 close 事件，不得在 Close 帧中发送）
    socket.on('close', () => {
      this.connected = false;
      this._emitClose(1006, '');
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
      this._processFrame(result.opcode, result.payload, result.fin, result.oversize, result.isMasked);
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

    // 最大负载限制检查（必须在掩码解析和数据完整性检查之前，防止慢速大帧攻击）
    // 慢速攻击场景：客户端声明 payloadLength=200MB（>maxPayload）但慢速发送，
    // 若等数据完整再拒绝，缓冲区会持续增长到声明大小才拒绝，maxPayload 防护失效。
    // 在掩码解析之前检查：payloadLength 已确定，无需等待掩码即可判断超限，提前短路减少计算。
    // bytesConsumed=buf.length：数据可能不完整无法精确消费整个帧；连接即将 close(1009)，
    // 消费整个缓冲区避免 _parseFrames 循环继续解析后续帧干扰关闭流程。
    if (payloadLength > this._maxPayload) {
      return { opcode: 0xFF, payload: Buffer.alloc(0), fin: true, bytesConsumed: buf.length, oversize: true };
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

    // 提取负载
    let payload = buf.subarray(offset, offset + payloadLength);
    if (isMasked && mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    return { opcode, payload, fin, isMasked, bytesConsumed: offset + payloadLength };
  }

  /**
   * 处理解码后的帧，支持分片帧（continuation frame, opcode=0x00）
   */
  _processFrame(opcode, payload, fin, oversize, isMasked) {
    // 已关闭连接：忽略后续帧，避免在 _closed 状态下处理数据触发异常
    // 场景：socket close 事件触发后，缓冲区仍可能有未消费的帧数据
    if (this._closed) return;
    // 超限帧：直接关闭连接
    if (oversize) {
      this.close(1009, 'Frame payload too large');
      return;
    }
    // RFC 6455 Section 5.1: 客户端到服务端的帧必须掩码，未掩码帧为协议错误
    // 注意：oversize 标记帧不携带 isMasked，跳过校验
    if (isMasked === false) {
      this.close(1002, 'Protocol error: client frames must be masked');
      return;
    }
    // RFC 6455 Section 5.5: 控制帧（close=0x08/ping=0x09/pong=0x0A）负载不得超过 125 字节，且不可分片（FIN 必须为 1）
    if (opcode >= 0x08 && opcode <= 0x0A) {
      if (payload.length > 125) {
        this.close(1002, 'Protocol error: control frame payload exceeds 125 bytes');
        return;
      }
      if (!fin) {
        this.close(1002, 'Protocol error: control frame must not be fragmented');
        return;
      }
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
        // RFC 6455 Section 7.4.1: 1004/1005/1006/1015 为"不得在 Close 帧中发送"的保留码
        // 对端违规发送这些码时，统一修正为 1005（无状态码语义），避免误导用户态
        if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || code === 1015) code = 1005;
        reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      }
      // 如果正在关闭握手中，对端已回复 Close 帧，完成握手
      if (this._closing) {
        clearTimeout(this._closeTimer);
        this._closeTimer = null;
        try { this.socket.end(); } catch (e) { /* 忽略 */ }
        // 优先使用本地主动 close() 时传入的 code/reason，保证用户态事件参数可预测
        // 场景：本地 ws.close(4000, 'custom')，对端回复 1000，用户期待收到 (4000, 'custom')
        // 若对端先于本地发起 Close（_localCloseCode 为 undefined），则用对端值
        this._emitClose(this._localCloseCode ?? code, this._localCloseReason ?? reason);
        return;
      }
      // 非关闭握手状态：回复 Close 帧后关闭 socket
      // RFC 6455 Section 7.4.1: 1005/1006/1015 状态码不得在 Close 帧中发送
      this._sendCloseFrame(code === 1005 || code === 1006 || code === 1015 ? undefined : code);
      this.connected = false;
      // 必须关闭底层 socket，否则 TCP 连接泄漏
      // end() 发送 FIN 包优雅关闭，比 destroy() 更符合 RFC 6455 关闭握手语义
      try { this.socket.end(); } catch (e) { /* 忽略关闭错误 */ }
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

    // RFC 6455 Section 5.2: opcode 0x03-0x07、0x0B-0x0F 为保留 opcode，未定义语义
    // 收到保留 opcode 必须以 1002 协议错误关闭连接，避免恶意客户端探测服务端行为
    // 此时已处理完所有合法控制帧（0x08/0x09/0x0A），剩余合法数据帧为 0x00/0x01/0x02
    if (opcode !== 0x00 && opcode !== 0x01 && opcode !== 0x02) {
      this.close(1002, 'Protocol error: reserved opcode');
      return;
    }

    // 数据帧：处理分片
    if (opcode === 0x00) {
      // 分片续帧：必须有前导帧
      // RFC 6455 Section 5.4: 收到续帧但无前导分片属于协议错误，应关闭连接(1002)
      if (!this._fragmented) {
        this.close(1002, 'Protocol error: continuation without fragment start');
        return;
      }
      // 累积分片总大小，超限时关闭连接（防止分片累积绕过单帧 maxPayload 检查）
      // 单个分片已通过 _decodeFrame 的 maxPayload 检查，但累积总量可能远超 maxPayload
      this._fragmentTotalSize += payload.length;
      if (this._fragmentTotalSize > this._maxPayload) {
        // 超限：清理分片状态（释放已累积的 payload 引用，避免内存泄漏），关闭连接
        // RFC 6455 Section 7.4.1: 1009 Message Too Big
        this._fragmented = false;
        this._fragmentOpcode = 0;
        this._fragmentPayloads = [];
        this._fragmentTotalSize = 0;
        this.close(1009, 'Fragmented message too large');
        return;
      }
      this._fragmentPayloads.push(payload);
      if (fin) {
        // 分片结束，合并并触发事件
        const fullPayload = Buffer.concat(this._fragmentPayloads);
        this._emitData(this._fragmentOpcode, fullPayload);
        this._fragmented = false;
        this._fragmentOpcode = 0;
        this._fragmentPayloads = [];
        this._fragmentTotalSize = 0;
      }
    } else {
      // 新消息帧（opcode=0x01/0x02）
      // RFC 6455 Section 5.4: 分片消息进行中收到新数据帧属于协议错误，必须关闭连接
      if (this._fragmented) {
        this.close(1002, 'Protocol error: new data frame during fragmented message');
        return;
      }
      if (fin) {
        // 非分片：直接触发（单帧已通过 _decodeFrame 的 maxPayload 检查，无需再校验）
        this._emitData(opcode, payload);
      } else {
        // 分片开始：初始化累积大小为首个分片大小
        this._fragmented = true;
        this._fragmentOpcode = opcode;
        this._fragmentPayloads = [payload];
        this._fragmentTotalSize = payload.length;
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
      // 普通对象 → JSON 文本帧
      // 循环引用等异常场景 JSON.stringify 抛 TypeError，触发 error 事件而非崩溃
      // 调用方传入 req/res 等含自引用的对象时，未捕获异常会导致进程崩溃
      let json;
      try { json = JSON.stringify(data); } catch (e) {
        this._emit('error', new Error('WebSocket send: object serialization failed', { cause: e }));
        return;
      }
      this._sendFrame(0x01, Buffer.from(json));
    } else if (typeof data === 'string') {
      this._sendFrame(0x01, Buffer.from(data));
    } else if (Buffer.isBuffer(data)) {
      this._sendFrame(0x02, data);
    } else if (data !== undefined && data !== null) {
      // number/boolean 等基础类型转字符串后按文本帧发送
      this._sendFrame(0x01, Buffer.from(String(data)));
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
   * @param {number} [code=1000] 关闭状态码（RFC 6455 Section 7.4），默认 1000 正常关闭
   * @param {string} [reason=''] 关闭原因
   */
  close(code = 1000, reason = '') {
    // 防重复：已关闭或关闭握手中再次调用，避免发送多个 Close 帧
    if (this._closed || this._closing) return;
    // RFC 6455 Section 7.4.1: 1005/1006/1015 状态码不得在 Close 帧中发送
    // 1005 = 无状态码语义、1006 = 异常关闭语义、1015 = TLS 握手失败语义
    // 这些码仅用于 close 事件传给用户态，不能在网络上发送
    // 用户调用 ws.close(1005) 等时，发送侧传 undefined（不带状态码），事件侧仍保留原始 code
    const sendCode = (code === 1005 || code === 1006 || code === 1015) ? undefined : code;
    // 保存本地传入的 code/reason，用于关闭握手完成时 close 事件优先使用
    // 场景：本地主动 close(4000, 'custom') 后对端回复 Close 帧，
    // _emitClose 优先用本地值，保证用户态事件参数可预测（与 ws 库行为对齐）
    this._localCloseCode = code;
    this._localCloseReason = reason;
    // 重要：必须先发送 Close 帧再设 connected=false
    // _sendFrame 内部检查 this.connected，若先断开则 Close 帧无法发出
    this._sendCloseFrame(sendCode, reason);
    // 标记为关闭中，拒绝后续数据帧发送和 _sendFrame 写入
    this.connected = false;
    this._closing = true;
    // 限时等待对端 Close 帧（2秒超时）
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      // 超时强制关闭：直接 emit close 事件携带原始 code/reason
      // 注意：不能调用 _emitClose（其首行 if(this._closed) return 会因下方置位而失效）
      // 也不能让 socket 'close' 事件的无参 _emitClose 覆盖掉 code/reason
      if (this._closed) return;
      this._closed = true;
      try { this.socket.destroy(); } catch (e) { /* 忽略 */ }
      this._emit('close', code, reason);
    }, 2000);
    // unref 防止定时器阻止进程退出（测试场景下断开所有连接后进程应能立即退出）
    if (typeof this._closeTimer.unref === 'function') this._closeTimer.unref();
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
function WebSocketHandshake(key) {
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
    // RFC 6455: 同源请求（如浏览器同页面发起的 ws 连接）不发送 Origin 头，不应拒绝
    // 仅当客户端携带 Origin 头且不在白名单中时才拒绝
    if (this._allowedOrigins) {
      const origin = req.headers['origin'];
      // 归一化为数组做精确匹配：防止配置为字符串时 includes 子串误匹配
      // （如白名单 https://a.com，恶意站点 https://a.com.evil.com 也满足 includes）
      const allowedList = Array.isArray(this._allowedOrigins) ? this._allowedOrigins : [this._allowedOrigins];
      if (origin && !allowedList.includes(origin)) {
        // 用 socket.end 替代 write+destroy：end 会在数据刷出后自动关闭 socket，
        // 避免 destroy 立即关闭导致客户端收不到 403 响应
        // socket 已关闭/已销毁时 end 可能抛 ERR_STREAM_WRITE_AFTER_END，需 try/catch
        try { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) { /* socket 已关闭 */ }
        return null;
      }
    }

    const accept = WebSocketHandshake(key);

    // 发送握手响应
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`
    ];
    // socket.write 在 socket 已关闭/已销毁时可能抛 ERR_STREAM_WRITE_AFTER_END
    // 握手响应写入失败时无法建立连接，直接销毁 socket 并返回 null
    try {
      socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
    } catch (e) {
      socket.destroy();
      return null;
    }

    // 创建 WebSocket 实例
    const ws = new WebSocket(socket, pathname, { maxPayload: this._maxPayload });
    // 立即注册 close 监听器：WebSocket 构造函数内部已监听 socket 'close' 事件并触发 _emitClose，
    // 虽 socket 'close' 为异步触发，但防御性前置注册可消除极端竞态下的连接泄漏
    // （若延迟到 connections.set / _startHeartbeat 之后才注册，期间 socket 一旦进入关闭流程，
    //  监听器将注册不上，导致连接永远滞留在 connections Map 中造成内存泄漏）
    ws.on('close', () => {
      this._removeConnection(ws);
    });
    // 处理握手前客户端可能已发送的首帧数据（head）
    // Node.js upgrade 事件的 head 参数可能包含客户端在握手响应前发送的 WebSocket 帧
    // 若不喂给解析器，会导致首帧消息丢失（浏览器在握手后立即发送 subscribe 等场景）
    // 异步化：用 process.nextTick 延迟解析，确保 _emit('connection') 回调和 app.ws() handler
    // 同步注册 'text'/'data' 监听器后再处理 head，避免首帧事件被 _emitEvent 静默丢弃
    if (head && head.length > 0) {
      ws._frameBuffer = Buffer.concat([ws._frameBuffer, head]);
      process.nextTick(() => ws._parseFrames());
    }
    this.connections.set(ws.id, ws);

    // 按路径分组
    if (!this.groups.has(pathname)) {
      this.groups.set(pathname, new Set());
    }
    this.groups.get(pathname).add(ws);

    // 启动心跳
    this._startHeartbeat();

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
        // ws.close() 异步触发 close 事件 → _removeConnection，无需再 push toRemove
        if (now - ws._lastHeartbeat > this._heartbeatInterval + this._heartbeatTimeout) {
          ws.close();
          continue;
        }
        ws._sendPing();
      }
      for (const ws of toRemove) {
        this._removeConnection(ws);
      }
    }, this._heartbeatInterval);
    // unref 防止心跳定时器阻止进程退出
    if (typeof this._timer.unref === 'function') this._timer.unref();
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
   * 按路径广播消息（支持层级广播）
   * 精确匹配：broadcast('/chat/room1') → 仅发送 /chat/room1 组的连接
   * 层级广播：broadcast('/chat') → 发送 /chat 及所有 /chat/* 子路径的连接
   * 前缀匹配规则：key === pathStr || key.startsWith(pathStr + '/')
   * 避免误匹配：broadcast('/chat') 不会匹配 /chatone（因为 /chatone 不以 /chat/ 开头）
   * @param {string} pathStr 广播路径
   * @param {*} data 广播数据
   * @param {WebSocket|WebSocket[]|null} exclude 排除的连接，支持单个ws或ws数组
   */
  broadcast(pathStr, data, exclude = null) {
    const excluded = Array.isArray(exclude) ? new Set(exclude) : exclude ? new Set([exclude]) : null;
    for (const ws of this.getConnections(pathStr)) {
      if (ws.connected && (!excluded || !excluded.has(ws))) {
        ws.send(data);
      }
    }
  }

  /**
   * 全局广播消息
   * @param {*} data 广播数据
   * @param {WebSocket|WebSocket[]|null} exclude 排除的连接，支持单个ws或ws数组
   */
  broadcastAll(data, exclude = null) {
    const excluded = Array.isArray(exclude) ? new Set(exclude) : exclude ? new Set([exclude]) : null;
    for (const ws of this.connections.values()) {
      if (ws.connected && (!excluded || !excluded.has(ws))) {
        ws.send(data);
      }
    }
  }

  /**
   * 获取指定路径的所有连接（支持层级查询）
   * 返回新数组（修改数组不影响内部连接池），但数组元素为 ws 对象引用（修改 ws 属性会影响内部状态）
   * @param {string} [pathStr] - 指定路径；不传则返回所有连接
   *   精确匹配 + 层级匹配：getConnections('/chat') 返回 /chat 及 /chat/* 子路径的所有连接
   * @returns {WebSocket[]} 连接数组（新数组，元素为引用）
   */
  getConnections(pathStr) {
    if (pathStr) {
      const result = [];
      const group = this.groups.get(pathStr);
      if (group) result.push(...group);
      const prefix = pathStr + '/';
      for (const [key, grp] of this.groups) {
        if (key.startsWith(prefix)) {
          result.push(...grp);
        }
      }
      return result;
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
  // JSON/urlencoded 请求体大小限制（语义区别于 maxFieldSize 表单字段）
  // 注意：闭包默认值仅用于 JSON/urlencoded 路径，multipart 的限制需区分"显式配置"与"默认值"
  const maxBodySize = options.maxBodySize || 128 * 1024 * 1024;
  // multipart 单文件/单字段/总大小限制：仅当 bodyParserOptions 显式配置时传入，
  // 否则传 undefined 让 _parseMultipart 回退到 settings.maxFileSize/maxFieldSize/maxBodySize
  // （避免闭包默认值掩盖用户通过 httpm({ maxFileSize }) 等顶层配置设置的限制）
  const multipartMaxFileSize = options.maxFileSize !== undefined ? options.maxFileSize : undefined;
  const multipartMaxFieldSize = options.maxFieldSize !== undefined ? options.maxFieldSize : undefined;
  const multipartMaxBodySize = options.maxBodySize !== undefined ? options.maxBodySize : undefined;

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
        _parseMultipart(req, boundary, multipartMaxFileSize, multipartMaxFieldSize, multipartMaxBodySize, next);
        // 仅 multipart 需要临时文件清理（使用 res.on 保持封装一致性）
        // 同时监听 finish 和 close：finish 覆盖正常完成，close 覆盖客户端中途断开
        // 用一次性标志避免重复清理（_cleanupTempFiles 对已删除文件幂等，但避免重复调用）
        let tempCleaned = false;
        const cleanupTemp = () => {
          if (tempCleaned) return;
          tempCleaned = true;
          _cleanupTempFiles(req._tempFiles);
        };
        res.on('finish', cleanupTemp);
        res.on('close', cleanupTemp);
      } else {
        next();
      }
    } else {
      // 其他类型：原始 Buffer 存储
      req._readBody(30000, maxBodySize).then(buf => {
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
  // 传入 maxSize 使 _readBody 流式检查生效（不传时用 settings.maxBodySize，
  // 会导致 bodyParserOptions.maxBodySize 在数据完整读入后才检查，内存峰值可能超限）
  req._readBody(30000, maxSize).then(buf => {
    if (buf.length > maxSize) {
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxSize)}`, { cause: { actual: buf.length, maxSize } });
      err.status = 413;
      next(err);
      return;
    }
    try {
      req.body = JSON.parse(buf.toString('utf8'));
      // 合并到 formData.fields（跳过危险键，防御原型污染）
      if (typeof req.body === 'object' && req.body !== null) {
        for (const [k, v] of Object.entries(req.body)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          req.formData.fields[k] = v;
        }
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
  // 同 _parseJSON：传入 maxSize 使流式大小检查生效，避免超限数据先完整读入内存
  req._readBody(30000, maxSize).then(buf => {
    if (buf.length > maxSize) {
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxSize)}`, { cause: { actual: buf.length, maxSize } });
      err.status = 413;
      next(err);
      return;
    }
    const parsed = parseQuery(buf.toString('utf8'), true);
    req.body = parsed;
    // 合并到 formData.fields（parseQuery 已过滤 __proto__/constructor/prototype 危险键，直接合并安全）
    for (const [k, v] of Object.entries(parsed)) {
      req.formData.fields[k] = v;
    }
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
function _parseMultipart(req, boundary, multipartMaxFileSize, multipartMaxFieldSize, multipartMaxBodySize, next) {
  const tempDir = req._app?.settings?.tempDir || 'tempupdir';
  // 单文件/单字段大小限制：优先级 bodyParserOptions 显式配置 > settings 顶层配置 > 默认值
  const maxFileSize = multipartMaxFileSize || req._app?.settings?.maxFileSize || 128 * 1024 * 1024;
  const maxFieldSize = multipartMaxFieldSize || req._app?.settings?.maxFieldSize || 1024 * 1024;
  // part 头部大小上限（DoS 防护）：独立于 maxFieldSize（表单字段值大小限制）。
  // 此前复用 maxFieldSize 会导致用户调小 maxFieldSize 限制字段值时，
  // 合法请求的 part 头部（Content-Disposition 等，约 70+ 字节）也被拒绝。
  // 优先取 bodyParserOptions.maxFieldSize 显式值，否则默认 1MB（正常 part 头部远小于此值）。
  const partHeaderMaxSize = multipartMaxFieldSize || 1024 * 1024;
  const delimiter = Buffer.from('--' + boundary);
  // RFC 2046 分隔符：part 数据之后必须以 CRLF 前置的 \r\n--boundary 结束
  // 查找 CRLF+delimiter 而非裸 delimiter，防止文件/字段内容中出现的 --boundary 子串被误判为分隔符
  // （此前 BODY_FIELD/BODY_FILE 用 indexOf(delimiter) 查找，内容含 --boundary 会截断数据）
  const crlfDelimiter = Buffer.concat([Buffer.from('\r\n'), delimiter]);
  // 回看长度：multipart 文件数据结尾为 [文件数据]\r\n--boundary
  // 需保留 \r\n 前缀以应对跨 chunk 分隔点落在 \r 之后的情况
  // 否则 \r 会被写入文件，破坏二进制文件完整性（图片/视频等末尾多出 \r\n）
  // crlfDelimiter.length - 1 = delimiter.length + 1
  const lookBehind = crlfDelimiter.length - 1;
  let state = 'INIT'; // INIT, HEADERS, BODY_FIELD, BODY_FILE
  let partHeadersBuf = Buffer.alloc(0);
  let currentField = { name: '', value: '', decoder: null };
  let currentFile = { name: '', filename: '', contentType: '', size: 0, path: '', stream: null };
  let fieldSize = 0;
  let fileSize = 0;
  let buffer = Buffer.alloc(0);
  let cleanupOnError = false;
  let paused = false;

  // 统一防护：任何错误分支调用 next 后，终止请求流并阻止后续 next 重复调用
  // 场景：fieldSize 超限后仅 return 退出 processBuffer，但 req 'data' 事件会继续触发
  //       再次进入 processBuffer 重新触发错误分支，导致 next 被多次调用
  let nextCalled = false;
  const safeNext = (e) => {
    if (nextCalled) return;
    nextCalled = true;
    // 终止请求流，避免客户端继续发送数据触发后续处理
    try { req._req.destroy(); } catch (err) { /* 忽略 */ }
    next(e);
  };

  // 确保临时目录存在（recursive: true 时目录已存在不报错，无需 existsSync）
  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (e) {
    // 临时目录创建失败（权限不足/路径非法等）直接终止解析
    safeNext(e);
    return;
  }

  // 标志位：文件写入流出错时防止 next 重复调用
  let streamErrored = false;
  // 跟踪所有已创建的文件写入流：on('end') 时等待全部 flush 完成再 next()
  // 防止业务 handler 同步读取 file.path 时读到空/部分数据（BUG-2 修复）
  const pendingStreams = new Set();
  // 惰性创建文件写入流，统一绑定 drain/error 事件（DRY：两处创建点共用）
  function ensureFileStream() {
    if (currentFile.stream) return currentFile.stream;
    const stream = fs.createWriteStream(currentFile.path);
    // 背压处理：写入流满时暂停请求读取，drain 后恢复
    stream.on('drain', () => {
      if (paused) {
        paused = false;
        req._req.resume();
      }
    });
    // 写入流出错（磁盘满/权限等）：清理临时文件并终止解析
    stream.on('error', (streamErr) => {
      if (streamErrored) return;
      streamErrored = true;
      if (currentFile.stream) currentFile.stream.destroy();
      _cleanupTempFiles(req._tempFiles);
      safeNext(streamErr);
    });
    currentFile.stream = stream;
    pendingStreams.add(stream);
    return stream;
  }

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
          // 校验 part 头部大小，防止恶意客户端发送超大单个 part 头部（永不结束）导致 DoS
          // 用独立 partHeaderMaxSize（默认 1MB），不随 maxFieldSize 字段值限制联动
          if (partHeadersBuf.length > partHeaderMaxSize) {
            const err = new Error(`Part header exceeds maximum size of ${fmtSize(partHeaderMaxSize)}`, { cause: { actual: partHeadersBuf.length, maxSize: partHeaderMaxSize } });
            err.status = 413;
            safeNext(err);
            return;
          }
          buffer = Buffer.alloc(0);
          break;
        }
        // 找到结束标记时也校验累积总大小（极端情况下单个 chunk 可能含超大头部）
        partHeadersBuf = Buffer.concat([partHeadersBuf, buffer.subarray(0, headerEnd)]);
        if (partHeadersBuf.length > partHeaderMaxSize) {
          const err = new Error(`Part header exceeds maximum size of ${fmtSize(partHeaderMaxSize)}`, { cause: { actual: partHeadersBuf.length, maxSize: partHeaderMaxSize } });
          err.status = 413;
          safeNext(err);
          return;
        }
        buffer = buffer.subarray(headerEnd + 4);
        const partHeaders = partHeadersBuf.toString('utf8');

        // 解析 Content-Disposition
        const nameMatch = partHeaders.match(/name="([^"]+)"/);
        const filenameMatch = partHeaders.match(/filename="([^"]+)"/);
        const ctMatch = partHeaders.match(/Content-Type:\s*(.+)/i);

        if (filenameMatch) {
          // 文件字段
          // 安全过滤：filename 来自客户端，可能含路径分隔符或 .. 实现路径遍历
          // 仅保留 basename（剥离目录），再替换残留分隔符，防止写入任意路径
          let safeFilename = filenameMatch[1].replace(/[\\\/]/g, '_'); // 替换路径分隔符
          safeFilename = path.basename(safeFilename); // 剥离目录部分
          if (safeFilename === '.' || safeFilename === '..' || safeFilename === '') {
            safeFilename = 'unnamed';
          }
          currentFile = {
            name: nameMatch ? nameMatch[1] : '',
            filename: safeFilename,
            contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            size: 0,
            path: path.join(tempDir, `${uid()}_${safeFilename}`),
            stream: null
          };
          fileSize = 0;
          state = 'BODY_FILE';
          cleanupOnError = true;
        } else {
          // 普通字段
          // 普通字段：用 StringDecoder 处理多字节 UTF-8 字符跨 chunk 拼接
          // 直接 toString('utf8') 在字符边界截断会产生 U+FFFD 替换字符
          currentField = { name: nameMatch ? nameMatch[1] : '', value: '', decoder: new StringDecoder('utf8') };
          fieldSize = 0;
          state = 'BODY_FIELD';
        }
      } else if (state === 'BODY_FIELD') {
        // 查找分隔符（字段结束）：CRLF+delimiter 整体消费，数据不含前导 \r\n
        const idx = buffer.indexOf(crlfDelimiter);
        if (idx === -1) {
          // 还没结束，缓存数据（但检查大小限制）
          // 保留尾部回看字节，防止分隔符跨 chunk 截断
          const safeLen = Math.max(0, buffer.length - lookBehind);
          // 用 StringDecoder 处理跨 chunk 的多字节 UTF-8 字符
          const chunk = currentField.decoder.write(buffer.subarray(0, safeLen));
          fieldSize += safeLen;
          if (fieldSize > maxFieldSize) {
            const err = new Error(`Field exceeds maximum size of ${fmtSize(maxFieldSize)}`, { cause: { actual: fieldSize, maxSize: maxFieldSize } });
            err.status = 413;
            safeNext(err);
            return;
          }
          currentField.value += chunk;
          buffer = buffer.subarray(safeLen);
          break;
        }
        // 字段结束：数据为 [0, idx)，\r\n--boundary 由 idx 处整体消费
        const chunk = currentField.decoder.write(buffer.subarray(0, idx));
        fieldSize += idx;
        if (fieldSize > maxFieldSize) {
          const err = new Error(`Field exceeds maximum size of ${fmtSize(maxFieldSize)}`, { cause: { actual: fieldSize, maxSize: maxFieldSize } });
          err.status = 413;
          safeNext(err);
          return;
        }
        currentField.value += chunk;
        // 刷新 decoder 中残留的未完成字符（末尾不完整字节会用 U+FFFD 替换）
        currentField.value += currentField.decoder.end();
        // 防御空字段名：nameMatch 未匹配时 name 为空字符串，跳过赋值避免污染 formData.fields['']
        if (currentField.name) {
          // 防御原型污染：拒绝 __proto__/constructor/prototype 等危险键（提前跳过，减少嵌套）
          const isDangerKey = currentField.name === '__proto__' || currentField.name === 'constructor' || currentField.name === 'prototype';
          if (!isDangerKey) {
            // 同名字段聚合为数组（Express 兼容）
            const existingField = req.formData.fields[currentField.name];
            if (existingField !== undefined) {
              req.formData.fields[currentField.name] = Array.isArray(existingField) ? [...existingField, currentField.value] : [existingField, currentField.value];
            } else {
              req.formData.fields[currentField.name] = currentField.value;
            }
          }
        }
        buffer = buffer.subarray(idx + crlfDelimiter.length);
        // 分隔符后若跟 --（最后一个 part），则 body 结束；否则跳过 \r\n 进入下一 part 头部
        if (buffer.length >= 2 && buffer[0] === 0x2D && buffer[1] === 0x2D) {
          // 结尾 --boundary--，无后续 part，置空等待结束
          buffer = Buffer.alloc(0);
        } else if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.subarray(2);
        }
        state = 'HEADERS';
        partHeadersBuf = Buffer.alloc(0);
      } else if (state === 'BODY_FILE') {
        // 查找分隔符（文件结束）：CRLF+delimiter 整体消费，数据不含前导 \r\n
        const idx = buffer.indexOf(crlfDelimiter);
        if (idx === -1) {
          // 还没结束，写入临时文件
          // 保留尾部回看字节，防止分隔符跨 chunk 截断
          const safeLen = Math.max(0, buffer.length - lookBehind);
          const writeData = buffer.subarray(0, safeLen);
          ensureFileStream();
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
            safeNext(err);
            return;
          }
          buffer = buffer.subarray(safeLen);
          break;
        }
        // 文件结束：数据为 [0, idx)，前导 \r\n 属于分隔符前缀不属于文件内容
        const fileData = buffer.subarray(0, idx);
        // 超限检查：文件结束分支同样校验（分块分支已校验，但单 chunk 含完整文件时走此分支，
        // 此前缺少检查导致超过 maxFileSize 的文件被完整写入磁盘）
        fileSize += fileData.length;
        if (fileSize > maxFileSize) {
          if (currentFile.stream) currentFile.stream.destroy();
          const err = new Error(`File exceeds maximum size of ${fmtSize(maxFileSize)}`, { cause: { actual: fileSize, maxSize: maxFileSize, filename: currentFile.filename } });
          err.status = 413;
          safeNext(err);
          return;
        }

        ensureFileStream();
        currentFile.stream.write(fileData);
        // 结束写入：end() 是异步的，但此处保持同步 push fileInfo 以确保
        // _tempFiles 列表完整（res.on('finish') 清理时不会遗漏）
        // 极端 race：end() 后立即磁盘满导致写入不完整，error 事件触发时
        // fileInfo 已被 push 记录。缓解：error 处理器已通过 safeNext 销毁
        // 请求流（_handleError → 500 响应），后续 handler 不会执行。
        // 注意：end() 后必须等待 'finish' 事件才能安全读取文件内容，
        // 业务 handler 若同步 fs.readFileSync 可能读到空数据（见 on('end') 的 finish 等待）
        currentFile.stream.end();
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
        buffer = buffer.subarray(idx + crlfDelimiter.length);
        // 分隔符后若跟 --（最后一个 part），则 body 结束；否则跳过 \r\n 进入下一 part 头部
        if (buffer.length >= 2 && buffer[0] === 0x2D && buffer[1] === 0x2D) {
          // 结尾 --boundary--，无后续 part，置空等待结束
          buffer = Buffer.alloc(0);
        } else if (buffer.length >= 2 && buffer[0] === 0x0D && buffer[1] === 0x0A) {
          buffer = buffer.subarray(2);
        }
        state = 'HEADERS';
        partHeadersBuf = Buffer.alloc(0);
      }
    }
  }

  // multipart 请求体总大小限制（复用 maxBodySize 语义，防止无限多个小文件累积超大 body）
  // 优先级：bodyParserOptions.maxBodySize（显式配置）> settings.maxBodySize（顶层）> 默认 128MB
  const maxBodySize = multipartMaxBodySize || req._app?.settings?.maxBodySize || 128 * 1024 * 1024;
  let totalBodySize = 0;

  // 监听请求数据流
  req._req.on('data', chunk => {
    totalBodySize += chunk.length;
    if (totalBodySize > maxBodySize) {
      const err = new Error(`Body exceeds maximum size of ${fmtSize(maxBodySize)}`, { cause: { actual: totalBodySize, maxSize: maxBodySize } });
      err.status = 413;
      safeNext(err);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  });

  req._req.on('end', () => {
    // error 已触发 safeNext 时跳过，避免正常流程在错误后继续执行
    if (nextCalled) return;
    // 处理剩余缓冲区
    processBuffer();
    // 状态校验：请求结束时若仍在 BODY_FILE（文件字段未正常结束），
    // 说明客户端中途断开或畸形请求，需关闭未完成的文件流并清理临时文件
    if (state === 'BODY_FILE') {
      if (currentFile.stream) currentFile.stream.destroy();
      _cleanupTempFiles(req._tempFiles);
    }
    req.body = req.formData.fields;
    // 等待所有已结束的文件写入流 flush 完成后调用 next()，否则业务 handler 同步
    // 读取 file.path 可能拿到空/部分数据（stream.end() 是异步 flush，立即读有竞态）
    // 已结束的流收集在 req._tempFiles 对应的流对象（currentFile.stream 已随状态切换变更，
    // 需在解析期间记录所有创建的流），此处通过 _pendingStreams 追踪
    if (pendingStreams.size > 0) {
      let pending = pendingStreams.size;
      const onFinish = () => {
        pending--;
        if (pending === 0) next();
      };
      // 每个流注册 finish 监听；error 已由 ensureFileStream 的 error handler 通过 safeNext 处理
      // （safeNext 置位 nextCalled 后此处不再重复调用 next）
      for (const stream of pendingStreams) {
        if (stream.writableFinished) { onFinish(); continue; }
        stream.once('finish', onFinish);
      }
    } else {
      next();
    }
  });

  req._req.on('error', (err) => {
    // 客户端断开，清理临时文件
    if (cleanupOnError && currentFile.stream) {
      currentFile.stream.destroy();
    }
    _cleanupTempFiles(req._tempFiles);
    safeNext(err);
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
        // 防御非字符串值：用户中间件可能修改 req.cookies 导致 val 为非字符串
        // val.startsWith 在非字符串上会抛 TypeError
        if (typeof val === 'string' && val.startsWith('s:')) {
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
            // 使用常量时间比较防止时序攻击（先比较长度，等长时用 timingSafeEqual）
            const sigBuf = Buffer.from(sig);
            const expectedBuf = Buffer.from(expected);
            if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
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
   * @param {string} name - 配置名（非字符串或空字符串时抛 TypeError）
   * @param {*} value - 配置值；undefined 表示读取配置
   */
  set(name, value) {
    if (value === undefined) return this.settings[name];
    // 防御：name 必须是非空字符串，避免 Object.keys(null) 或 settings[null] 导致异常
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('app.set(name, value): name must be a non-empty string');
    }
    this.settings[name] = value;
    // 同步更新日志级别
    if (name === 'logLevel') {
      this._logger.level = value;
    }
    return this;
  }

  /**
   * 获取配置（当参数为非路径字符串时）或注册 GET 路由
   * Express 兼容：app.get('key') 获取配置，app.get('/path', handler) 注册路由
   * 判定规则：单参数且字符串不以 '/' 开头 → 获取配置；否则 → 注册路由
   */
  get(...args) {
    if (args.length === 1 && typeof args[0] === 'string' && !args[0].startsWith('/')) {
      return this.settings[args[0]];
    }
    // 否则调用 Router 的 get 方法注册路由
    return Router.prototype.get.apply(this, args);
  }

  /**
   * 启动网络服务，监听端口
   * @param {number} [port] 监听端口，省略时使用 settings.svrPort；0 表示由操作系统随机分配
   * @param {Function} [callback] 启动成功回调，签名 (err) => void
   */
  listen(port, callback) {
    // 注意：port=0 是 Node.js 约定的"随机端口"语义（falsy），不能用 || 短路
    // 否则 listen(0) 会回退到 svrPort（默认 80），非 root 用户监听 80 会 EACCES 失败
    const listenPort = (port !== undefined && port !== null) ? port : this.settings.svrPort;
    const ip = this.settings.svrIP;

    // 创建服务器
    // key/cert/ca/pfx 支持两种形式：文件路径字符串 或 已读取的 Buffer（README 示例传入 fs.readFileSync 结果）
    const loadCredential = (v) => Buffer.isBuffer(v) ? v : fs.readFileSync(v);
    if (this.settings.http2) {
      // HTTP2 模式
      if (!this.settings.https || !this.settings.https.key || !this.settings.https.cert) {
        throw new Error('HTTP2 requires HTTPS configuration (key and cert)', { cause: { https: !!this.settings.https, hasKey: !!(this.settings.https && this.settings.https.key), hasCert: !!(this.settings.https && this.settings.https.cert) } });
      }
      const opts = {
        key: loadCredential(this.settings.https.key),
        cert: loadCredential(this.settings.https.cert),
        allowHTTP1: true
      };
      if (this.settings.https.ca) opts.ca = loadCredential(this.settings.https.ca);
      this.server = http2.createSecureServer(opts, this._handleRequest.bind(this));
    } else if (this.settings.https && this.settings.https.key && this.settings.https.cert) {
      // HTTPS 模式
      const opts = {
        key: loadCredential(this.settings.https.key),
        cert: loadCredential(this.settings.https.cert)
      };
      if (this.settings.https.ca) opts.ca = loadCredential(this.settings.https.ca);
      if (this.settings.https.pfx) opts.pfx = loadCredential(this.settings.https.pfx);
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
      // IPv6 :: 与 IPv4 0.0.0.0 均为通配地址，日志显示 localhost 更友好
      const host = (addr.address === '::' || addr.address === '0.0.0.0') ? 'localhost' : addr.address;
      this._logger.info(`Server running at ${protocol}://${host}:${addr.port}/`);
      if (callback) callback();
    });

    return this.server;
  }

  /**
   * 停止服务，释放端口资源
   */
  close(callback) {
    if (this._wss) {
      // 关闭所有 WebSocket 连接，并强制销毁底层 socket，确保连接不泄漏
      for (const ws of this._wss.connections.values()) {
        ws.close();
        // ws.close() 依赖对端回复 Close 帧或 2 秒超时，直接强制销毁 socket 加速关闭
        try { ws.socket && ws.socket.destroy(); } catch (e) { /* 忽略销毁错误 */ }
      }
      this._wss._stopHeartbeat();
    }
    // 统一的清理函数：释放 Logger 写入流，避免文件描述符泄漏
    // Windows 上 stream.end() 是异步的，destroy() 立即释放句柄
    // 放在 server.close 回调中执行，确保关闭过程中的日志仍能正常写入
    const cleanupLogger = () => {
      if (this._logger && this._logger._stream) {
        try { this._logger._stream.destroy(); } catch (e) { /* 忽略销毁错误 */ }
        this._logger._stream = null;
      }
    };
    if (this.server) {
      // 强制关闭所有现有 HTTP 连接（含 keep-alive 空闲连接），
      // 避免 server.close() 等待 keepAliveTimeout 导致关闭延迟（Node.js 18.2+）
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
      // 超时兜底：极少数情况下 socket 未被 closeAllConnections 关闭，
      // server.close 回调会无限等待，2 秒超时强制完成关闭
      let called = false;
      const done = () => {
        if (called) return;
        called = true;
        clearTimeout(timer);
        cleanupLogger();
        if (callback) callback();
      };
      this.server.close(done);
      const timer = setTimeout(done, 2000);
      // unref 防止 timer 阻止进程退出（测试场景下 app.close 后进程应能正常退出）
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      // 无 server 实例（如未调用 listen）：直接清理 Logger 并回调
      cleanupLogger();
      if (callback) callback();
    }
  }

  /**
   * 处理 HTTP 请求（核心入口）
   */
  _handleRequest(incomingMessage, serverResponse) {
    try {
      const req = new Request(incomingMessage);
      const res = new Response(serverResponse, this);
      req._app = this;
      req._res = res;
      res._req = req;

      // 基础解析：parseUrl 仅拆分 pathname 与 query，不做 URI 解码
      const parsed = parseUrl(incomingMessage.url);
      try {
        // 路由匹配基于解码后的路径，确保 /users/%3Aid 等编码字符能正确匹配动态路由参数
        // 解码后再由 isPathSafe 做路径安全校验，防止 %2e%2e%2f 等编码形式的路径遍历攻击
        req.path = decodeURIComponent(parsed.pathname);
      } catch (e) {
        // 非法 URI 编码（如 %ZZ），返回 400 避免下游路由匹配抛异常导致 500
        res.status(400).send('Bad Request: Invalid URI encoding');
        return;
      }
      req.query = parsed.query;
      // Cookie 由 cookieParser 中间件统一解析，此处不再重复处理

      // HEAD 请求标记：执行路由处理器但丢弃响应体
      if (req.method === 'HEAD') {
        res._isHead = true;
      }

      // 为所有跨域请求设置基础 CORS 响应头（实际请求 + 预检均需要）
      this._applyCORSHeaders(req, res);

      // 构建中间件 + 路由处理器执行链
      this._dispatch(req, res);
    } catch (err) {
      // 顶层兜底：parseUrl / new Request / new Response 等抛异常时防止冒泡到 http server 导致进程崩溃
      this._logger.error('Unhandled request error:', err);
      if (!serverResponse.headersSent) {
        serverResponse.statusCode = 500;
        // 显式设置 Content-Type，避免客户端 MIME 嗅探误判
        serverResponse.setHeader('Content-Type', 'text/plain; charset=utf-8');
        // 设置 Connection: close，确保出错连接不被复用
        // 顶层 catch 意味着请求处理异常（req.body 可能部分解析、临时文件可能残留）
        // 复用此连接的后续请求会在污染状态上执行，强制关闭让客户端新建连接
        serverResponse.setHeader('Connection', 'close');
        // HEAD 请求只发送头部不发送响应体（与 send/response.end 行为一致）
        if (incomingMessage.method === 'HEAD') {
          serverResponse.end();
        } else {
          serverResponse.end('Internal Server Error');
        }
      }
    }
  }

  /**
   * 分发请求到中间件链和路由处理器
   */
  _dispatch(req, res) {
    // 收集所有匹配的中间件和路由
    const stack = [];
    // 错误处理中间件单独收集，放到 stack 末尾：
    //   app.use 注册的错误处理中间件在 mwMatches 中（位于路由之前），
    //   若不放末尾，路由抛错时 _handleError 从路由 idx 向后查找会找不到前面的错误处理中间件
    const errorHandlers = [];

    // 1. 应用级和路径级中间件
    // 错误处理中间件（4 参数函数）仍入栈但标记 isErrorHandler，正常链 next() 跳过
    // （Express 兼容：4 参数函数即错误处理中间件）
    const mwMatches = this.matchMiddleware(req.path);
    for (const mw of mwMatches) {
      for (const handler of mw.middleware.handlers) {
        if (handler.length === 4) {
          errorHandlers.push({ handler, params: mw.params, isErrorHandler: true });
        } else {
          stack.push({ handler, params: mw.params, isErrorHandler: false });
        }
      }
    }

    // 2. 路由处理器
    // 注意：路由参数不在收集阶段合并到 req.params，而是在执行阶段按 layer 重置
    // 这样每个 layer 执行时 req.params 仅含该 layer 自己的参数，避免相互污染（与 Express 行为一致）
    const routeMatches = this.match(req.method, req.path);
    for (const match of routeMatches) {
      for (const handler of match.handlers) {
        if (handler.length === 4) {
          errorHandlers.push({ handler, params: match.params, isErrorHandler: true });
        } else {
          stack.push({ handler, params: match.params, isErrorHandler: false });
        }
      }
    }

    // 3. 错误处理中间件放到 stack 末尾，确保任何位置抛错都能向后找到
    stack.push(...errorHandlers);

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
      // 正常链跳过错误处理中间件（4 参数函数仅处理错误）
      if (item.isErrorHandler) {
        next();
        return;
      }
      const handler = item.handler;
      // 保存当前 handler 在 stack 中的位置快照
      // async handler 的 Promise.catch 触发时 idx 闭包可能已变化，需用快照定位错误处理起点
      const currentIdx = idx;
      // 每个 layer 执行前重置 req.params 为该 layer 自己的参数（与 Express 行为一致）
      // 避免中间件参数（如 use('/api/:version') 的 version）污染到路由处理器
      // 路由处理器若需读取路径级中间件设置的参数，应在中间件中挂到 req 自定义属性上
      req.params = item.params || {};
      // 防止同一 handler 多次调用 next()（无论是否有 err，只允许一次 next 调用）
      let handlerCalledNext = false;
      const safeNext = (e) => {
        if (handlerCalledNext) return;
        handlerCalledNext = true;
        next(e);
      };

      try {
        // 路由处理器返回 false → 进入静态文件兜底
        const result = handler(req, res, safeNext);
        if (result === false) {
          // _serveStatic 异常走错误处理链，避免冒泡到 _handleRequest 顶层 catch
          // 顶层 catch 只记录日志，错误处理中间件无法感知
          try {
            this._serveStatic(req, res);
          } catch (e) {
            this._handleError(e, req, res, stack, currentIdx);
          }
          return;
        }
        // 支持 async/await
        if (result && typeof result.then === 'function') {
          result.then(r => {
            if (r === false) {
              // async 路径同样捕获 _serveStatic 异常，走错误处理链
              try {
                this._serveStatic(req, res);
              } catch (e) {
                this._handleError(e, req, res, stack, currentIdx);
              }
            }
          }).catch(err => {
            // handler 已通过 next(err) 传递错误时跳过，避免重复调用 _handleError
            // （与上方 sync catch 块的 if (handlerCalledNext) return 保持一致）
            if (handlerCalledNext) return;
            // 用 currentIdx 快照定位错误处理起点，避免 idx 闭包失效
            this._handleError(err, req, res, stack, currentIdx);
          });
        }
      } catch (err) {
        // handler 已通过 next(err) 传递错误时，跳过避免重复处理
        if (handlerCalledNext) return;
        // 用 currentIdx 快照定位错误处理起点
        this._handleError(err, req, res, stack, currentIdx);
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
    // 从当前栈中查找错误处理中间件（isErrorHandler 标记的 4 参数函数）
    for (let i = startIdx; i < stack.length; i++) {
      const item = stack[i];
      if (item.isErrorHandler) {
        try {
          item.handler(err, req, res, (e) => {
            // 有错误用新错误继续传递；next() 无参（e 为空）用原错误继续链式传递
            // 递归复用 _handleError：向后查找下一个错误处理中间件，无后续时默认响应兜底避免挂起
            this._handleError(e || err, req, res, stack, i + 1);
          });
          return;
        } catch (e) {
          err = e;
          continue;
        }
      }
    }
    // 没有错误处理中间件，使用默认错误响应
    this._defaultErrorResponse(err, req, res);
  }

  /**
   * 默认错误响应（错误处理中间件缺失/未消费错误时兜底）
   * 校验 err.status 为有效 HTTP 状态码（100-599 整数），避免非数字/越界值导致协议违规
   */
  _defaultErrorResponse(err, req, res) {
    // 常见错误：err.status = '500'（字符串）、err.status = 999（越界）、err.status = 'InternalServerError'
    let status = err.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      // 兼容 err.statusCode（部分库使用该字段，如 http-errors）
      status = err.statusCode;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        status = 500;
      }
    }
    const msg = err.message || 'Internal Server Error';
    this._logger.error(`[${status}] ${req.method} ${req.path} - ${msg}`);
    if (!res.headersSent) {
      res.status(status).json({ error: msg, status });
    } else {
      // 响应头已发送（如流式响应中途出错），强制结束连接避免客户端挂起等待
      // 不再写入响应体（headersSent 后无法修改状态码/头，写入会破坏已发送的响应）
      try { res._res.end(); } catch (e) { /* 忽略 socket 已销毁等异常 */ }
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
      // 跨域场景下浏览器需 Access-Control-Allow-Methods 头才能正确处理 405 响应
      if (this.settings.cors) {
        res.set('Access-Control-Allow-Methods', allowed.join(', '));
      }
      res.set('Allow', allowed.join(', ')).status(405).json({ error: 'Method Not Allowed', status: 405 });
    } else {
      // 其他未知方法返回 404
      res.status(404).json({ error: 'Not Found', status: 404 });
    }
  }

  /**
   * 为所有跨域请求设置基础 CORS 响应头（Allow-Origin / Credentials / Vary）
   * 预检请求的额外头（Allow-Methods/Headers/Max-Age）在 _handleCORS 中处理
   * 修复：原实现仅处理 OPTIONS 预检，实际 GET/POST 请求无 CORS 头导致跨域读取失败
   */
  _applyCORSHeaders(req, res) {
    const cors = this.settings.cors;
    if (!cors) return;
    const reqOrigin = req.headers['origin'];
    let origin = '*';
    // origin 支持字符串、数组、函数：
    //   - 字符串：直接使用（'*' 或具体域名）
    //   - 数组：reqOrigin 在数组中才允许，否则拒绝（origin 置空，不设置 ACAO 头，浏览器会拒绝）
    //   - 函数：返回 false/''/null 表示拒绝；返回字符串表示使用该值；返回 true 表示使用 reqOrigin
    if (typeof cors.origin === 'string') {
      origin = cors.origin;
    } else if (Array.isArray(cors.origin)) {
      origin = (reqOrigin && cors.origin.includes(reqOrigin)) ? reqOrigin : '';
    } else if (typeof cors.origin === 'function') {
      // origin 函数可能因业务逻辑错误抛异常（如读取配置失败），CORS 是附加安全层不应阻断主请求
      // 异常时按拒绝跨域处理（origin 置空），记录告警日志便于运维排查
      let result;
      try {
        result = cors.origin(reqOrigin);
      } catch (e) {
        this._logger.warn('[CORS] origin 函数执行异常:', e.message);
        origin = '';
        result = false;
      }
      // 函数返回 false/''/null 表示拒绝跨域请求，origin 置空（不设置 ACAO 头，浏览器会拒绝）
      origin = result === false || result === null || result === '' ? '' : (result === true ? (reqOrigin || '') : String(result));
    }
    // credentials=true 时 origin 不能为 '*'（浏览器会拒绝），回退为具体来源
    if (cors.credentials && origin === '*') {
      origin = reqOrigin || '';
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      // 当 origin 为具体域名（非 *）时，追加 Vary: Origin
      // 使用 append 而非 setHeader，避免覆盖已设置的 Vary 头（如 Accept-Encoding）
      if (origin !== '*') {
        res.append('Vary', 'Origin');
      }
    }
    if (cors.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }

  /**
   * CORS 预检响应（动态查询该路径支持的 HTTP 方法）
   */
  _handleCORS(req, res) {
    const cors = this.settings.cors;
    if (!cors) {
      // 未配置 CORS 时，OPTIONS 仍需返回 Allow 头告知客户端支持的方法（RFC 7231）
      const allowed = this._getAllowedMethods(req.path);
      res.set('Allow', allowed.join(', ')).status(204)._send('');
      return;
    }
    // 基础 CORS 头（Allow-Origin/Credentials/Vary）已在 _handleRequest 中通过 _applyCORSHeaders 设置
    // 动态查找该路径匹配的所有 HTTP 方法
    const allowedMethods = this._getAllowedMethods(req.path);
    // 动态设置允许的方法列表，而非硬编码
    res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', cors.headers || 'Content-Type, Authorization');
    // maxAge 显式为 0 时禁用预检缓存（每次请求都预检），不能用 || 86400 覆盖
    const maxAge = parseInt(cors.maxAge, 10);
    res.setHeader('Access-Control-Max-Age', Number.isFinite(maxAge) ? maxAge : 86400);
    // Allow 头告知客户端该路径实际支持的方法
    res.setHeader('Allow', allowedMethods.join(', '));
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
    // 检查 ALL 中间件路由（任一命中即代表该路径支持所有方法，结果集相同无需 break）
    const allRoutes = this.routes['ALL'] || [];
    const allMatched = allRoutes.some(route => route.pattern.exec(pathname));
    if (allMatched) {
      ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].forEach(m => methods.add(m));
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
            // 传递错误回调，与 staticMiddleware 保持一致，避免 sendFile 异常冒泡
            // 传入完整 middlewareStack 而非空数组，确保用户注册的错误处理中间件能被正确调用
            res.sendFile(path.relative(rootPath, indexPath), { root: rootPath }, (err) => {
              if (err) this._handleError(err, req, res, this.middlewareStack, 0);
            });
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

      // 文件：发送（传递错误回调，与 staticMiddleware 保持一致）
      // 传入完整 middlewareStack 而非空数组，确保用户注册的错误处理中间件能被正确调用
      res.sendFile(requestPath, { root: rootPath }, (err) => {
        if (err) this._handleError(err, req, res, this.middlewareStack, 0);
      });
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
      // allowAccessToAllFiles=false 时过滤隐藏文件（.env、.git 等），与访问策略保持一致
      // 不重新赋值函数参数 entries，用新变量 filtered 提升可读性
      const filtered = this.settings.allowAccessToAllFiles
        ? entries
        : entries.filter(e => !e.name.startsWith('.'));

      // 异步获取文件信息，避免同步阻塞事件循环
      const tasks = filtered.map(entry => {
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
    // 末尾追加 '/' 与子目录链接保持一致（对齐 Express serve-static 行为）
    // 缺少尾部斜杠时浏览器可能多一次重定向往返
    if (requestPath && requestPath !== '/') {
      const parentHref = prefix + '../';
      html += `<tr><td><a href="${escapeHtml(parentHref)}" class="dir">../</a></td><td class="size">-</td><td>-</td></tr>`;
    }

    for (const item of items) {
      // 使用绝对路径 href，目录项追加尾部斜杠（对齐 Express serve-static 行为）
      // 缺少尾部斜杠时浏览器点击目录会多一次请求往返（先请求 /foo 再重定向到 /foo/）
      const href = prefix + (item.isDirectory ? item.name + '/' : item.name);
      const name = item.isDirectory ? item.name + '/' : item.name;
      const size = item.isDirectory ? '-' : fmtSize(item.size);
      const cls = item.isDirectory ? 'dir' : '';
      html += `<tr><td><a href="${escapeHtml(href)}" class="${cls}">${escapeHtml(name)}</a></td><td class="size">${size}</td><td class="size">${escapeHtml(item.modified)}</td></tr>`;
    }

    html += `</table></body></html>`;
    return html;
  }

  /**
   * 处理 WebSocket 升级请求
   */
  _handleUpgrade(incomingMessage, socket, head) {
    // 防御性检查：_wss 在 listen() 中初始化，正常流程不会为 null
    if (!this._wss) {
      this._logger.warn('WebSocket server not initialized (call listen() first)');
      socket.destroy();
      return;
    }
    // 校验 Upgrade 头必须为 websocket
    if (incomingMessage.headers['upgrade']?.toLowerCase() !== 'websocket') {
      this._logger.warn('Invalid upgrade header:', incomingMessage.headers['upgrade'], 'expected: websocket');
      socket.destroy();
      return;
    }
    // 包装为 httpm Request 实例，保持与普通路由 req 属性一致
    // WebSocket 升级请求绕过 _handleRequest，原生 req 是 http.IncomingMessage，
    // 缺少 query/cookies/ip/hostname/protocol/get 等便捷属性；
    // 包装后 handler(ws, req) 可像普通路由一样使用 req，API 行为一致
    // 注：底层 socket 通过 ws.socket 访问（符合 WebSocket 语义），req 不暴露 socket
    const req = new Request(incomingMessage);
    req._app = this;
    const parsed = parseUrl(incomingMessage.url);
    req.query = parsed.query;
    try {
      req.path = decodeURIComponent(parsed.pathname);
    } catch (e) {
      // 非法 URI 编码保留原始 pathname，避免抛异常中断握手
      req.path = parsed.pathname;
    }
    // Cookie 解析：与普通路由一致，尊重 useCookieParser 配置
    // WebSocket 升级请求常携带 Cookie 用于鉴权，解析后 handler 可直接用 req.cookies/signedCookies
    // 复用 cookieParser 中间件逻辑，确保签名验证行为与普通路由完全一致
    if (this.settings.useCookieParser !== false) {
      cookieParser(this.settings.cookieParserSecret)(req, null, () => {});
    }
    const ws = this._wss.handleUpgrade(req, socket, head);
    if (!ws) return;

    // 匹配 app.ws() 注册的处理器（支持动态参数路径）
    // _compilePath 始终返回 pattern，静态和动态路径均通过正则精确匹配
    if (this._wsHandlers && this._wsHandlers.length > 0) {
      // 使用已解码的 req.path 进行路由匹配，与 _handleRequest 行为一致
      // decoded pathname 确保动态参数提取正确（如 /chat/%E4%B8%AD → /chat/中文）
      const pathname = req.path;
      let matchedEntry = null;
      let params = {};
      for (const entry of this._wsHandlers) {
        const m = entry.pattern.exec(pathname);
        if (m) {
          matchedEntry = entry;
          params = this._extractParams(entry.params, m);
          break;
        }
      }
      if (matchedEntry) {
        // 将动态参数挂载到 req 上
        if (Object.keys(params).length > 0) {
          req.params = params;
        }
        // 捕获处理器异常，避免崩溃整个服务
        try {
          const ret = matchedEntry.handler(ws, req);
          // 支持 async handler：返回 Promise<cleanup> 时等待 resolve 后再注册清理函数
          // 同步 handler 返回函数时直接注册
          Promise.resolve(ret).then(cleanup => {
            if (typeof cleanup !== 'function') return;
            // 竞态保护：async handler resolve 前连接可能已关闭（close 事件已触发）
            // 此时 on('close') 注册的 cleanup 永不执行，需立即调用避免资源泄漏
            if (ws._closed) { try { cleanup(); } catch (e) { this._logger.warn('WS cleanup 执行异常:', e.message); } return; }
            ws.on('close', cleanup);
          }).catch(e => {
            this._logger.error('WebSocket async handler error:', e);
            ws.close(1011, 'Internal server error');
          });
        } catch (e) {
          this._logger.error('WebSocket handler error:', e);
          ws.close(1011, 'Internal server error');
        }
      } else {
        // 无匹配的 ws 路由：关闭连接避免孤儿连接
        this._logger.warn(`No ws handler matched: ${pathname}`);
        ws.close(1000, 'No handler');
        // 立即从连接池移除，避免依赖 close 事件异步清理的短暂内存占用
        this._wss._removeConnection(ws);
      }
    } else {
      // _wsHandlers 为空（未调用过 app.ws()）或为空数组时，handleUpgrade 已建立 WebSocket 连接
      // 但无处理器可执行，连接会成为孤儿连接直到心跳超时或客户端断开，造成资源泄漏
      // 显式关闭并从连接池移除，与"无匹配路由"分支行为一致
      this._logger.warn(`No ws handler registered for: ${parsed.pathname}`);
      ws.close(1000, 'No handler');
      this._wss._removeConnection(ws);
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
      const ret = handler(sseInstance, req);
      // 支持 async handler：返回 Promise<cleanup> 时等待 resolve 后再注册清理函数
      // 同步 handler 返回函数时直接注册
      Promise.resolve(ret).then(cleanup => {
        if (typeof cleanup !== 'function') return;
        // 竞态保护：async handler resolve 前连接可能已关闭（close 事件已触发）
        // 此时 on('close') 注册的 cleanup 永不执行，需立即调用避免资源泄漏
        if (!sseInstance.connected) { try { cleanup(); } catch (e) { this._logger.warn('SSE cleanup 执行异常:', e.message); } return; }
        res.on('close', cleanup);
      }).catch(e => {
        this._logger.error('SSE async handler error:', e);
        sseInstance.close();
      });
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
    // 直接 try/catch readFileSync，替代已废弃的 existsSync + readFileSync 双次调用
    // 文件不存在时 readFileSync 抛 ENOENT，由 catch 静默忽略，减少一次系统调用
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const config = JSON.parse(content);
      if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
        return config;
      }
    } catch (e) {
      // 文件不存在、读取失败或解析失败，静默忽略
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

  // 是否信任反向代理头（X-Forwarded-For/X-Forwarded-Host），默认 false 安全优先
  // 反向代理部署时设为 true 才能获取真实客户端 IP/主机名
  trustProxy: false,

  logLevel: 'info',
  logDir: './log',
  // 日志写入失败（磁盘满/权限等）时是否退出进程：false=仅控制台打印（默认），true=退出进程
  // 注：配置项名取最常见场景（磁盘满 disk full），实际任何写入错误都会触发退出
  exitOnDiskFull: false,

  cors: { origin: '*', headers: 'Content-Type, Authorization', maxAge: 86400, credentials: false },

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
 *
 * 配置优先级（从低到高）：默认配置 < app.json < 代码参数 < app.set() 运行时配置
 *
 * @param {object} [options] - 初始化配置项（详见 defaultConfig）
 * @param {number} [options.svrPort=80] - 监听端口，0 表示随机分配
 * @param {string} [options.rootPath] - 静态文件根目录（默认 process.cwd()）
 * @param {string} [options.logLevel='info'] - 日志级别 debug/info/notice/warn/error/fatal
 * @param {string} [options.logDir='./log'] - 日志目录
 * @param {boolean} [options.exitOnDiskFull=false] - 磁盘满时是否退出进程
 * @param {object} [options.cors] - CORS 配置 { origin, headers, maxAge, credentials }
 * @param {boolean} [options.useBodyParser=true] - 是否自动注册 bodyParser 中间件
 * @param {boolean} [options.useCookieParser=true] - 是否自动注册 cookieParser 中间件
 * @param {object} [options.bodyParserOptions] - bodyParser 选项 { maxBodySize, maxFieldSize, maxFileSize }（字节单位）
 * @param {string} [options.cookieParserSecret] - cookie 签名密钥（null = 不签名）
 * @param {number} [options.wsHeartbeatInterval=30000] - WebSocket 心跳间隔（ms）
 * @param {number} [options.wsHeartbeatTimeout=30000] - WebSocket 心跳超时（ms）
 * @param {boolean} [options.showDir=false] - 是否允许显示目录列表
 * @param {boolean} [options.enableRange=true] - 是否启用 Range 断点续传
 * @param {boolean} [options.trustProxy=false] - 是否信任 X-Forwarded-* 代理头
 * @param {boolean} [options.http2=false] - 是否启用 HTTP/2 协议
 * @param {object} [options.https] - HTTPS 配置 { key, cert }（启用 HTTPS）
 * @returns {Application} Application 实例
 *
 * @example
 * const app = httpm({ svrPort: 3000, logLevel: 'debug' });
 * app.get('/', (req, res) => res.send('Hello World'));
 * app.listen(3000);
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
 *
 * @param {string} rootPath - 静态文件根目录（绝对路径或相对 cwd 的路径）
 * @param {Object} [options]
 * @param {boolean} [options.allowAccessToAllFiles=false]
 *   是否允许访问所有文件（含 .env、.git 等隐藏文件/目录）。
 *   - false（默认）：拒绝路径中任何以 `.` 开头的段（隐藏文件与隐藏目录），防泄漏敏感配置
 *   - true：仅做路径遍历校验，不限制隐藏文件，适用于需要分发点文件（如 .well-known）的场景
 *   注意：Content-Type 由 sendFile 根据扩展名自动识别，本中间件不透传 contentType 选项
 * @returns {Function} 中间件函数 (req, res, next) => void
 *   - 仅处理 GET/HEAD 请求，其他方法直接 next()
 *   - 路径不安全、文件不存在、目录无 index.html 时调用 next() 交由后续中间件/路由处理
 *   - sendFile 出错时通过回调捕获并调用 next(err) 进入错误处理链，避免异常冒泡
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
            // sendFile 内部错误用回调捕获，避免同步异常冒泡到中间件链
            res.sendFile(path.relative(root, indexPath), { root }, (err) => {
              if (err) return next(err);
            });
            return;
          }
          return next();
        });
        return;
      }
      // sendFile 内部错误用回调捕获，避免同步异常冒泡到中间件链
      res.sendFile(requestPath, { root }, (err) => {
        if (err) return next(err);
      });
    });
  };
}
httpm.static = staticMiddleware;

// 导出工具函数
httpm.parseUrl = parseUrl;
httpm.parseCookies = parseCookies;
httpm.getMimeType = getMimeType;
httpm.parseQuery = parseQuery;
httpm.fmtSize = fmtSize;
httpm.fmtTime = fmtTime;
httpm.isPathSafe = isPathSafe;
httpm.generateETag = generateETag;
httpm.parseRange = parseRange;
httpm.WebSocketHandshake = WebSocketHandshake;
// 旧名保留，向后兼容（deprecated）
httpm.WebSocketHandShak = WebSocketHandshake;
httpm.escapeHtml = escapeHtml;
httpm.version = '1.5.9';


module.exports = httpm;
