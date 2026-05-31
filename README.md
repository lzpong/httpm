# httpm

基于 Node.js 原生模块的**单文件、零依赖** HTTP 服务库，兼容 Express API。

## 特性

- **单文件架构** — 所有代码整合至 `httpm.js`，拷贝即用
- **零第三方依赖** — 仅使用 Node.js 内置模块（`http`、`https`、`fs`、`path`、`crypto`、`zlib`）
- **Express 兼容** — 路由、中间件、请求/响应 API 对齐 Express 语法
- **静态文件服务** — Range 断点续传、ETag/Last-Modified 缓存、Gzip 压缩
- **WebSocket** — 路径分组、心跳保活、广播、文本/二进制子事件、分片帧支持、动态参数路由
- **SSE** — 服务端推送事件，支持 event/data/retry/comment
- **流式文件上传** — multipart/form-data 解析，内存零占用，临时文件自动清理
- **日志系统** — 彩色控制台输出 + 文件持久化，按级别过滤
- **Cookie 签名** — HMAC-SHA256 签名与验证
- **配置管理** — 默认配置 → app.json → 代码参数 → 运行时 app.set()

## 安装

```bash
npm install @lzpong/httpm
```

或直接拷贝 `httpm.js` 到项目中：

```javascript
const httpm = require('./httpm');
```

## 快速开始

```javascript
const httpm = require('@lzpong/httpm');
const app = httpm({ rootPath: './public', svrPort: 3000 });

// 全局中间件
app.use((req, res, next) => {
  console.log(req.method, req.path);
  next();
});

// 路由
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello, httpm!' });
});

// 动态路由
app.get('/api/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

## 路由

支持 GET、POST、PUT、DELETE、PATCH、ALL 方法：

```javascript
app.get('/users', (req, res) => res.json([]));
app.post('/users', (req, res) => res.json(req.body));
app.put('/users/:id', (req, res) => res.json({ id: req.params.id }));
app.delete('/users/:id', (req, res) => res.json({ deleted: true }));
app.all('/any', (req, res) => res.json({ method: req.method }));
```

路由匹配优先级：精准静态路由 > 动态参数路由 > ALL 通用路由 > 静态文件服务。

路由处理器返回 `false` 时，请求进入静态文件兜底：

```javascript
app.get('/api/users/:id', (req, res) => {
  const user = findUser(req.params.id);
  if (!user) return false; // 跳转至静态文件服务
  res.json(user);
});
```

## 中间件

### 应用级中间件

```javascript
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});
```

### 路径级中间件

```javascript
app.use('/api', (req, res, next) => {
  // 仅匹配 /api 及其子路径
  next();
});
```

### 错误处理中间件

4 个参数的函数自动识别为错误处理中间件：

```javascript
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});
```

## 请求对象 (req)

| 属性/方法 | 说明 |
|-----------|------|
| `req.method` | 请求方法 |
| `req.path` | 请求路径 |
| `req.url` | 完整请求 URL |
| `req.query` | Query 参数对象 |
| `req.params` | 路由参数对象 |
| `req.body` | 请求体（JSON/URL-encoded 自动解析） |
| `req.formData` | 表单数据（multipart 解析后） |
| `req.cookies` | Cookie 对象 |
| `req.headers` | 请求头对象 |
| `req.ip` | 客户端 IP |
| `req.protocol` | 协议（http/https） |
| `req.get(name)` | 获取请求头 |

## 响应对象 (res)

| 方法 | 说明 |
|------|------|
| `res.status(code)` | 设置状态码，链式调用 |
| `res.json(obj)` | 发送 JSON 响应 |
| `res.send(data)` | 发送响应（自动识别类型） |
| `res.sendFile(path, opts)` | 发送文件 |
| `res.download(path, name)` | 下载文件 |
| `res.redirect([code,] url)` | 重定向，兼容 Express 签名：`redirect(url)` 默认 302，`redirect(status, url)` 指定状态码 |
| `res.cookie(name, value, opts)` | 设置 Cookie |
| `res.clearCookie(name, opts)` | 清除 Cookie |
| `res.set(name, value)` / `res.setHeader()` | 设置响应头 |
| `res.get(name)` / `res.getHeader()` | 获取响应头 |
| `res.type(type)` | 设置 Content-Type |
| `res.sse()` | 创建 SSE 实例 |

### Cookie 签名

```javascript
const app = httpm({ cookieParserSecret: 'your-secret' });

// 设置签名 Cookie
res.cookie('token', 'abc123', { signed: true });

// 读取时自动验证签名
req.cookies.token; // 'abc123'（签名验证通过）
```

## 静态文件服务

```javascript
const app = httpm({ rootPath: './public', showDir: true, enableGzip: true, enableCache: true });
```

或使用内置中间件（支持目录自动查找 index.html）：

```javascript
app.use(httpm.static('./public'));
// 允许访问隐藏文件
app.use(httpm.static('./public', { allowAccessToAllFiles: true }));
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `rootPath` | `process.cwd()` | 静态文件根目录 |
| `showDir` | `false` | 是否显示目录列表 |
| `enableGzip` | `false` | 启用 Gzip 压缩 |
| `enableCache` | `false` | 启用 ETag/Last-Modified 缓存 |
| `enableRange` | `true` | 启用 Range 断点续传 |
| `cacheControl` | `'public, max-age=3600'` | Cache-Control 头值 |

## 文件上传

```javascript
app.post('/upload', (req, res) => {
  const { fields, files } = req.formData;
  console.log(fields); // { field1: 'value1' }
  console.log(files);  // [{ originalname, path, size, mimetype }]
  res.json({ success: true });
  // 临时文件在响应结束后自动清理
});
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `tempDir` | `'tempupdir'` | 临时文件目录 |
| `maxFileSize` | `128MB` | 单文件大小限制 |
| `maxFieldSize` | `1MB` | 表单字段大小限制 |

## WebSocket

### 简化注册

```javascript
app.ws('/chat', (ws, req) => {
  ws.send('Welcome!');

  ws.on('text', msg => {
    app.wsServer.broadcast('/chat', msg, ws.id);
  });

  ws.on('binary', data => {
    // 处理二进制数据
  });

  ws.on('close', (code, reason) => {
    console.log('Client disconnected', code, reason);
  });
});
```

### WebSocketServer API

```javascript
const wss = app.wsServer;

wss.broadcast('/chat', 'Hello everyone');         // 按路径分组广播
wss.broadcast('/chat', 'Hello', excludeWsId);     // 排除指定连接
wss.getConnections();                              // 获取所有连接
```

### WebSocket 事件

| 事件 | 说明 |
|------|------|
| `data` | 接收消息（`{ type: 'text'/'binary', data }`） |
| `text` | 接收文本消息 |
| `binary` | 接收二进制消息 |
| `close` | 连接关闭，回调参数 `(code, reason)` |
| `error` | 连接错误 |

### data 事件使用

```javascript
ws.on('data', (msg) => {
  console.log(msg.type);   // 'text' 或 'binary'
  console.log(msg.data);   // 消息内容
});
```

## SSE (Server-Sent Events)

### 简化注册

```javascript
app.sse('/events', (sse, req) => {
  const timer = setInterval(() => {
    sse.event('time', new Date().toISOString());
  }, 1000);

  // 返回清理函数，连接关闭时自动执行
  return () => clearInterval(timer);
});
```

### SSE API

```javascript
const sse = res.sse();

sse.send(data);              // 发送 data 事件
sse.event(name, data);       // 发送命名事件
sse.retry(milliseconds);     // 设置重连间隔
sse.comment(text);           // 发送注释（心跳保活）
sse.close();                 // 关闭连接
```

## 日志系统

```javascript
const app = httpm({ logLevel: 'debug', logDir: './logs' });

// 使用 Application 内置 Logger
app._logger.info('Server started');
app._logger.error('Something went wrong', err);
```

### 独立使用

```javascript
const { Logger } = require('@lzpong/httpm');

const logger = new Logger({ level: 'debug', logDir: './logs', name: 'myapp' });
logger.debug('Debug message');
logger.info('Info message');
logger.notice('Notice message');
logger.warn('Warning message');
logger.error('Error message');
logger.fatal('Fatal message');
```

| 日志级别 | 颜色 | 说明 |
|----------|------|------|
| `debug` | 灰色 | 调试信息 |
| `info` | 白色 | 常规信息 |
| `notice` | 品红 | 通知信息 |
| `warn` | 黄色 | 警告信息 |
| `error` | 红色 | 错误信息 |
| `fatal` | 红色加粗 | 致命错误 |

日志文件路径格式：`./logDir/YYYY/MM/name_DD.log`，时间格式：`HH:MM:SS`。

## 配置管理

配置加载优先级（后者覆盖前者）：

1. **默认配置** — 内置默认值
2. **app.json** — 项目根目录或模块目录下的配置文件
3. **代码初始化参数** — `httpm({ ... })` 传入的选项
4. **运行时 app.set()** — 动态设置

```javascript
// app.json
{
  "svrPort": 8080,
  "enableGzip": true
}

// 代码参数覆盖 app.json
const app = httpm({ svrPort: 3000 }); // svrPort=3000, enableGzip=true(来自app.json)
```

### 完整配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `rootPath` | `process.cwd()` | 静态文件根目录 |
| `tempDir` | `'tempupdir'` | 上传临时文件目录 |
| `maxFileSize` | `134217728` | 单文件大小限制（128MB） |
| `maxFieldSize` | `1048576` | 表单字段大小限制（1MB） |
| `maxBodySize` | `134217728` | 请求体大小限制（128MB） |
| `svrPort` | `80` | 服务端口 |
| `svrIP` | `null` | 绑定 IP（null=所有接口） |
| `showDir` | `false` | 显示目录列表 |
| `allowAccessToAllFiles` | `false` | 允许访问隐藏文件（.env、.git 等） |
| `enableCache` | `false` | 启用缓存 |
| `enableGzip` | `false` | 启用 Gzip 压缩 |
| `enableRange` | `true` | 启用断点续传 |
| `cacheControl` | `'public, max-age=3600'` | Cache-Control 头 |
| `timeout` | `120000` | 请求超时（ms） |
| `keepAliveTimeout` | `65000` | Keep-Alive 超时（ms） |
| `https` | `null` | HTTPS 配置（cert/key） |
| `http2` | `false` | 启用 HTTP/2 |
| `logLevel` | `'info'` | 日志级别 |
| `logDir` | `'./log'` | 日志文件目录 |
| `cors` | `{ origin: '*', ... }` | CORS 配置 |
| `useBodyParser` | `true` | 自动解析请求体 |
| `useCookieParser` | `true` | 自动解析 Cookie |
| `bodyParserOptions` | `{}` | bodyParser 选项 |
| `cookieParserSecret` | `null` | Cookie 签名密钥 |
| `wsMaxPayload` | `104857600` | WebSocket 最大帧负载（100MB） |
| `wsAllowedOrigins` | `null` | WebSocket 允许的 Origin 列表 |

## HTTPS / HTTP2

```javascript
// HTTPS
const app = httpm({
  https: {
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.crt')
  }
});

// HTTP2
const app = httpm({
  http2: true,
  https: {
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.crt')
  }
});
```

## 导出接口

```javascript
const httpm = require('httpm');

// 核心类
httpm.Application
httpm.Router
httpm.Request
httpm.Response
httpm.SSE
httpm.WebSocket
httpm.WebSocketServer
httpm.Logger

// 内置中间件
httpm.bodyParser
httpm.cookieParser
httpm.static

// 工具函数
httpm.parseUrl
httpm.parseQuery
httpm.parseCookies
httpm.getMimeType
httpm.fmtSize
httpm.fmtTime
httpm.isPathSafe
httpm.generateETag
httpm.parseRange
httpm.escapeHtml
httpm.WebSocketHandShark
```

## 运行要求

- Node.js >= 18.0.0
- 零第三方依赖

## 测试

```bash
npm test
```

## License

MIT
