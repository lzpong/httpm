# httpm 项目详细设计文档

**文档类型**：软件开发详细设计文档

**文档版本**：V1.3.2

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
| WebSocket | 遵循 RFC 6455 标准，支持路径分组、全局广播、统一心跳保活机制 |
| SSE | 轻量化 Server-Sent Events 实现，简化长推送开发 |
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
3. 将占位符替换为正则捕获组 `([^/]+)`；
4. 生成完整正则对象用于路径匹配。

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
- **数组**（如 `['https://a.com', 'https://b.com']`）：检查请求 Origin 是否在列表中，匹配则回显该 Origin，并附加 `Vary: Origin` 头；
- **函数**（如 `origin => origin.endsWith('.com') ? origin : '*'`）：动态计算 Allow-Origin 值。

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
- `req.ip`：	   客户端 IP 地址
- `req.hostname`： 请求域名
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
| send(data) | 通用输出，支持字符串、HTML、Buffer、对象；`null` 序列化为 `"null"`（Express 兼容），`undefined` 返回空响应 |
| sendFile(path, options, [callback]) | 发送本地文件，内置断点续传、缓存、Gzip 能力；options 支持 `{ root, contentType }`；callback(err) 在完成/出错时调用 |
| download(path, [filename], [options]) | 触发浏览器文件下载，支持断点续传；兼容 Express 签名，options 传递给 sendFile |
| redirect([code,] url) | 重定向响应，兼容 Express 签名：`redirect(url)` 默认 302，`redirect(status, url)` 指定状态码 |
| location(url) | 设置 Location 响应头（不发送响应，常与 send 配合） |
| sse() | 创建 SSE 推送实例 |
| cookie(name, value, opts) | 设置响应 Cookie；opts 支持 `maxAge`（秒，写入 Max-Age）、`expires`（Date 对象，写入 Expires）、`domain`、`path`、`secure`、`httpOnly`、`sameSite`、`signed`；对象 value 自动 JSON 序列化，signed 启用 HMAC-SHA256 签名（`s:` 前缀） |
| append(field, value) | 追加响应头值（不覆盖已有值，适用于 Set-Cookie 等多值头） |
| locals | 请求级数据传递对象（中间件间共享数据），初始为 `Object.create(null)` |

#### sendFile 核心逻辑

1. **Range 断点续传**：识别请求 `Range` 头，返回 206 分段响应；
2. **缓存校验**：通过 ETag、Last-Modified 校验，命中缓存返回 304；
3. **Gzip 压缩**：对文本类文件，根据客户端 `Accept-Encoding` 自动开启压缩；
4. **HEAD 请求**：匹配 GET 路由但仅发送响应头，不发送响应体（Express 兼容行为）。

### 3.5 SSE 类

#### 类职责

实现 **Server-Sent Events** 服务端单向长推送协议，封装协议头、消息发送、连接管理能力。

#### 核心设计

1. 实例化时自动设置 SSE 标准响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`（仅在 headers 未发送时设置）；
2. 内置连接状态标识 `connected`，标记连接是否正常；
3. 监听 `close` 和 `aborted` 事件，兼容 HTTP/1.1 和 HTTP/2 连接断开检测；
4. 支持标准 SSE 消息格式、自定义事件、重连时间配置。

#### 核心方法

- `send(data)`：		发送普通消息，自动兼容字符串 / JSON 对象；
- `event(name, data)`： 发送自定义命名事件；
- `retry(ms)`：			设置客户端重连间隔（毫秒）；
- `comment(text)`：		发送注释消息（可作为心跳保活）；
- `close()`：			主动关闭 SSE 连接，自动移除 `close`/`aborted` 事件监听器防止内存泄漏。

#### 使用规则

注册 SSE 路由时，支持返回清理函数，连接断开后自动执行资源回收。

### 3.6 WebSocket 与 WebSocketServer 类

#### 3.6.1 WebSocket 类

遵循 **RFC 6455** 标准实现 WebSocket 单连接管理。

1. 核心属性：原生 socket、连接路径、唯一 ID、连接状态（connected / _closing / _closed）、心跳时间戳；
2. `send(data)` 方法：自动区分文本、JSON 对象、二进制 Buffer，匹配对应帧类型；
3. `close(code, reason)` 方法：先发送 Close 帧（此时 connected 仍为 true），再标记 connected=false、_closing=true，限时 2 秒等待对端 Close 帧，超时则强制销毁 socket；
4. Close 帧状态码：对端发送无状态码的 Close 帧时，默认为 1005（RFC 6455 规定的"无状态码"语义码），非法状态码（0-999）自动修正为 1005；
5. RFC 6455 Section 7.4.1 规定：1005（无状态码）和 1006（异常关闭）不得在 Close 帧中发送，httpm 在回复 Close 帧时会自动将这两种状态码替换为不携带状态码的 Close 帧；
6. 关闭握手期间（_closing=true）：忽略非控制帧，仅处理 Ping/Pong/Close 帧；
7. 帧负载长度超过 `Number.MAX_SAFE_INTEGER` 时视为超限帧，拒绝处理；
8. 支持分片帧解析（continuation frame），多帧消息自动合并后触发事件；
9. 发送失败时触发 `error` 事件，便于用户感知和处理异常；
10. 监听底层套接字事件，处理消息接收、连接断开。

#### 3.6.2 WebSocketServer 类

全局 WebSocket 服务管理类，统一管理所有长连接：

1. 连接分组：按请求路径对连接分组，支持按路径广播消息；
2. 统一心跳：全局唯一心跳定时器，有连接则启动，无连接则停止，减少资源占用；
3. 广播能力：支持**按路径广播**、**全局广播**，支持排除指定连接；
4. 连接管理：新增 / 销毁连接时自动维护连接列表；
5. Origin 校验：支持 `allowedOrigins` 配置，防止跨站 WebSocket 劫持（CSWSH）；
6. 帧负载限制：支持 `maxPayload` 配置，防止恶意超大帧耗尽内存。

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
  cors: { origin: '*', headers: 'Content-Type, Authorization', maxAge: 86400 },

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

---

## 8. 通用工具函数设计

所有工具函数为内部公共能力，同时对外导出供二次使用：

1. **`parseUrl`**：解析 URL，拆分路径与 Query 参数，自动去除 `#` 片段；
2. **`_parseQueryString`**：解析查询字符串为键值对象，支持 `+` 转空格，内置 `decodeURIComponent` 异常降级；
3. **`parseCookies`**：解析 Cookie 字符串为键值对象；
4. **`getMimeType`**：根据文件后缀匹配标准 MIME 类型；
5. **`fmtSize`**：字节单位格式化（B/KB/MB/GB/TB），智能小数位处理；
6. **`fmtTime`**：毫秒时间格式化（ms/s/m）；
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
httpm.WebSocketHandShak = WebSocketHandShak;
httpm.escapeHtml = escapeHtml;
httpm.version = '1.3.2';

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
10. **请求体大小限制**：`_readBody` 方法内置超时保护（默认 30 秒）和流式大小检查，超限时返回 413 状态码。

---

## 13. 版本与包说明

### package.json 配置


```json
{
  "name": "@lzpong/httpm",
  "version": "1.3.2",
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