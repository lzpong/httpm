# httpm 项目详细设计文档

## 1. 项目概述

### 1.1 设计目标
httpm 是一个**单文件、零依赖**的 Node.js HTTP 服务器库，核心设计原则：
- **单文件架构**：所有功能集成在 `httpm.js` 中
- **零依赖**：仅依赖 Node.js 原生模块（http, https, fs, path, crypto, zlib）
- **Express 兼容**：提供与 Express 框架兼容的 API
- **功能完备**：HTTP/HTTPS、WebSocket、SSE、中间件、文件上传下载

### 1.2 核心特性
| 特性 | 说明 |
|------|------|
| HTTP/HTTPS | 原生 Node.js 服务器，支持 HTTP/2 |
| 路由系统 | 静态路由 + 动态参数路由 `/users/:id` |
| 中间件 | Express 风格线性执行 |
| 静态文件 | Range 断点续传、缓存、Gzip |
| 文件上传 | multipart/form-data 流式解析，临时文件管理，自动进度显示 |
| 文件下载 | Range 支持，大文件自动显示进度条（>1MB） |
| WebSocket | RFC 6455 标准，路径分组，统一心跳 |
| SSE | Server-Sent Events，简化 API |
| 日志系统 | 彩色控制台 + 文件日志 |

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                        httpm.js                         │
├─────────────────────────────────────────────────────────┤
│  导出接口                                               │
│  - httpm() / Application / Router / Request / Response  │
│  - WebSocket / WebSocketServer / SSE / Logger           │
│  - bodyParser / cookieParser / static                   │
├─────────────────────────────────────────────────────────┤
│  核心类                                                 │
│  Application → Router → 请求处理 → 默认处理             │
│  Request/Response/SSE/WebSocket/WebSocketServer/Logger  │
├─────────────────────────────────────────────────────────┤
│  工具函数                                               │
│  parseUrl/parseQuery/parseCookies/getMimeType           │
│  fmtTime/fmtSize/isPathSafe/generateETag/parseRange     │
└─────────────────────────────────────────────────────────┘
```

### 2.2 请求处理流程

```
HTTP 请求
    │
    ├─ URL 解析 (query + path)
    ├─ Cookie 解析
    ├─ Body 解析 (根据 Content-Type)
    │   ├─ application/json          → JSON.parse
    │   ├─ application/x-www-form... → querystring.parse
    │   ├─ multipart/form-data       → 流式解析，写入临时文件
    │   └─ 其他                      → Buffer
    │
    ├─ 路由匹配（动态路由优先）
    │   ├─ 匹配成功 → 执行中间件链 → 执行路由处理器
    │   │   ├─ 返回 false → 继续默认处理
    │   │   └─ 正常返回   → 响应发送
    │   └─ 匹配失败 → 默认处理
    │                   ├─ GET/HEAD → 静态文件服务
    │                   ├─ OPTIONS → CORS 预检响应
    │                   └─ 其他方法 → 404/405
    │
    └─ 响应发送 (res.json/send/sendFile/download)
```

---

## 3. 核心类设计

### 3.1 Application 类

**职责**：主应用类，管理配置、中间件、路由和服务器生命周期。

**继承关系**：`Application extends Router`

```javascript
class Application extends Router {
  constructor(options = {}) {
    super();
    this.settings = {};          // 配置对象
    this.middlewareStack = [];   // 中间件栈
    this.server = null;          // HTTP/HTTPS 服务器
  }
}
```

**核心方法**：
| 方法 | 说明 |
|------|------|
| `app.set(name, value)` | 设置配置 |
| `app.use(path?, middleware)` | 注册中间件 |
| `app.METHOD(path, handler)` | 注册路由（继承自 Router） |
| `app.listen(port, callback)` | 启动服务器 |
| `app.close(callback)` | 关闭服务器 |

**路由返回值机制**：
- 路由处理器返回 `false` 时，继续执行默认处理（静态文件服务）
- 用于实现"动态路由优先，静态文件兜底"的逻辑

```javascript
app.get('/api/users/:id', (req, res) => {
  if (!userExists(req.params.id)) {
    return false;  // 继续执行默认处理（静态文件服务）
  }
  res.json({ user: getUser(req.params.id) });
});
```

### 3.2 Router 类

**职责**：路由管理，包括路由注册、匹配和参数提取。

**核心属性**：
```javascript
class Router {
  constructor() {
    this.routes = { GET: [], POST: [], PUT: [], DELETE: [], PATCH: [], ALL: [] };
    this.middlewareStack = [];
  }
}
```

**路由对象结构**：
```javascript
{
  method: 'GET',
  path: '/users/:id',
  pattern: /^\/users\/([^/]+)$/,  // 编译后的正则
  params: ['id'],                 // 参数名数组
  handlers: [handler]             // 处理器数组
}
```

**动态路由实现**：
```javascript
// 输入: '/users/:id/posts/:postId'
// 输出: { pattern: /^\/users\/([^/]+)\/posts\/([^/]+)$/, params: ['id', 'postId'] }
compile(path) {
  const params = [];
  const pattern = path.replace(/:([^/]+)/g, (_, param) => {
    params.push(param);
    return '([^/]+)';
  });
  return { pattern: new RegExp('^' + pattern + '$'), params };
}
```

### 3.3 Request 类

**职责**：封装 HTTP 请求，提供便捷的属性和方法。

**核心属性**：
```javascript
class Request {
  constructor(incomingMessage) {
    this._req = incomingMessage;
    this.query = {};      // URL 查询参数
    this.params = {};     // 路由参数
    this.body = null;     // 请求体（解析后）
    this.cookies = {};    // Cookie 对象
    this.files = [];      // 上传文件数组（向后兼容）
    this.path = '';       // 解码后的路径（不含查询参数）
    this.formData = {     // 请求数据统一接口
      fields: {},         // 合并 query + body（body 优先）
      files: []           // 上传文件数组
    };
    this._tempFiles = []; // 临时文件列表表（响应后自动清理）
  }
}
```

**便捷属性**：
```javascript
req.method      // HTTP 方法
req.url         // 原始 URL
req.headers     // 请求头
req.ip          // 客户端 IP
req.hostname    // 主机名
req.protocol    // 协议（http/https）
```

### 3.4 Response 类

**职责**：封装 HTTP 响应，提供便捷的响应方法。

```javascript
class Response {
  req;             // 关联的 Request 对象
  statusCode = 200;
  setHeader(name, value)      // 设置响应头
  getHeader(name)             // 获取响应头

  // 核心方法
  status(code)                // 设置状态码
  json(data)                  // 发送 JSON
  send(data)                  // 发送文本/HTML/Buffer
  sendFile(path, options)     // 发送文件（Range/缓存/Gzip）
  download(path, filename)    // 触发下载
  redirect(url, code)         // 重定向
  sse()                       // 返回 SSE 实例
  cookie(name, value, opts)   // 设置 Cookie
}
```

**res.sendFile 实现要点**：
```javascript
sendFile(filePath, options = {}) {
  // 自动进度显示：文件 > 1MB 自动显示进度条
  const showProgress = options.showProgress === true || 
                       (options.showProgress !== false && stats.size > 1024 * 1024);
  // 1. Range 支持（断点续传）
  if (req.headers.range && config.enableRange !== false) {
    // 返回 206 Partial Content
  }
  
  // 2. 缓存检查（ETag + Last-Modified）
  if (config.enableCache && etag匹配) {
    return res.status(304).end();
  }
  
  // 3. Gzip 压缩（文本文件）
  if (config.enableGzip && shouldCompress(filePath, req)) {
    return fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
  }
  
  // 4. 常规发送
  fs.createReadStream(filePath).pipe(res);
}
```

### 3.5 SSE 类

**职责**：实现 Server-Sent Events 协议。
```javascript
class SSE {
  constructor(res, req) {
    this.res = res;
    this.connected = true;
    // 自动设置 SSE 响应头
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.write('\n');
  }
  
  send(data)          // 发送消息（支持字符串/JSON对象）
  event(name, data)   // 发送命名事件
  retry(ms)           // 设置重连时间
  comment(text)       // 发送注释（心跳）
  close()             // 关闭连接
}
```

**简化使用方式**：
```javascript
app.sse('/events', (sse, req) => {
  sse.send('Connected');
  const timer = setInterval(() => sse.event('time', new Date().toISOString()), 1000);
  return () => clearInterval(timer);  // 清理函数
});
```

### 3.6 WebSocket 类

**职责**：实现 WebSocket 协议（RFC 6455）。
**核心属性**：
```javascript
class WebSocket {
  socket;         // 原始 socket
  path;           // WebSocket 路径
  id;             // 唯一标识
  readyState;     // 连接状态
  _lastPong;      // 上次 pong 时间（心跳检测）
  
  send(data) {    // 自动识别类型：字符串/JSON对象/Buffer
    const opcode = Buffer.isBuffer(data) ? 2 : 1;  // 2=binary, 1=text
    if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      data = JSON.stringify(data);
    }
  }
}
```

**WebSocketServer 统一心跳**：
```javascript
class WebSocketServer {
  sockets = {};      // 所有连接
  pathGroups = {};   // 按路径分组
  _heartbeatTimer;   // 统一心跳定时器
  
  add(ws) {
    this.sockets[ws.id] = ws;
    this._startHeartbeat();  // 有连接时自动开启
  }
  
  remove(ws) {
    delete this.sockets[ws.id];
    if (Object.keys(this.sockets).length === 0) {
      this._stopHeartbeat();  // 无连接时自动停止
    }
  }
  
  broadcast(path, message, excludeId) { /* 按路径广播 */ }
  broadcastAll(message, excludeId) { /* 全局广播 */ }
}
```


### 3.7 Logger 类

**职责**：日志记录，支持彩色控制台输出和文件存储。

**日志级别**：`debug < info < notice < warn < error`

```javascript
class Logger {
  name;    // 日志文件名前缀
  styles = {
    debug: '\x1b[1;30m',  // 灰色
    info: '\x1b[1;37m',   // 白色
    notice: '\x1b[1;35m', // 品红
    warn: '\x1b[1;33m',   // 黄色
    error: '\x1b[1;31m'   // 红色
  };
  
  log(level, ...args) {
    // 控制台：彩色输出
    // 文件：./log/YYYY/MM/name_DD.log
  }
}
// 日志记录示例
// [23:56:50] [ERROR ] test log
```

---

## 4. 中间件系统

### 4.1 执行流程

```javascript
// 中间件签名
function middleware(req, res, next) {
  // 前置处理
  next();  // 调用下一个中间件
  // 后置处理（可选）
}

// 线性执行：middleware1 → middleware2 → routeHandler
```

### 4.2 中间件类型

| 类型 | 注册方式 | 说明 |
|------|---------|------|
| 应用级 | `app.use(fn)` | 所有请求 |
| 路径级 | `app.use('/api', fn)` | 特定路径前缀 |
| 错误处理 | `app.use((err, req, res, next) => {})` | 四个参数 |

### 4.3 内置中间件

**bodyParser**：
```javascript
function bodyParser(options = {}) {
  return function(req, res, next) {
    const contentType = req.headers['content-type'];
    
    // 初始化 formData
    req.formData = { fields: { ...req.query }, files: [] };
    req._tempFiles = [];
    
    if (contentType?.includes('application/json')) {
      req.body = JSON.parse(buffer);
    } else if (contentType?.includes('multipart/form-data')) {
      // 流式解析，写入临时文件
      const parser = new StreamingMultipartParser(contentType, req, options);
    }
    
    // 响应完成后自动清理临时文件
    res.on('finish', () => cleanupTempFiles(req._tempFiles));
    next();
  };
}
```

**cookieParser**：
```javascript
function cookieParser(secret) {
  return function(req, res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    next();
  };
}
```

---

## 5. 配置管理

### 5.1 配置加载优先级

```
默认配置 → 配置文件(app.json) → 代码参数 → 运行时设置
```

### 5.2 默认配置

```javascript
const defaultConfig = {
  // 服务器配置
  rootPath: process.cwd(),        // 静态文件根目录
  tempDir: 'tempupdir',           // 上传临时目录
  maxFileSize: 128 * 1024 * 1024, // 上传文件限制 (128MB)
  maxFieldSize: 1024 * 1024,      // 表单字段限制 (1MB)
  svrPort: 80,                    // 监听端口
  svrIP: null,                    // 监听地址（null = 所有接口）
  
  // 功能开关
  showDir: false,                 // 显示目录列表
  enableCache: false,             // 启用文件缓存
  enableGzip: false,              // 启用 Gzip 压缩
  enableRange: true,              // 启用 Range 支持（默认开启）
  cacheControl: 'public, max-age=3600',
  
  // 超时配置
  timeout: 120000,
  keepAliveTimeout: 65000,
  
  // HTTPS/HTTP2
  https: null,                    // { key: 路径或Buffer, cert: 路径或Buffer }
  http2: false,                   // 启用 HTTP/2
  
  // 日志
  logLevel: 'info',
  logDir: './log',
  
  // CORS
  cors: { origin: '*', headers: 'Content-Type, Authorization', maxAge: '86400' },
  
  // 中间件
  useBodyParser: true,
  useCookieParser: true,
  bodyParserOptions: {},
  cookieParserSecret: null,
  
  // WebSocket 心跳
  wsHeartbeatInterval: 30000,     // Ping 间隔（毫秒）
  wsHeartbeatTimeout: 30000       // 超时时间（距离上次 pong）
};
```

---

## 6. 文件服务

### 6.1 默认处理优先级

```
请求路径: /path/to/resource  (路径安全检查)
    ↓
1. 动态路由匹配 → 匹配成功 → 执行路由处理器
    ↓ 匹配失败
2. 静态文件服务 (GET/HEAD)
    ├─ 文件存在 → 发送文件（Range/缓存/Gzip）
    ├─ 目录存在 → index.html 或目录列表
    └─ 不存在 → 404 Not Found
    ↓
3. OPTIONS → CORS 预检响应
4. 其他方法 → 405 Method Not Allowed
```

### 6.2 路径安全检查

```javascript
function isPathSafe(requestPath, rootPath) {
  const absolutePath = path.resolve(rootPath, requestPath);
  const relativePath = path.relative(path.resolve(rootPath), absolutePath);
  
  // 检查路径遍历攻击/是否跳出 rootPath
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }
  
  // 检查隐藏文件
  if (relativePath.split(path.sep).some(part => part.startsWith('.'))) {
    return false;
  }
  
  return true;
}
```

### 6.3 Range 支持（断点续传）

```javascript
function parseRange(rangeHeader, fileSize) {
  // Range: bytes=0-499
  const bytes = rangeHeader.replace('bytes=', '').split(',');
  return bytes.map(byte => {
    const [start, end] = byte.trim().split('-');
    return {
      start: parseInt(start) || 0,
      end: parseInt(end) || fileSize - 1
    };
  }).filter(r => r.start <= r.end && r.start < fileSize);
}

// 响应：206 Partial Content
// Content-Length: 500
// Content-Range: bytes 0-499/10000
```

### 6.4 缓存机制

```javascript
function generateETag(stats) {
  return `W/"${stats.size}-${stats.mtime.getTime().toString(16)}"`;
}

// 缓存检查优先级
if (req.headers['if-none-match'] === etag) return 304;
if (req.headers['if-modified-since'] === lastModified) return 304;
```

### 6.5 Gzip 压缩

```javascript
const compressibleTypes = ['html', 'css', 'js', 'json', 'xml', 'txt', 'svg'];
if (config.enableGzip && compressibleTypes.includes(ext) && 
    req.headers['accept-encoding']?.includes('gzip')) {
  res.setHeader('Content-Encoding', 'gzip');
  fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
}
```

---

## 7. 文件上传

### 7.1 StreamingMultipartParser

**核心特点**：
- 边接收边写入文件，**不占用内存**
- 支持**多客户端同时上传大文件**
- 自动大小限制检查

```javascript
class StreamingMultipartParser {
  constructor(contentType, req, options = {}) {
    this.tempDir = options.tempDir || 'tempupdir';
    this.maxFileSize = options.maxFileSize || 128 * 1024 * 1024;
    this.maxFieldSize = options.maxFieldSize || 1024 * 1024;
    this.state = 'PREAMBLE';  // PREAMBLE → HEADER → DATA → DONE
    this.fileStream = null;   // 当前文件写入流
  }
  
  write(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 状态机处理...
  }
}
```

**内存对比**：
| 场景 | 缓冲方式 | 流式方式 |
|------|---------|---------|
| 单个 100MB 文件 | ~100MB | ~几KB |
| 10 个客户端同时上传 100MB | ~1GB | ~几十KB |

### 7.2 临时文件管理

**流程**：
```
1. 解析 multipart 数据 → 发现文件 part
2. 生成临时文件名: {timestamp}_{random}_{originalname}
3. 立即写入临时文件（不保存到内存）
4. 创建 fileInfo: { fieldname, originalname, size, path }
5. 添加到 req.formData.files
6. 路由 handler 从 file.path 读取文件
7. 响应完成后，res.on('finish') 触发清理,自动删除临时文件
```

**formData 统一访问**：
```javascript
// POST /upload?userId=123
// Content-Type: multipart/form-data
req.formData = {
  fields: { userId: '123', title: '...' },  // query + body 合并
  files: [{ fieldname: 'file', originalname: 'photo.jpg', path: '/temp/...' }]
};
```

### 7.3 进度显示

**大文件自动显示进度条（>1MB）**：
- 文件名背景色显示进度（白色=已完成，灰色=剩余）
- 显示：百分比、速度、时间
- 200ms周期 和 完成 更新显示

```javascript
function showProgress(prog) {
  const percent = Math.floor(prog.pos / prog.flength * 100);
  const progressPos = Math.floor(percent * name.length / 100);
  const displayName = p0 + name.slice(0, progressPos) + p1 + name.slice(progressPos);
  process.stdout.write(`\r${displayName} ${fmtSize(pos)}/${fmtSize(total)} ${percent}% Time:${time} Speed:${speed}`);
}
```

---

## 8. 工具函数

### 8.1 URL/查询参数解析

```javascript
function parseUrl(urlStr) {
  const queryIndex = urlStr.indexOf('?');
  return {
    path: decodeURI(queryIndex >= 0 ? urlStr.substring(0, queryIndex) : urlStr),
    query: queryIndex >= 0 ? Object.fromEntries(new URLSearchParams(urlStr.substring(queryIndex + 1))) : {}
  };
}
```

### 8.2 MIME 类型

```javascript
const mimeTypes = {
  'html': 'text/html; charset=utf-8',
  'css': 'text/css; charset=utf-8',
  'js': 'application/javascript; charset=utf-8',
  'json': 'application/json; charset=utf-8',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'pdf': 'application/pdf',
  'txt': 'text/plan',
  'default': 'application/octet-stream'
};
```

### 8.3 格式化函数

```javascript
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function fmtTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}
```

---

## 9. 错误处理

### 9.1 错误处理中间件

```javascript
// 四个参数的中间件自动识别为错误处理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message });
});
```

### 9.2 错误传播

```javascript
// 同步错误：自动捕获
// 异步错误：传递给 next(err)
app.get('/async', async (req, res, next) => {
  try {
    const data = await fetchData();
    res.json(data);
  } catch (err) {
    next(err);  // 传递给错误处理中间件
  }
});
```

---

## 10. 导出接口

```javascript
module.exports = Object.assign(httpm, {
  // 类
  Application,
  Router,
  Request,
  Response,
  SSE,
  WebSocket,
  WebSocketServer,
  Logger,
  
  // 函数
  WebSocketHandShark,
  
  // 中间件
  bodyParser,
  cookieParser,
  static,
  
  // 工具函数
  parseUrl,
  parseQuery,
  parseCookies,
  getMimeType,
  fmtSize,
  fmtTime,
  isPathSafe,
  generateETag,
  parseRange
});
```

---

## 11. 使用示例

### 11.1 基础服务器

```javascript
const httpm = require('./httpm');

const app = httpm({ rootPath: './public', showDir: true, enableRange: true });

// 中间件
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// 动态路由
app.get('/api/users/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return false;  // 继续默认处理
  res.json(user);
});

// SSE
app.sse('/events', (sse, req) => {
  const timer = setInterval(() => sse.event('time', new Date().toISOString()), 1000);
  return () => clearInterval(timer);
});

// WebSocket
app.ws('/chat', (ws, req) => {
  ws.on('text', msg => app.wsServer.broadcast('/chat', { from: ws.id, msg }));
});

app.listen(3000);
```

### 11.2 文件上传

```javascript
app.post('/upload', (req, res) => {
  const { fields, files } = req.formData;
  
  if (files.length > 0) {
    const file = files[0];
    // 从 file.path 读取临时文件
    const targetPath = path.join('./uploads', file.originalname);
    fs.copyFileSync(file.path, targetPath);
  }
  
  res.json({ success: true, fields });
  // 响应完成后，临时文件自动删除
});
```

### 11.3 WebSocket 聊天室

```javascript
app.ws('/chat', (ws, req) => {
  ws.send({ type: 'welcome', id: ws.id });
  
  ws.on('text', msg => {
    app.wsServer.broadcast('/chat', { userId: ws.id, content: msg }, ws.id);
  });
  
  return () => console.log('Cleanup');
});
```

---

## 12. 测试与发布

### 12.1 测试

```bash
node test/test.js  # 运行测试
node examples/basic.js  # 运行示例
```

### 10.2 package.json

```json
{
  "name": "httpm",
  "version": "1.0.1",
  "main": "httpm.js",
  "keywords": ["http", "server", "websocket", "sse", "middleware", "single-file"],
  "engines": { "node": ">=10.0.0" },
  "license": "MIT"
}
```

---

## 13. 总结

httpm 核心设计理念：

| 原则 | 说明 |
|------|------|
| 单文件架构 | 所有功能集成在一个文件，便于分发和使用 |
| 零依赖 | 仅依赖 Node.js 原生模块 |
| Express 兼容 | 降低学习成本和迁移难度 |
| 模块化设计 | 内部结构清晰，职责分明 |
| 可扩展性 | 支持中间件、扩展点 |

**关键实现亮点**：
- 流式 multipart 解析：大文件上传不占用内存
- 统一心跳检测：单一 timer，按需启停
- 路径安全检查：防止路径遍历攻击
- Range 支持：断点续传、分段下载
- 进度显示：大文件自动显示进度条
