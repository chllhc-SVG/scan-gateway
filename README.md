# scan-gateway —— 独立扫码网关

为"数字人共享终端接待"提供扫码身份确认能力，**与 MCP 平台完全解耦**：
独立的进程/容器、端口、依赖；MCP 平台重启/升级不影响接待中的扫码会话。

## 与数字人客户端的协议（保持不变）

客户端只对接两个接口（`packages/web-app/src/client/machine-scan.ts`）：

| 接口 | 说明 |
|---|---|
| `POST /raphael-healing/api/v1/machine-scan/session/create` | 创建会话，返回 `sessionId` + `qrcodeBase64`（**真实 PNG 二维码**，qrcode 库生成） |
| `GET  /raphael-healing/api/v1/machine-scan/session/status?sessionId=` | 客户端 2s 轮询，`WAITING → SCANNED → SUBMITTED` |

`SUBMITTED` 时携带 `userId`（手机号）与 `userInfo`（`phone` / `nickname`），
数字人端写入 machine-scan store，后续 MCP 转发自动注入
`X-Customer-Phone` / `X-Customer-Name` / `X-Session-Id`。

## 扫码流程

1. 数字人屏幕弹二维码（内容 = 本网关的 H5 登记页 URL）
2. 手机相机 / 微信扫码 → 打开 `GET /m/scan/:sessionId` 登记页（同时状态变 `SCANNED`）
3. 填姓名（可选）+ 手机号 → 提交
4. 客户端轮询到 `SUBMITTED` → 数字人自动进入对话

## 启动方式

### 方式 A：Docker（推荐）

```bash
cd scan-gateway
pnpm docker:dev        # 前台运行，看日志
# 或
pnpm docker:up         # 后台运行
pnpm docker:logs       # 跟踪日志
pnpm docker:down       # 停止并移除容器
```

容器把 `0.0.0.0:3101` 映射到宿主机，手机通过局域网 IP 即可访问登记页。

### 方式 B：Node 直跑

```bash
cd scan-gateway
pnpm install
pnpm start             # 或 pnpm dev（--watch 模式）
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SCAN_GATEWAY_PORT` | `3101` | 监听端口 |
| `SCAN_GATEWAY_HOST` | `0.0.0.0` | 必须绑 0.0.0.0，手机才能通过局域网打开登记页 |
| `SCAN_SESSION_TTL_MS` | `300000` | 会话有效期（5 分钟） |

## 数字人端配置

设置 →「扫码登录」→ 打开"启用小程序扫码登录" →
扫码网关地址填 **本机局域网 IP**（不要填 127.0.0.1 / localhost，
否则二维码内容是 `http://127.0.0.1:3101/...`，手机扫码后打不开），例如：

```
http://192.168.x.x:3101
```

查本机局域网 IP：`ipconfig` 里"无线局域网适配器 WLAN"的 IPv4 地址。

## 接生产小程序后端

二维码内容由网关生成；切回真实微信小程序码时，把数字人端
"扫码网关地址"指向 raphael-healing 后端即可，客户端零改动。
本服务仅用于本地/内网演示与联调。
