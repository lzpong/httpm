# httpm 项目详细设计文档

**文档类型**：软件开发详细设计文档

**文档版本**：V1.5.8

**定位说明**：本文档聚焦功能设计、模块架构、类设计、业务逻辑、接口规则、数据流转，面向开发实现，不含运维、部署、集群、监控等工程运维类内容。

---

## 1. 项目概述

### 1.1 设计目标

httpm 是基于 Node.js 原生模块开发的**单文件、零依赖** HTTP 服务库，完全兼容 Express 主流 API 风格，降低开发迁移与学习成本。

核心设计原则：

1. **单文件架构**：所有代码、功能、类库全部整合至 `httpm.js` 单一文件，无需拆分依赖，便于分发、引入与二次修改。
2. **零第三方依赖**：仅使用 Node.js 内置原生模块（`http`、`https`、`fs`、`path`、`crypto`、`zlib`），不引入任何 npm 三方包。
3. **Express 兼容**：路由、中间件、请求 / 响应 API 对齐 Express 常用语法。
4. **功能一体化**：整合 HTTP/HTTPS/HTTP2、路由、静态服务、文件上传下载、WebSocket、SSE、日志等常用 Web 服务能力。

### 1.2 核心特性

| 功能模块 | 功能说明 |
| --- | --- |
| HTTP/HTTPS/HTTP2 | 基于 Node 原生网络模块实现，同时支持明文 HTTP、加密 HTTPS 及 HTTP2 协议 |
| 路由系统 | 支持静态路由、动态参数路由（/users/:id），动态路由自动解析路径参数 |
| 中间件 | 标准 Express 线性中间件执行模型，支持应用级、路径级、错误处理中间件 |
| 静态文件服务 | 支持 Range 断点续传、ETag/Last-Modified 缓存、Gzip 压缩、目录访问控制 |
| 文件上传 | multipart/form-data 流式解析，内存零占用，支持大小限制、临时文件自动清理 |
| 文件下载 | 支持 Range 断点续传、ETag/Last-Modified 缓存 |
| WebSocket | 遵循 RFC 6455 标准，支持路径分组、层级广播、全局广播、统一心跳保活机制、动态参数路由 |
| SSE | 轻量化 Server-Sent Events 实现，简化长推送开发 |
| CORS | 跨域资源共享配置，支持 origin/headers/credentials/maxAge |
| 日志系统 | 分级日志，支持彩色控制台输出 + 文件持久化存储 |

### 1.3 应用场景

1. 轻量嵌入式 Web 服务、本地调试服务；
2. 小型内网接口服务、静态资源服务器；
3. 快速实现带长连接（WebSocket/SSE）的一体化服务；
4. 学习、二次定制改造的轻量 Node Web 框架底座。

---

## 2. 整体架构设计

### 2.1 架构分层

整体采用**分层内聚**设计，自上而下分为：对外导出接口层、核心业务类层、通用工具函数层，所有代码统一收纳在 `httpm.js` 中。

```plaintext
┌─────────────────────────────────────────────────────────┐
│                        httpm.js                         │
├─────────────────────────────────────────────────────────┤
│ 【导出接口层】对外暴露类、方法、中间件、工具函数                │
│ httpm() 入口函数 / 各类核心类 / 内置中间件 / 工具方法         │
├─────────────────────────────────────────────────────────┤
│ 【核心类层】业务核心逻辑实现                                 │
│ Application / Router / Request / Response               │
│ SSE / WebSocket / WebSocketServer / Logger              │
├─────────────────────────────────────────────────────────┤
│ 【工具函数层】通用公共方法                                   │
│ 路径解析、参数解析、MIME、大小格式化、安全校验等                │
└─────────────────────────────────────────────────────────┘
```

### 2.2 请求整体处理流程

客户端发起 HTTP 请求后，全流程数据与逻辑流转如下：

```plaintext
客户端 HTTP 请求
    │
    ├─ 基础解析：URL 路径、Query 参数、Cookie 解析
    ├─ 请求体 Body 解析（根据 Content-Type 区分类型）
    │   ├─ application/json → JSON 反序列化
    │   ├─ application/x-www-form-urlencoded → 表单参数解析
    │   ├─ multipart/form-data → 流式解析，写入临时文件
    │   └─ 其他类型 → 原始 Buffer 存储
    │
    ├─ 路由匹配（动态路由优先级高于静态兜底）
    │   ├─ 路由匹配成功 → 顺序执行中间件链 → 执行路由处理器
    │   │   ├─ 处理器返回 false → 进入默认静态文件处理逻辑
    │   │   └─ 正常响应 → 结束请求链路
    │   └─ 路由匹配失败 → 进入默认兜底处理
    │
    ├─ 默认兜底处理逻辑
    │   ├─ GET/HEAD 请求 → 静态文件服务
    │   ├─ OPTIONS 请求 → CORS 预检响应
    │   └─ 其他请求方法 → 返回 404 / 405 状态码
    │
    └─ 统一响应输出（res.json / send / sendFile / download 等）
```

---

## 3. 核心类详细设计

### 3.1 Application 类

#### 类职责

项目主入口类，继承自 `Router`，统一管理服务配置、全局中间件、服务器生命周期，是整个服务的顶层入口。

#### 继承关系

`Application extends Router`

#### 构造函数自动注册中间件

构造函数会根据配置自动注册两个内置中间件（可通过配置关闭）：

- `useBodyParser !== false`（默认启用）：自动注册 `bodyParser` 中间件，解析 JSON/urlencoded/multipart 请求体；
- `useCookieParser !== false`（默认启用）：自动注册 `cookieParser` 中间件，解析 Cookie 并支持签名验证。

这两个中间件在所有用户注册的中间件之前执行，确保 `req.body`、`req.cookies`、`req.signedCookies` 在后续中间件和路由中可用。

#### 核心属性

```javascript
class Application extends Router {
  constructor(options = {}) {
    super();
    this.settings = {};          // 全局配置对象
    this.middlewareStack = [];   // 全局中间件栈
    this.server = null;          // 原生 HTTP/HTTPS/HTTP2 服务实例
  }
}
```

#### 核心方法

| 方法名 | 入参 | 功能描述 |
| --- | --- | --- |
| app.set(name, value) | 配置名、配置值 | 设置全局运行时配置 |
| app.use([path], middleware) | 可选路径、中间件函数 | 注册全局 / 路径级中间件 |
| app.METHOD(path, handler) | 请求方法、路径、处理器 | 注册路由（继承 Router 能力） |
| app.listen(port, callback) | 端口、启动回调 | 启动网络服务，监听端口 |
| app.close(callback) | 关闭回调 | 停止服务，释放端口资源 |
| app.ws(path, handler) | 路径、处理器 | 注册 WebSocket 路由，handler 签名 `(ws, req) => cleanupFn\|void` |
| app.sse(path, handler) | 路径、处理器 | 注册 SSE 路由，handler 签名 `(sse, req) => cleanupFn\|void` |
| app.wss | — | WebSocketServer 实例（只读属性） |

#### 特殊规则

路由处理器支持 **返回 false** 逻辑：当动态路由匹配成功，但业务逻辑判定需要走静态文件兜底时，返回 `false`，请求会继续进入默认静态文件处理流程。

示例：

```javascript
app.get('/api/users/:id', (req, res) => {
  if (!用户存在) return false; // 跳转至静态文件服务
  res.json(用户数据);
});
```

### 3.2 Router 类

#### 类职责

负责路由注册、路由规则编译、请求路径匹配、路由参数提取，是整个路由系统的核心。

#### 核心属性

```javascript
class Router {
  constructor() {
    // 按 HTTP 方法分类存储路由规则
    this.routes = { GET: [], POST: [], PUT: [], DELETE: [], PATCH: [], HEAD: [], OPTIONS: [], ALL: [] };
    this.middlewareStack = []; // 路由级中间件栈
  }
}
```

#### 路由对象结构

每一条注册的路由，编译后存储结构如下：

```javascript
{
  method: 'GET',                // HTTP 请求方法
  path: '/users/:id',           // 原始注册路径
  pattern: /^\/users\/([^/]+)$/,// 编译后的正则表达式（用于路径匹配）
  params: ['id'],               // 路径参数名数组
  handlers: [handler]           // 路由处理器数组
}
```

#### 动态路由编译逻辑

将带占位符 `:param` 的路径转换为正则表达式，并提取参数名：

1. 遍历路径，匹配 `:参数名` 占位符；
2. 收集所有参数名存入 `params` 数组；
3. **非参数部分转义**：用 `:参数名` 作为分隔符 split 路径，对每一段静态文本调用 `seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` 转义正则特殊字符，避免 `.`、`(`、`[`、`+`、`?` 等字符被当作正则元字符解释（如 `/api.json` 中的 `.` 不转义会匹配 `apiXjson`，`/users(test)` 会抛 SyntaxError）；
4. 将占位符替换为正则捕获组 `([^/]+)`，与转义后的静态段拼接成完整 pattern；
5. 生成完整正则对象用于路径匹配；
6. 同时生成 `prefixPattern`（前缀匹配正则，供路径级中间件使用）：路径之后必须跟随 `/` 或字符串结尾（`(?=/|$)`）作为边界，避免 `/api` 误匹配 `/apixyz`；`/` 特殊处理为 `/^\//`，匹配所有以 `/` 开头的路径（根路径中间件等价于应用级中间件）。

#### 参数传递语义（_dispatch）

中间件链与路由处理器执行时，**每个 layer 执行前重置 `req.params` 为该 layer 自己的参数**（与 Express 行为一致），避免路径级中间件参数（如 `use('/api/:version')` 的 `version`）污染到路由处理器。路由处理器若需读取路径级中间件设置的参数，应在中间件中挂到 `req` 自定义属性上（如 `req._mwVer = req.params.version`），不要依赖 `req.params` 跨 layer 传递。

#### HEAD 请求匹配

HEAD 请求自动匹配 GET 路由（Express 兼容行为），但仅发送响应头，不发送响应体。

**机制**：HEAD 请求不会在 `routes` 表中注册独立路由，而是在 `Router.match()` 匹配时隐式查找 GET 路由。当 `req.method === 'HEAD'` 时，`match()` 同时查找 `routes['HEAD']` 和 `routes['GET']`。

#### OPTIONS 请求处理

OPTIONS 请求有两种语义，httpm 分别处理：

1. **CORS 预检**：浏览器跨域请求前自动发送的 OPTIONS 请求，由 `_handleCORS` 方法统一处理，返回 204 + CORS 头；
2. **路由能力查询**：`_handleCORS` 会动态查询该路径匹配的所有 HTTP 方法，在响应中返回 `Allow` 头和 `Access-Control-Allow-Methods` 头，告知客户端该路径实际支持的方法列表。

> **实际请求 CORS 头**：`_applyCORSHeaders` 在 `_handleRequest` 中对所有请求统一设置 `Access-Control-Allow-Origin`、`Access-Control-Allow-Credentials`、`Vary: Origin` 基础头，确保跨域 GET/POST 等实际请求也能被浏览器正确读取（预检的 Allow-Methods/Headers/Max-Age 仍由 `_handleCORS` 补充）。当 `cors.credentials=true` 且 `origin='*'` 时，自动回退为回显具体 Origin，避免浏览器拒绝。

`cors.origin` 配置支持三种形式：
- **字符串**（如 `'*'` 或 `'https://example.com'`）：直接作为 Allow-Origin 值；
- **数组**（如 `['https://a.com', 'https://b.com']`）：白名单校验，请求 Origin 在列表中才回显该 Origin 并附加 `Vary: Origin` 头；不在列表中则不设置 ACAO 头（拒绝跨域），`credentials=true` 时同样拒绝；
- **函数**（如 `origin => origin.endsWith('.com') ? origin : false`）：动态计算 Allow-Origin 值。返回值语义：
  - 返回字符串：作为 Allow-Origin 值
  - 返回 `true`：使用请求 Origin 作为 Allow-Origin 值
  - 返回 `false`/`null`/`''`：拒绝跨域请求（不设置 ACAO 头，浏览器会拒绝）

`_getAllowedMethods(pathname)` 方法遍历所有已注册路由，查找匹配该路径的方法，并自动补充隐式规则：
- GET 路由隐式支持 HEAD；
- OPTIONS 始终可用（CORS 预检）。

### 3.3 Request 类

#### 类职责

封装 Node 原生 `IncomingMessage` 请求对象，提供简化、统一的请求属性与数据解析结果，向上层业务屏蔽原生 API 细节。

#### 核心属性

```javascript
class Request {
  constructor(incomingMessage) {
    this._req = incomingMessage; // 原生请求对象（内部使用）
    this._app = null;            // 所属 Application 实例（内部使用）
    this._res = null;            // 关联的 Response 对象（内部使用）
    this.query = {};             // URL 解析后的查询参数
    this.params = {};            // 动态路由解析后的路径参数
    this.body = null;            // 解析后的请求体数据
    this.cookies = {};           // 解析后的 Cookie 对象
    this.signedCookies = {};    // 签名 Cookie 对象（需配置 cookieParserSecret）
    this.files = [];             // 上传文件数组（兼容旧版本）
    this.path = '';              // 解码后的请求路径（不含 query）
    this.formData = {            // 统一表单数据对象（推荐使用）
      fields: {},                // 合并 query + body（body 优先级更高）
      files: []                  // 上传文件列表
    };
    this._tempFiles = [];        // 当前请求产生的临时文件列表（内部清理使用）
  }
}
```

#### 通用快捷属性

封装原生请求头与连接信息，直接对外使用：

- `req.method`：   HTTP 请求方法
- `req.url`：	   原始请求 URL
- `req.originalUrl`：原始请求 URL（Express 兼容，与 req.url 等价）
- `req.get(name)`：  获取请求头（不区分大小写，Express 兼容）
- `req.headers`：  请求头对象
- `req.ip`：	   客户端 IP 地址；仅在 `trustProxy=true` 时信任 `X-Forwarded-For`，默认取 `socket.remoteAddress`（防止客户端伪造）
- `req.hostname`： 请求域名；`trustProxy=true` 时优先取 `X-Forwarded-Host`，默认取 `Host` 头；正确处理 IPv6 地址（如 `[::1]:8080` → `::1`、`[2001:db8::1]` → `2001:db8::1`），使用 `new URL('http://' + host).hostname` 解析端口后剥离 IPv6 方括号，对齐 Express 4.x 行为
- `req.protocol`： 当前协议（http /https）
- `req.files`：	   上传文件数组（兼容旧版，可以使用 `req.formData.files`）

#### 请求体读取

`_readBody(timeoutMs, maxSize)` 方法内置超时保护和流式大小检查：

1. 默认超时 30 秒，超时后销毁请求流并抛出错误；
2. 流式检查请求体大小，超过 `maxBodySize`（默认 128MB）时立即中断并返回 413；
3. 错误对象使用 `error.cause` 附加上下文信息（实际大小、限制大小等）。

### 3.4 Response 类

#### 类职责

封装原生响应对象，提供一系列快捷响应方法，统一响应头、状态码、数据输出能力。

#### 核心属性与方法

| 成员 | 说明 |
| --- | --- |
| statusCode | 默认响应状态码，初始值 200 |
| _isHead | 是否为 HEAD 请求（仅发送头部，不发送响应体） |
| set(name, value) | 设置响应头（Express 兼容），支持单键和对象批量设置；底层方法 setHeader 功能相同 |
| get(name) | 获取已设置的响应头（Express 兼容），不区分大小写；底层方法 getHeader 功能相同 |
| type(contentType) | 设置 Content-Type（Express 兼容），支持简写（html→text/html） |
| on(event, listener) | 代理原生 ServerResponse 事件监听（Express 兼容） |
| setHeader(name, value) | 设置响应头（底层方法，同 set） |
| getHeader(name) | 获取已设置的响应头（底层方法，同 get） |
| removeHeader(name) | 移除已设置的响应头 |
| status(code) | 设置 HTTP 状态码，支持链式调用 |
| json(data) | 输出 JSON 格式响应，自动补充对应 Content-Type |
| send(data) | 通用输出，支持字符串、HTML、Buffer、对象；`null` 返回空响应（Express 4.x 兼容），`undefined` 返回空响应 |
| sendFile(path, options, [callback]) | 发送本地文件，内置断点续传、缓存、Gzip 能力；options 支持 `{ root, contentType }`；callback(err) 在完成/出错时调用 |
| download(path, [filename], [options]) | 触发浏览器文件下载，支持断点续传；兼容 Express 签名，options 传递给 sendFile |
| redirect([code,] url) | 重定向响应，兼容 Express 签名：`redirect(url)` 默认 302，`redirect(status, url)` 指定状态码；url 为 null/undefined 时回退到 '/'（避免 encodeURI(undefined)='undefined'）；url='back' 时取 Referer 头回退到上一页 |
| location(url) | 设置 Location 响应头（不发送响应，常与 send 配合） |
| sse() | 创建 SSE 推送实例 |
| cookie(name, value, opts) | 设置响应 Cookie；opts 支持 `maxAge`（**单位秒，与 Express 毫秒不同**，写入 Max-Age）、`expires`（Date 对象，写入 Expires）、`domain`、`path`、`secure`、`httpOnly`、`sameSite`、`signed`；对象 value 自动 JSON 序列化，signed 启用 HMAC-SHA256 签名（`s:` 前缀）；value 为 null/undefined 时回退空字符串（避免 encodeURIComponent(undefined)='undefined'） |
| append(field, value) | 追加响应头值（不覆盖已有值，适用于 Set-Cookie 等多值头） |
| locals | 请求级数据传递对象（中间件间共享数据），初始为 `Object.create(null)` |

#### sendFile 核心逻辑

1. **路径遍历防护**：配置 `root` 时，解析后 fullPath 必须等于 root 或以 `root + path.sep` 开头，否则返回 403 并中止；
2. **空文件特判**：`stat.size === 0` 时跳过 Range/缓存/Gzip 流程，直接 `res.end()` 返回空响应体（避免 `end = size - 1 = -1` 触发 `createReadStream({start:0, end:-1})` 的 RangeError）；
3. **Range 断点续传**：识别请求 `Range` 头，返回 206 分段响应；
4. **缓存校验**：通过 ETag、Last-Modified 校验，命中缓存返回 304；
5. **Gzip 压缩**：对文本类文件，根据客户端 `Accept-Encoding` 自动开启压缩；HEAD 请求不进入 Gzip 分支（HEAD 不传输实体无需压缩，且流式 Gzip 无法预知压缩后大小，进入此分支会导致 Content-Length 与 GET 实际返回的压缩内容不一致），HEAD 走 `_streamFile` 快速路径返回 `Content-Length: stat.size`（未压缩大小）且无 `Content-Encoding` 头；
6. **HEAD 请求**：匹配 GET 路由但仅发送响应头，不发送响应体（Express 兼容行为）。

### 3.5 SSE 类

#### 类职责

实现 **Server-Sent Events** 服务端单向长推送协议，封装协议头、消息发送、连接管理能力。

#### 核心设计

1. 实例化时自动设置 SSE 标准响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`（仅在 headers 未发送时设置）；
2. 内置连接状态标识 `connected`，标记连接是否正常；
3. 监听 `close` 和 `aborted` 事件，兼容 HTTP/1.1 和 HTTP/2 连接断开检测；
4. 支持标准 SSE 消息格式、自定义事件、重连时间配置。

#### 核心方法

- `send(data)`：		发送普通消息，自动兼容字符串 / JSON 对象；data 为 null/undefined 时转为 'null'（避免 JSON.stringify(undefined)=undefined 导致 split 抛 TypeError）；
- `event(name, data)`： 发送自定义命名事件；data 为 null/undefined 时同 send 处理；
- `retry(ms)`：			设置客户端重连间隔（毫秒）；
- `comment(text)`：		发送注释消息（可作为心跳保活）；text 为 null/undefined 时转为空字符串；
- `close()`：			主动关闭 SSE 连接，自动移除 `close`/`aborted` 事件监听器防止内存泄漏。

#### 写入错误处理（_write 统一封装）

所有 SSE 写入方法（send/event/retry/comment）通过内部 `_write(payload)` 方法统一写入，处理底层响应流异常。`this._res.write` 在响应已结束、客户端断开或底层 socket 错误时可能抛异常，`_write` 用 try/catch 包裹，失败时调用 `close()` 清理连接资源，避免未捕获异常冒泡。

```javascript
_write(payload) {
  if (!this.connected) return false;
  try {
    this._res.write(payload);
    return true;
  } catch (e) {
    this.close(); // 写入失败，关闭连接清理资源
    return false;
  }
}
```

#### 换行符处理（SSE 协议合规）

SSE 协议规定每行数据以 `data:` 前缀开头，消息之间以 `\n\n` 分隔。若消息体本身包含 `\n`，直接拼接 `data: ${msg}\n\n` 会插入额外的 `data:` 行，导致客户端解析出多条消息或解析错误。httpm 对 `send` 和 `event` 方法做换行符拆分处理：

```javascript
const lines = msg.split('\n');
this._write(lines.map(l => `data: ${l}`).join('\n') + '\n\n');
```

`event(name, data)` 还会校验事件名不能包含 `\n`（事件名跨行违反协议），违规时直接返回不发送。

#### 连接断开检测

SSE 监听两类断开事件以兼容 HTTP/1.1 与 HTTP/2：

- **ServerResponse 的 `close` 事件**：底层 socket 关闭时触发（HTTP/1.1 主要路径）；
- **IncomingMessage 的 `aborted` 事件**：客户端主动 abort 时触发（HTTP/2 主要路径）。

`res.sse()` 内部从 `req._req`（httpm Request 包装的底层 IncomingMessage）取得原始请求对象监听 `aborted`，构造函数中加 `typeof req.on === 'function'` 校验防御非 IncomingMessage 入参。

#### 使用规则

注册 SSE 路由时，支持返回清理函数，连接断开后自动执行资源回收。

### 3.6 WebSocket 与 WebSocketServer 类

#### 3.6.1 WebSocket 类

遵循 **RFC 6455** 标准实现 WebSocket 单连接管理。

1. 核心属性：原生 socket、连接路径、唯一 ID、连接状态（connected / _closing / _closed）、心跳时间戳；
2. `send(data)` 方法：自动区分文本、JSON 对象、二进制 Buffer，匹配对应帧类型；
3. `close(code = 1000, reason = '')` 方法：先发送 Close 帧（此时 connected 仍为 true），再标记 connected=false、_closing=true，限时 2 秒等待对端 Close 帧，超时则强制销毁 socket 并触发 `close` 事件携带原始 code/reason；
4. Close 帧状态码：对端发送无状态码的 Close 帧时，默认为 1005（RFC 6455 规定的"无状态码"语义码），非法状态码（0-999）自动修正为 1005；
5. RFC 6455 Section 7.4.1 规定：1005（无状态码）、1006（异常关闭）、1015（TLS 握手失败）不得在 Close 帧中发送，httpm 在回复 Close 帧时会自动将这三种状态码替换为不携带状态码的 Close 帧；
6. 关闭握手期间（_closing=true）：忽略非控制帧，仅处理 Ping/Pong/Close 帧；
7. `close` 事件参数来源（RFC 6455 合规）：主动调用 `ws.close(code, reason)` 后，`close` 事件携带的 code/reason 按以下优先级确定：
   - **对端回复 Close 帧** → 使用**对端** Close 帧中的 code/reason（RFC 6455 规定 close 事件应反映连接实际关闭状况）；
   - **2 秒超时未收到对端 Close 帧** → 使用本地 `close()` 传入的 code/reason；
   - **socket 异常断开（未走握手）** → socket `close` 事件触发，code 为 1006（RFC 6455 规定的"异常关闭"语义码，仅用于 close 事件，不得在 Close 帧中发送）。
   
   业务方监听 `close` 事件时，code=1006 表示异常断开（非正常关闭握手）。
8. RFC 6455 协议校验：客户端帧必须掩码（未掩码帧按协议错误关闭连接）；控制帧（Close/Ping/Pong）负载不得超过 125 字节且不可分片（FIN 必须为 1），违反时以 1002 关闭连接；
9. 帧负载长度超过 `Number.MAX_SAFE_INTEGER` 时视为超限帧，拒绝处理；`maxPayload` 超限检查在掩码解析前执行，防止慢速大帧攻击（客户端声明大 `payloadLength` 但慢速发送，若等数据完整再拒绝缓冲区会持续增长，防护失效），超限时立即 `close(1009)`；
10. 支持分片帧解析（continuation frame），多帧消息自动合并后触发事件；分片累积总大小通过 `_fragmentTotalSize` 累积器校验，超过 `maxPayload` 时清理分片状态并 `close(1009)`，防止攻击者用大量小分片（每个 < `maxPayload`）累积成巨大消息绕过单帧检查；
11. 发送失败时触发 `error` 事件，便于用户感知和处理异常；
12. 监听底层套接字事件，处理消息接收、连接断开：监听 `data` 接收帧、`pong` 更新心跳时间戳、`error` 透传错误、`end`（对端 FIN）主动销毁 socket 加速清理、`close` 触发 `_emitClose` 清理连接状态（详见设计规则 54）。

#### 3.6.2 WebSocketServer 类

全局 WebSocket 服务管理类，统一管理所有长连接：

1. 连接分组：按请求的**原始路径**对连接分组（静态分组），如 `/chat/room1` 和 `/chat/room2` 是不同分组；
2. 统一心跳：全局唯一心跳定时器，有连接则启动，无连接则停止，减少资源占用；
3. 广播能力：支持**按路径广播**（层级广播）、**全局广播**，支持排除指定连接（单个ws或ws数组）；层级广播规则：`broadcast('/chat')` 匹配 `/chat` 及所有 `/chat/*` 子路径（前缀匹配 `key === pathStr || key.startsWith(pathStr + '/')`），`broadcast('/chat')` 不会误匹配 `/chatone`；`getConnections` 同理支持层级查询；
4. 连接管理：新增 / 销毁连接时自动维护连接列表；
5. Origin 校验：支持 `allowedOrigins` 配置，防止跨站 WebSocket 劫持（CSWSH）；
6. 帧负载限制：支持 `maxPayload` 配置（默认 100MB），同时校验单帧负载和分片累积总大小，防止恶意超大帧和分片累积绕过攻击耗尽内存。
7. **handler req 一致性**：`app.ws(path, handler)` 与 `wss.on('connection', (ws, req) => ...)` 的 `req` 均为 httpm `Request` 实例（与普通路由 `req` 同类型）。`_handleUpgrade` 在握手前将原生 `http.IncomingMessage` 包装为 `Request`，补全 `query`/`path`/`cookies`/`signedCookies`/`ip`/`hostname`/`protocol`/`get()` 等便捷属性，handler 可像普通路由一样使用 `req`。Cookie 解析复用 `cookieParser` 中间件逻辑（尊重 `useCookieParser` 配置）；底层 socket 通过 `ws.socket` 访问（符合 WebSocket 语义，`req` 不暴露 `socket`）；`body`/`files`/`formData` 保持初始值（升级请求无 body）。详见设计规则 55。

#### 心跳机制

定时向所有连接发送 Ping 帧，检测客户端 Pong 回复，超时未响应则主动断开连接，清理无效套接字。

#### 动态参数路由

`app.ws()` 支持动态参数路由，复用 Router 的路由编译逻辑：

```javascript
app.ws('/chat/:room', (ws, req) => {
  console.log(req.params.room); // 动态参数自动解析
});
```

### 3.7 Logger 日志类

#### 类职责

分级日志管理，同时支持**彩色控制台输出**与**本地文件持久化**。

#### 日志级别（优先级从低到高）

`debug` < `info` < `notice` < `warn` < `error` < `fatal`

文件：./log/YYYY/MM/name_DD.log

日志记录示例：
```
[23:56:50] [ERROR ] test log
```


#### 核心设计

1. 颜色区分：不同日志级别对应不同控制台字体颜色，提升可读性；
2. 文件存储规则：按年月创建目录，日志文件按日期拆分；
3. `log(level,...args)` 统一入口方法，分发至控制台与文件；
4. **跨日切换**：检测到日期变化时，异步关闭旧流（`end()` 后 `destroy()`），创建新流写入新文件，旧流异步刷盘不阻塞主流程；
5. **写入失败处理**：日志文件流监听 `error` 事件，磁盘满（`ENOSPC`）、权限不足（`EACCES`）等错误由 `_handleWriteError(err)` 统一处理：
   - **控制台打印明确错误码和原因**（不再静默），格式：`[Logger] 日志文件写入失败 [ENOSPC]: no space left on device`，便于运维快速定位；
   - **exitOnDiskFull 配置项**（默认 `false`）控制是否退出进程（注：配置项名取最常见场景磁盘满，实际任何写入错误都会触发退出）：
     - `false`：仅控制台打印，主业务流程继续（业界主流，日志故障不影响主业务）；
     - `true`：控制台打印后 `process.exit(1)`，便于进程管理器（pm2/systemd）感知并重启；
   - 支持通过 `new Logger({ exitOnDiskFull: true })` 或 `httpm({ exitOnDiskFull: true })` 配置。
6. **写入背压检测**：`_writeFile` 检查 `stream.write()` 返回值，返回 `false` 表示内部缓冲已满（背压），此时打印一次告警（`[Logger] Write backpressure detected`），并监听 `drain` 事件后重置告警标志，避免日志风暴。高并发日志场景下背压告警帮助运维感知日志延迟/丢失风险。

---

## 4. 中间件系统设计

### 4.1 执行机制

采用 **Express 标准线性执行模型**：

1. 中间件按注册顺序串行执行；
2. 必须调用 `next()` 方可进入下一个中间件 / 路由处理器；
3. 支持前置处理、后置处理（`next()` 执行完成后逻辑）。

标准中间件签名：

```javascript
function middleware(req, res, next) {
  // 前置逻辑
  next();
  // 后置逻辑（可选）
}
```

### 4.2 中间件分类

| 类型 | 注册方式 | 生效范围 |
| --- | --- | --- |
| 应用级中间件 | app.use(fn) | 全局所有请求 |
| 路径级中间件 | app.use('/prefix', fn) | 仅匹配指定路径前缀的请求 |
| 错误处理中间件 | app.use((err, req, res, next)=>{}) | 全局异常捕获，固定为四个入参 |

### 4.3 内置中间件实现

#### 4.3.1 bodyParser

负责解析各类请求体，整合表单、JSON、文件数据：

1. 初始化 `req.formData`、临时文件列表；
2. 根据 `Content-Type` 区分解析逻辑；
3. `multipart/form-data` 类型调用流式解析器处理上传文件；
4. 监听响应结束事件，自动清理当前请求产生的临时文件。

#### 4.3.2 cookieParser

解析请求头中的 `Cookie` 字段，格式化后存入 `req.cookies`，供业务使用。

当配置了 `cookieParserSecret` 时，自动验证签名 Cookie：

1. 识别 `s:` 前缀的 Cookie 值，提取签名和原始值；
2. 使用 HMAC-SHA256 重新计算签名，与 Cookie 中的签名比对；
3. 验证通过：将原始值存入 `req.signedCookies`，并从 `req.cookies` 中删除该键（Express 兼容行为，防止误用未验证的签名值）；
4. 验证失败：保留在 `req.cookies` 中，不写入 `req.signedCookies`。

#### 4.3.3 static

静态文件服务中间件，支持目录自动查找 `index.html`：

```javascript
app.use(httpm.static('public'));
// 支持 options
app.use(httpm.static('public', { allowAccessToAllFiles: true }));
```

1. 请求路径为目录时，自动查找 `index.html`；
2. 支持 `allowAccessToAllFiles` 选项，允许访问隐藏文件；
3. 路径安全校验防止目录遍历攻击。

---

## 5. 配置管理设计

### 5.1 配置加载优先级

配置多层覆盖，优先级由低到高：

`默认配置` → `配置文件(app.json)` → `代码初始化参数` → `运行时 app.set() 动态设置`

### 5.2 默认配置项

```javascript
const defaultConfig = {
  // 基础服务
  rootPath: process.cwd(),        // 静态文件根目录
  tempDir: 'tempupdir',           // 文件上传临时目录
  maxFileSize: 128 * 1024 * 1024, // 单文件最大限制 128MB
  maxFieldSize: 1024 * 1024,      // 表单字段最大限制 1MB
  maxBodySize: 128 * 1024 * 1024, // 请求体最大限制 128MB
  svrPort: 80,                    // 服务默认端口
  svrIP: null,                    // 监听地址（null 监听所有网卡）

  // 功能开关
  showDir: false,                 // 是否允许展示目录列表
  allowAccessToAllFiles: false,   // 是否允许访问隐藏文件（.env、.git 等）
  enableCache: false,             // 是否开启文件缓存
  enableGzip: false,              // 是否开启 Gzip 压缩
  enableRange: true,              // 是否开启断点续传（默认启用）
  cacheControl: 'public, max-age=3600',

  // 超时配置
  timeout: 120000,
  keepAliveTimeout: 65000,

  // 加密协议
  https: null,                    // HTTPS 证书配置
  http2: false,                   // 是否启用 HTTP2

  // 日志配置
  logLevel: 'info',
  logDir: './log',
  exitOnDiskFull: false,             // 日志写入失败时是否退出进程（false=仅控制台打印，true=退出）

  // 跨域配置
  cors: { origin: '*', headers: 'Content-Type, Authorization', maxAge: 86400, credentials: false },

  // 内置中间件开关
  useBodyParser: true,
  useCookieParser: true,
  bodyParserOptions: {},
  cookieParserSecret: null,

  // WebSocket 心跳
  wsHeartbeatInterval: 30000,     // 心跳发送间隔(ms)
  wsHeartbeatTimeout: 30000,      // 心跳超时时间(ms)
  wsMaxPayload: 100 * 1024 * 1024,// WebSocket 最大帧负载大小（默认 100MB）
  wsAllowedOrigins: null          // WebSocket 允许的 Origin 列表（null=不限制）
};
```

---

## 6. 静态文件服务设计

### 6.1 请求处理优先级

仅对 `GET / HEAD` 方法生效，优先级顺序：
`动态路由匹配` → `静态文件服务` → `目录访问` → `404`

1. 路径合法校验通过后，查找对应本地文件；
2. 文件存在：正常返回文件（附带缓存、压缩、断点续传）；
3. 路径为目录：查找 `index.html`，或根据配置展示目录列表；
4. 文件 / 目录均不存在：返回 404 响应。

### 6.2 路径安全校验

核心目标：**防御路径遍历攻击**，禁止通过 `../` 访问根目录以外文件。

校验规则：

1. 拼接请求路径与静态根目录，转为绝对路径；
2. 判断路径是否跳出根目录（检测 `..` 片段）；
3. 默认禁止访问系统隐藏文件（以 `.` 开头的文件 / 目录）。

### 6.3 Range 断点续传

1. 解析请求头 `Range`，提取客户端请求的字节范围；
2. 校验范围合法性，超出文件大小则拒绝；
3. 响应头返回 `206 Partial Content`，附带 `Content-Range`、`Content-Length`；
4. 按字节范围读取文件流，分段返回数据；
5. **无效 Range 处理**：当 `Range` 头存在但解析失败（格式非法或范围越界）时，返回 `416 Range Not Satisfiable`，附带 `Content-Range: bytes */<fileSize>` 与 `Content-Length: 0`（遵循 RFC 7233）。

### 6.4 缓存机制

采用 **ETag + Last-Modified** 双重缓存校验：

1. 根据文件大小、最后修改时间生成 ETag 标识；
2. 接收客户端 `If-None-Match` / `If-Modified-Since` 头进行比对；
3. 缓存命中：返回 304 状态码，不返回文件内容，不设置 Content-Length；

### 6.5 Gzip 压缩

1. 仅对**文本类文件**开启压缩（html、css、js、json、txt 等）；
2. 校验客户端请求头 `Accept-Encoding` 是否支持 gzip；
3. 文件流经过 `zlib.Gzip` 压缩后输出，并添加 `Content-Encoding: gzip` 响应头。

---

## 7. 文件上传模块设计

### 7.1 流式解析核心实现

基于状态机实现 `multipart/form-data` **流式解析**：

1. 边接收客户端数据流，边解析、边写入本地临时文件；
2. 全程不将完整文件载入内存，支持超大文件并发上传；
3. 内置文件大小、表单字段大小限制，超限直接终止解析；
4. 写入流背压处理：当 `WriteStream.write()` 返回 false 时暂停请求读取，drain 后恢复，避免内存积压；
5. 文件超限或解析出错时，使用 `stream.destroy()` 立即释放文件描述符，而非 `stream.close()`；
6. 回看长度机制：保留分隔符长度 -1 的尾部字节，防止分隔符跨 chunk 截断导致解析失败。

### 7.2 临时文件生命周期管理

1. 解析到文件区块时，生成唯一临时文件名，写入临时目录；
2. 文件信息存入 `req.formData.files`，供业务层读取；
3. **请求响应完成后**，自动删除当前请求产生的所有临时文件；
4. 客户端主动断开连接时，同步清理已生成的不完整临时文件。

### 7.3 临时文件清理时机

请求响应完成后，自动删除当前请求产生的所有临时文件；客户端主动断开连接时，同步清理已生成的不完整临时文件。

### 7.4 文件名安全处理

multipart 上传的文件名存在路径遍历风险（客户端可构造 `../../etc/passwd` 等文件名覆盖系统文件），httpm 在解析文件名时执行以下安全处理：

1. **分隔符替换**：将文件名中的 `\` 和 `/` 替换为 `_`，避免路径分隔符被解析；
2. **basename 提取**：使用 `path.basename()` 提取最后一层文件名，丢弃任何目录前缀；
3. **特殊文件名兜底**：若处理后文件名为 `.`、`..` 或空字符串，统一替换为 `unnamed`。

```javascript
let safeFilename = filenameMatch[1].replace(/[\\\/]/g, '_');
safeFilename = path.basename(safeFilename);
if (safeFilename === '.' || safeFilename === '..' || safeFilename === '') {
  safeFilename = 'unnamed';
}
```

### 7.5 多字节 UTF-8 跨 chunk 安全处理

multipart 表单字段值可能包含多字节 UTF-8 字符（如中文），当多字节字符被 chunk 边界截断时，直接 `buffer.toString('utf8')` 会产生乱码（替换字符 `\uFFFD`）。httpm 使用 `StringDecoder` 替代直接拼接：

1. 字段开始时创建 `new StringDecoder('utf8')`；
2. 每个 chunk 通过 `decoder.write(buffer)` 解码，未完成的多字节序列暂存于 decoder 内部；
3. 字段结束时调用 `decoder.end()` 刷新剩余字节，确保完整 UTF-8 序列输出。

### 7.6 Part 头部大小限制（DoS 防护）

multipart 解析的 `HEADERS` 状态会累积 part 头部缓冲（`partHeadersBuf`），等待 `\r\n\r\n` 结束标记。恶意客户端可发送永不结束的超大单个 part 头部，导致缓冲无限增长耗尽内存（DoS 攻击）。

httpm 复用 `maxFieldSize`（默认 1MB）作为 part 头部大小上限，在两处累积点均校验：

1. **未找到结束标记时**：每次累积后校验 `partHeadersBuf.length`，超限立即触发错误；
2. **找到结束标记时**：单个 chunk 可能含超大头部，拼接后再次校验总大小。

超限时通过 `safeNext(err)` 传递 413 错误，`safeNext` 会先销毁请求流（`req._req.destroy()`）主动断开恶意连接，再触发错误处理中间件。这种"立即断开"策略比发送 413 响应更安全：避免攻击者继续消耗服务端带宽和资源。客户端会收到 socket 错误（`ECONNRESET` / `socket hang up`）。

```javascript
partHeadersBuf = Buffer.concat([partHeadersBuf, buffer]);
if (partHeadersBuf.length > maxFieldSize) {
  const err = new Error(`Part header exceeds maximum size of ${fmtSize(maxFieldSize)}`);
  err.status = 413;
  safeNext(err); // 内部调用 req._req.destroy() 断开连接
  return;
}
```

正常 part 头部通常仅几百字节（Content-Disposition、Content-Type），1MB 上限足以容纳合法请求，同时有效防御恶意超大头部攻击。

---

## 8. 通用工具函数设计

所有工具函数为内部公共能力，同时对外导出供二次使用：

1. **`parseUrl`**：解析 URL，拆分路径与 Query 参数，自动去除 `#` 片段；
2. **`_parseQueryString`**：解析查询字符串为键值对象，支持 `+` 转空格，内置 `decodeURIComponent` 异常降级；
3. **`parseCookies`**：解析 Cookie 字符串为键值对象；
4. **`getMimeType`**：根据文件后缀匹配标准 MIME 类型；
5. **`fmtSize`**：字节单位格式化（B/KB/MB/GB/TB），智能小数位处理；
6. **`fmtTime`**：毫秒时间格式化（ms/s/m/h）；
7. **`isPathSafe`**：路径安全校验，防遍历攻击，支持 `allowAllFiles` 选项允许访问隐藏文件；
8. **`generateETag`**：根据文件信息生成缓存标识；
9. **`parseRange`**：解析 Range 请求头，提取字节分段范围；
10. **`escapeHtml`**：HTML 实体转义，防止 XSS 攻击。

---

## 9. 错误处理机制

### 9.1 错误流转规则

1. **同步代码异常**：框架自动捕获，流转至错误处理中间件；
2. **异步代码异常**（async/await、回调）：必须手动调用 `next(err)` 传递异常；
3. 异常一旦产生，终止正常业务链路，进入统一错误处理流程；
4. **safeNext 防护**：每个中间件/路由处理器接收的 `next` 函数被 `safeNext` 包装，同一处理器多次调用 `next()` 时仅首次生效，防止重复响应。

### 9.2 错误处理中间件

固定签名（四个入参），作为全局异常兜底：

```javascript
app.use((err, req, res, next) => {
  // 日志记录错误堆栈
  // 统一返回错误响应
});
```

#### 执行机制（对齐 Express 语义）

错误处理中间件在 `_dispatch` 阶段单独收集，**放到 stack 末尾**，与正常中间件/路由处理器分离：

1. **收集阶段**：遍历匹配到的中间件和路由，按 `handler.length === 4` 分流：
   - 4 参数函数 → `errorHandlers` 数组（标记 `isErrorHandler: true`）
   - 3 参数及以下函数 → `stack` 数组（标记 `isErrorHandler: false`）
2. **拼接阶段**：`stack.push(...errorHandlers)`，错误处理中间件统一放在 stack 末尾；
3. **正常链执行**：`_dispatch` 顺序执行 stack，遇到 `isErrorHandler: true` 的项直接跳过（正常请求不进入错误处理中间件）；
4. **错误链执行**：`_handleError(err, req, res, stack, startIdx)` 从抛错位置向后查找第一个 `isErrorHandler: true` 的项调用其 handler，handler 内调用 `next(err)` 可继续向后传递给下一个错误处理中间件。

> **为什么需要单独收集到末尾**：错误处理中间件通常通过 `app.use` 注册在路由之前（先注册），但路由抛错时 `_handleError` 从路由 idx 向后查找错误处理中间件。若按注册顺序混排，错误处理中间件位于路由之前会找不到，导致错误无人处理。Express 通过 `layer.HandleError` 在每一层都尝试调用错误处理中间件解决此问题，httpm 采用更简单的"末尾收集"策略达成相同效果。

#### safeNext 防护

`safeNext` 包装确保同一处理器多次调用 `next()` 时仅首次生效（无论是否传 err），防止重复响应或重复进入错误链：

```javascript
const safeNext = (e) => {
  if (handlerCalledNext) return; // 仅首次生效
  handlerCalledNext = true;
  next(e);
};
```

> safeNext 无条件去重：无论是否携带 err，仅首次调用 `next()` 生效，防止重复进入错误链。

---

## 10. 对外导出接口

`httpm.js` 统一导出所有对外可用类、函数、中间件，入口如下：

```javascript
// 入口函数
function httpm(options) { return new Application(options); }

// 导出核心类
httpm.Application = Application;
httpm.Router = Router;
httpm.Request = Request;
httpm.Response = Response;
httpm.SSE = SSE;
httpm.WebSocket = WebSocket;
httpm.WebSocketServer = WebSocketServer;
httpm.Logger = Logger;

// 导出内置中间件
httpm.bodyParser = bodyParser;
httpm.cookieParser = cookieParser;
httpm.static = staticMiddleware;

// 导出工具函数
httpm.parseUrl = parseUrl;
httpm.parseQuery = parseQuery;
httpm.parseCookies = parseCookies;
httpm.getMimeType = getMimeType;
httpm.fmtSize = fmtSize;
httpm.fmtTime = fmtTime;
httpm.isPathSafe = isPathSafe;
httpm.generateETag = generateETag;
httpm.parseRange = parseRange;
httpm.WebSocketHandshake = WebSocketHandshake;
httpm.escapeHtml = escapeHtml;
httpm.version = 'X.Y.Z'; // X.Y.Z 为实际版本号

module.exports = httpm;
```

---

## 11. 典型使用示例

### 11.1 基础服务 + 路由 + 静态文件

```javascript
const httpm = require('./httpm');
const app = httpm({ rootPath: './public', showDir: true });

// 全局中间件
app.use((req, res, next) => {
  console.log(req.method, req.path);
  next();
});

// 动态路由
app.get('/api/users/:id', (req, res) => {
  const user = null;
  if (!user) return false; // 走静态文件兜底
  res.json(user);
});

app.listen(3000);
```

### 11.2 文件上传

```javascript
app.post('/upload', (req, res) => {
  const { fields, files } = req.formData;
  // 业务处理文件
  res.json({ success: true, fields });
  // 响应结束后临时文件自动删除
});
```

### 11.3 WebSocket 聊天室

```javascript
app.ws('/chat', (ws, req) => {
  ws.send({ type: 'welcome', id: ws.id });
  ws.on('text', msg => {
    app.wss.broadcast('/chat', msg, ws);
  });
});
```

### 11.4 SSE 长推送

```javascript
app.sse('/events', (sse, req) => {
  const timer = setInterval(() => {
    sse.event('time', new Date().toISOString());
  }, 1000);
  return () => clearInterval(timer);
});
```

---

## 12. 补充设计规则与边界约束

1. **路由匹配优先级**：精准静态路由 > 动态参数路由 > ALL 通用路由 > 静态文件服务；同方法同级别路由按注册顺序匹配（先注册先匹配）；
2. **API 兼容**：对齐 Express 常用语法，降低迁移成本；
3. **文件限制**：严格执行单文件、表单字段大小限制，防护超大请求；
4. **编码规则**：所有对外文本、HTML、JSON 默认使用 UTF-8 编码；
5. **WebSocket 约束**：支持分片帧解析（continuation frame），帧负载长度超过 `Number.MAX_SAFE_INTEGER` 时拒绝处理；
6. **临时文件**：所有上传临时文件仅生命周期内有效，请求结束强制清理；
7. **安全防御**：所有 `decodeURIComponent` 调用均有 try-catch 降级处理，防止非法 URI 编码导致请求崩溃；
8. **XSS 防护**：目录列表 HTML 输出使用 `escapeHtml` 转义，防止文件名注入脚本；
9. **Cookie 签名**：签名基于原始值计算，编码后的值不参与签名验证，确保 `encodeURIComponent` 不影响签名一致性；
10. **请求体大小限制**：`_readBody` 方法内置超时保护（默认 30 秒）和流式大小检查，超限时返回 413 状态码；
11. **IPv6 兼容**：`req.hostname` 使用 `new URL()` 解析 Host 头，正确处理 IPv6 方括号语法（`[::1]:8080` → `::1`），并剥离方括号对齐 Express 行为；
12. **Part 头部 DoS 防护**：multipart 解析的 `partHeadersBuf` 累积时校验大小，复用 `maxFieldSize` 作为上限，超限时通过 `safeNext` 销毁请求流主动断开恶意连接，防止恶意超大头部耗尽内存；
13. **redirect 防御**：`res.redirect()` 的 url 为 null/undefined 时回退到 '/'，避免 `encodeURI(undefined)` 返回字符串 `'undefined'` 导致重定向到错误路径；
14. **cookie 防御**：`res.cookie(name, value)` 的 value 为 null/undefined 时回退空字符串，避免 `encodeURIComponent(undefined)` 返回 `'undefined'` 导致 cookie 值错误；
15. **SSE 写入安全**：所有 SSE 写入方法通过 `_write` 统一封装，try/catch 处理底层响应流异常，失败时调用 `close()` 清理连接；send/event 的 data 为 null/undefined 时转为 'null'，避免 `JSON.stringify(undefined)` 返回 undefined 导致 split 抛 TypeError；
16. **未知 HTTP 方法警告**：`_addRoute` 对未支持的 HTTP 方法（如 CONNECT/TRACE）打印警告日志而非静默忽略，便于调用方排查路由未命中问题；
17. **WebSocket 握手写入防御**：`handleUpgrade` 中的 `socket.write` 用 try/catch 包裹，socket 已关闭/已销毁时避免抛 `ERR_STREAM_WRITE_AFTER_END`，握手响应失败时销毁 socket 并返回 null。
18. **Logger 背压检测**：`_writeFile` 检查 `stream.write()` 返回值，`false` 时打印一次背压告警并监听 `drain` 重置标志，避免日志风暴，帮助运维感知高并发日志延迟风险。
19. **WebSocket 无匹配路由立即清理**：`_handleUpgrade` 中无匹配 ws 路由时，`ws.close()` 后立即调用 `_removeConnection(ws)` 从连接池移除，避免依赖 close 事件异步清理的短暂内存占用（`_removeConnection` 幂等，close 事件再次调用安全）。
20. **目录列表链接尾部斜杠**：`_renderDirectoryHTML` 生成的子目录 href 必须以 `/` 结尾（如 `/subdir/nesteddir/`），对齐 Express serve-static 行为，避免浏览器点击目录链接时多一次请求往返（先请求 `/foo` 再重定向到 `/foo/`）。
21. **CORS origin 函数异常保护**：`_applyCORSHeaders` 调用用户提供的 `cors.origin` 函数时用 try/catch 包裹，函数抛异常时按拒绝跨域处理（不设置 ACAO 头）并记录告警日志，CORS 是附加安全层其异常不应阻断主请求。
22. **async handler cleanup 竞态保护**：`app.ws`/`app.sse` 注册的 async handler 返回的 cleanup 函数，在 `Promise.resolve(ret).then(...)` 注册前需检查连接状态：WebSocket 检查 `ws._closed`、SSE 检查 `sseInstance.connected`，已关闭时立即调用 cleanup 避免资源泄漏（close 事件已触发后 `on('close')` 注册的监听器永不执行）。
23. **async handler 重复错误处理防护**：`_dispatch` 中 async handler 的 `.catch` 回调必须检查 `handlerCalledNext` 标志，handler 已通过 `next(err)` 传递错误时跳过 `_handleError` 调用，避免错误处理中间件被重复执行（与 sync catch 块的 `if (handlerCalledNext) return` 保持一致）。
24. **WebSocket head 喂入异步化**：`WebSocketServer.handleUpgrade` 中将 head 数据喂给 `_parseFrames` 时必须用 `process.nextTick` 异步化，确保 `_emit('connection')` 回调和 `app.ws()` handler 同步注册 `text`/`data` 监听器后再解析 head，避免 pipeline 客户端首帧事件被 `_emitEvent` 静默丢弃。
25. **res.send(null) 对齐 Express**：`Response.send(null)` 必须发送空字符串（Content-Length: 0），而非 `'null'` 字符串。Express 4.x 在 `case 'object'` 分支将 null 转为空字符串，与 `JSON.stringify(null) = 'null'` 行为不同。
26. **SSE.close 异常保护**：`SSE.close` 必须在调用 `res.end()` 前检查 `res.finished || res.writableEnded`，已 finished 时直接跳过 end 调用，避免触发 `ERR_STREAM_WRITE_AFTER_END` 异步 'error' 事件（try/catch 只能捕获同步抛出，无法捕获异步 'error' 事件，会导致底层 socket 强制关闭，客户端收到 aborted 错误）。try/catch 作为双重保护兜底其他异常。
27. **WS Origin 拒绝响应**：`WebSocketServer.handleUpgrade` 中 Origin 校验拒绝时必须用 `socket.end('HTTP/1.1 403...')` 替代 `write+destroy`，`end` 会在数据刷出后自动关闭 socket，避免 `destroy` 立即关闭导致客户端收不到 403 响应。
28. **isPathSafe 拒绝 null byte**：`isPathSafe` 必须显式拒绝路径含 `\0` 的请求，部分 fs API（如旧版 Node）会截断含 null byte 的路径，可能导致路径注入。明确拒绝比依赖底层 fs 行为更安全。
29. **cookie 对象值 JSON 序列化异常保护**：`Response.cookie` 对象值进行 `JSON.stringify` 时必须 try/catch，循环引用等异常场景抛 TypeError，回退到空字符串避免冒泡到调用方。
30. **WebSocket close 定时器 unref**：`WebSocket.close` 的 2 秒超时定时器必须调用 `unref()`，防止定时器阻止进程退出（测试场景下断开所有连接后进程应能立即退出）。
31. **HTTP/2 socket 兼容**：`Request.ip`/`Request.protocol` 必须兼容 HTTP/2 模式，HTTP/2 模式下 `IncomingMessage.socket` 为 `undefined`，需通过 `req.stream?.session?.socket` 回退获取底层 TCP socket。
32. **cookie expires 归一化**：`res.cookie()` 的 `expires` 选项支持 Date 对象/数字时间戳/字符串，统一归一化为 `Date.toUTCString()`；无效日期不输出 `Expires` 头避免 Set-Cookie 解析失败。
33. **cookie sameSite 白名单归一化**：`res.cookie()` 的 `sameSite` 必须归一化为小写并仅接受 `strict`/`lax`/`none` 白名单值，避免 `'lax'`/`'NONE'` 等非标准大小写被发送。首字母大写输出（`Strict`/`Lax`/`None`）符合 RFC 6265bis。
34. **cookie 头注入防护**：`res.cookie()` 的 `path`/`domain` 必须拒绝含 `;`、`,`、空白字符的值，这些字符会破坏 Set-Cookie 头结构（攻击者可通过 `path="/foo;Domain=evil.com"` 污染其他域名 Cookie），违规时仅打印警告日志不输出头。
35. **multipart fileInfo 时序**：`_parseMultipart` 在 `stream.end()` 前后同步 push fileInfo 是有意的设计决策，原因是 `res.on('finish', () => _cleanupTempFiles(req._tempFiles))` 需要完整列表；极端 race（end 后立即磁盘满）通过 ensureFileStream 的 error handler 缓解（safeNext → 500 响应，handler 不会执行）。
36. **sendFile 错误回调统一传递**：`httpm.static()` 中间件与 `Application._serveStatic` 兜底处理中调用 `res.sendFile()` 时必须传递错误回调。`staticMiddleware` 错误回调调用 `next(err)` 进入中间件错误链；`_serveStatic` 错误回调调用 `this._handleError(err, req, res, [], 0)` 进入应用级错误处理。两者均避免 sendFile 内部异常（路径遍历校验、同步抛错等）冒泡到上层导致未捕获异常。
37. **目录列表父目录链接尾斜杠**：`_renderDirectoryHTML` 生成的父目录链接 `parentHref = prefix + '../'` 必须以 `/` 结尾，与子目录链接保持一致，避免浏览器多一次重定向往返。
38. **_handleRequest 顶层 catch 响应规范化**：`_handleRequest` 顶层 catch 块在响应头未发送时除设置 500 状态码外，还应显式设置 `Content-Type: text/plain; charset=utf-8` 避免客户端 MIME 嗅探误判，HEAD 请求只发头部不发送响应体（与 `response.end()` 在 HEAD 路径下的行为一致）。
39. **httpm 入口 JSDoc 完整**：`httpm` 入口函数必须有完整 JSDoc 文档，包括所有配置项（svrPort/logLevel/cors/useBodyParser/cookieParserSecret/wsHeartbeatInterval/trustProxy/http2 等）、配置优先级、返回值类型与示例代码，支撑 IDE 智能提示和 TypeScript 类型推导。
40. **Request.protocol HTTP/2 兼容**：`Request.protocol` getter 必须与 `Request.ip` 保持一致的 HTTP/2 兼容回退，通过 `req.stream?.session?.socket` 获取底层 TCP socket 判断 `encrypted` 属性。HTTP/2 模式下 `IncomingMessage.socket` 为 `undefined`，直接访问会导致 protocol 永远返回 `'http'`（即使 HTTP/2 over TLS）。
41. **_handleError 响应头已发送时强制结束连接**：`_handleError` 在 `res.headersSent === true` 时无法再设置状态码/响应体，必须调用 `res._res.end()` 强制结束底层连接，避免客户端因等待响应体而挂起。try/catch 兜底底层连接已关闭等异常场景，保证 `_handleError` 自身永不抛错。
42. **_defaultHandler 405 响应补充 CORS 头**：`_defaultHandler` 对已知方法（POST/PUT/DELETE/PATCH）无匹配路由返回 405 时，除 RFC 7231 要求的 `Allow` 头外，当 `settings.cors` 启用时还须设置 `Access-Control-Allow-Methods` 头，使跨域浏览器能正确读取该路径允许的方法列表（与 OPTIONS 预检的 Allow-Methods 头保持一致）。
43. **WebSocket maxPayload 超限检查前移**：`_decodeFrame` 中 `payloadLength > maxPayload` 检查必须在掩码解析和数据完整性检查之前执行，防止慢速大帧攻击。攻击者声明大 `payloadLength`（如 200MB）但慢速发送少量数据，若等数据完整再拒绝，缓冲区会持续增长到声明大小才拒绝，`maxPayload` 防护失效。检查前移后仅需解析长度字段即可短路，`bytesConsumed` 设为 `buf.length` 消费整个缓冲区避免循环继续解析干扰关闭流程，立即 `close(1009)`。
44. **WebSocket 分片累积总量限制**：`_processFrame` 处理分片续帧时必须通过 `_fragmentTotalSize` 累积器校验累积总大小，超过 `maxPayload` 时清理分片状态（释放已累积的 payload 引用避免内存泄漏）并 `close(1009)`。单个分片虽通过 `_decodeFrame` 的单帧 `maxPayload` 检查，但攻击者可发送大量小分片（每个 < `maxPayload`）累积成巨大消息，最后 `Buffer.concat` 时耗尽内存。分片开始时初始化 `_fragmentTotalSize` 为首个分片大小，续帧时累加。
45. **`_streamFile` 流完成时必须移除 error/close 监听器**：`_streamFile` 在 `this._res` 上注册 `error`、`close`、`finish` 监听器，`finish` 回调中必须 `removeListener` 移除 `error` 和 `close` 监听器。不移除时 `finish` 后 `close` 事件仍会触发 `onDestError` 执行不必要的 `stream.destroy()`，且 ServerResponse 上监听器引用累积导致内存泄漏。与 Gzip 流（`sendFile` 中的 Gzip 分支）处理方式保持一致，确保所有流式响应统一清理监听器。
46. **WebSocket `send` 对象序列化必须 try/catch 保护**：`WebSocket.send(data)` 中对普通对象调用 `JSON.stringify(data)` 时，循环引用对象（如 `req`、`res`、含自引用的对象）会抛 `TypeError: Converting circular structure to JSON`。必须用 try/catch 包裹，失败时通过 `_emit('error', err)` 触发 error 事件让调用方感知，而非让异常冒泡导致进程崩溃。与 `Response.json` 的循环引用保护策略一致。
47. **`res.append` / `res.type` 必须校验 null/undefined 参数**：`res.append(field, value)` 中 `field` 为 null/undefined 时 `this.getHeader(field)` 抛 TypeError；`res.type(contentType)` 中 `contentType` 为 null/undefined 时 `contentType.includes('/')` 抛 TypeError。两个方法开头必须添加 `if (!field) return this;` / `if (!contentType) return this;` 防御，与 `res.set` 的防御性编程风格一致，确保 null/undefined 入参静默返回而非抛异常。
48. **`_handleRequest` 顶层 catch 必须设置 `Connection: close`**：顶层 catch 返回 500 响应时必须设置 `Connection: close` 头。顶层 catch 意味着请求处理异常（`req.body` 可能部分解析、临时文件可能残留、中间件状态可能不一致），复用此 keep-alive 连接的后续请求会在污染状态上执行。强制关闭连接让客户端新建连接，避免状态污染扩散。
49. **Logger 跨日切换旧流 `destroy` 必须 try/catch 保护**：`_getLogStream` 跨日切换时 `oldStream.end(() => oldStream.destroy())` 中，`destroy()` 通常不抛异常，但流已损坏或 fd 已释放时可能抛。跨日切换是日志核心路径，异常会导致 `end` 回调中断、后续日志全部丢失。必须用 `try { oldStream.destroy(); } catch (e) { /* 忽略 */ }` 包裹，确保跨日切换健壮。
50. **统一使用 `writableEnded` 替代废弃的 `finished` 属性**：Node.js 16+ 废弃了 `ServerResponse.finished`，推荐使用 `writableEnded`。`Response.finished` getter 应返回 `this._res.writableEnded || this._res.destroyed`（`destroyed` 覆盖 socket 异常关闭场景）；`Response._send` 和 `SSE.close` 中的 `this._res.finished` 检查统一改为 `this._res.writableEnded`。确保前向兼容 Node.js 未来版本。
51. **WebSocketServer 心跳定时器必须 `unref`**：`_startHeartbeat` 中 `setInterval` 创建的定时器必须调用 `unref()`，防止定时器阻止进程退出。场景：测试中断开所有连接后未调用 `app.close()`，或异常退出时进程被心跳定时器"吊住"。与 `WebSocket._closeTimer` 的 `unref` 处理保持一致。
52. **`handleUpgrade` 必须在 ws 创建后立即注册 `close` 监听器**：WebSocket 构造函数内部已监听 socket `close` 事件并触发 `_emitClose`，若 WebSocketServer 的 `ws.on('close', () => this._removeConnection(ws))` 注册过晚，极端竞态下（socket 在同步代码执行期间进入关闭流程）close 事件会丢失监听器，导致连接永远停留在 `connections` Map 中（内存泄漏）。必须在 `new WebSocket()` 之后立即注册 close 监听器，再做 head 处理、`connections.set`、分组、心跳。
53. **`sendFile` HEAD 请求必须跳过 Gzip 分支**：HEAD 请求不传输实体无需压缩，且流式 Gzip 无法预知压缩后大小。若 HEAD 进入 Gzip 分支，会因未移除 `Content-Length` 导致响应头（`Content-Length: stat.size` 未压缩大小）与 GET 实际返回的压缩内容大小不一致，违反 HTTP 语义。Gzip 判断条件必须包含 `!this._isHead`，让 HEAD 走 `_streamFile` 快速路径返回 `Content-Length: stat.size` 且无 `Content-Encoding` 头，符合业界主流服务器行为。
54. **WebSocket 必须监听 socket `end` 事件并主动销毁**：客户端正常断开（TCP FIN）时，服务端 socket 先触发 `end` 事件再触发 `close` 事件。若仅监听 `close`，Windows 等 platform 上 socket 可能停留半开状态延迟触发 `close`，导致 `server._connections` 不归零、`server.close()` 挂起（连接泄漏）。WebSocket 构造函数必须在 `socket.on('close')` 之外额外注册 `socket.on('end', () => { this.connected = false; socket.destroy(); })`，收到 FIN 立即销毁 socket 加速清理。WebSocket 协议无半关闭语义，客户端 FIN 即视为断开连接，主动销毁安全。与 ws 库等主流实现行为一致。
55. **WebSocket handler 的 req 必须为 httpm Request 实例**：`_handleUpgrade` 必须在握手前将原生 `http.IncomingMessage` 包装为 `new Request()`，设置 `req._app = this`，补全 `req.query`（parseUrl 解析）、`req.path`（decodeURIComponent 解码，非法编码保留原值），并在 `useCookieParser !== false` 时复用 `cookieParser` 中间件解析 `req.cookies`/`req.signedCookies`。确保 `app.ws` handler 与 `wss.on('connection')` 监听者收到的 req 和普通路由 req 属性一致。底层 socket 不通过 req 暴露（Request 无 socket getter），业务方应使用 `ws.socket` 访问（符合 WebSocket 语义）。`body`/`files`/`formData` 保持 Request 构造函数初始值（升级请求无 body，不走 bodyParser）。
56. **ALL 路由优先级恒最低**：`Router.match()` 中 ALL 路由必须追加在特定方法路由（GET/HEAD 等）之后，确保同一路径同时注册 ALL 与特定方法路由时，特定方法路由始终先执行（即使 ALL 注册在前）；ALL 路由之间仍按注册顺序匹配。对齐 README 声明"精准静态路由 > 动态参数路由 > ALL 通用路由 > 静态文件服务"。
57. **错误处理中间件 `next()` 无参必须链式传递**：错误处理中间件调用 `next()` 无参（Express 语义：错误已处理）时，必须通过递归调用 `_handleError(err, req, res, stack, i+1)` 向后查找下一个错误处理中间件；若后续无错误处理中间件，由 `_defaultErrorResponse` 兜底返回默认错误响应，避免请求挂起。
58. **原型污染防护**：`parseQuery`（**有等号与无等号两个分支均须过滤**）/`parseCookies`/multipart 字段赋值/JSON 与 urlencoded 合并到 `formData.fields` 时，必须拒绝 `__proto__`/`constructor`/`prototype` 危险键（跳过不写入），防止攻击者通过请求参数覆盖对象原型导致越权访问。测试断言须用 `Object.hasOwn()` 判断（`obj.__proto__` 访问的是原型链访问器，永远非 undefined）。
59. **HTTPS 证书支持 Buffer 与路径两种形式**：`listen()` 中 `https.key/cert/ca/pfx` 必须兼容 `fs.readFileSync` 读取后的 Buffer 与文件路径字符串两种配置（README 示例传入 Buffer），通过 `loadCredential(v) => Buffer.isBuffer(v) ? v : fs.readFileSync(v)` 统一处理，避免将 Buffer 当作路径二次读取抛 ENOENT。
60. **WebSocket allowedOrigins 必须精确匹配**：`handleUpgrade` 中 Origin 校验必须将 `wsAllowedOrigins` 归一化为数组后做精确匹配（`includes`），配置为字符串时直接 `includes` 会因子串匹配被恶意站点绕过（如白名单 `https://a.com`，`https://a.com.evil.com` 也通过）。
61. **redirect/cookie 特殊类型防御**：`res.redirect()` 的 url 必须剔除 `\r`/`\n`（Node `setHeader` 遇换行抛 TypeError）；`res.cookie()` 的 value 必须经 `String()` 转换后再 `encodeURIComponent`，避免 Symbol 类型抛 TypeError。
62. **_readBody 监听器显式清理**：`_readBody` 的 `data`/`end`/`error` 监听器必须使用命名回调并在正常完成/超时/超限/错误四条路径统一移除（`cleanupListeners`），避免请求流 destroy 后残留监听器。
63. **_getAllowedMethods ALL 路由用 some**：ALL 路由集合用 `some()` 判断任一命中即代表该路径支持所有方法（结果集相同），替代逐个 `exec` + `break`，语义更清晰。

---

## 13. 版本与包说明

### package.json 配置


```json
{
  "name": "@lzpong/httpm",
  "version": "X.Y.Z", // X.Y.Z 为实际版本号
  "main": "httpm.js",
  "keywords": ["http", "server", "websocket", "sse", "middleware", "single-file"],
  "engines": { "node": ">=18.0.0" },
  "license": "MIT"
}
```

### 运行要求

- 运行环境：Node.js 18.0 及以上版本；
- 依赖：纯原生模块，无第三方依赖；
- 分发形式：单一 `httpm.js` 文件，可直接拷贝引入项目。