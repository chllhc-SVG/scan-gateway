# scan-gateway 扫码网关

顾客用手机扫数字人屏幕上的二维码，填姓名和手机号，数字人就知道现在接待的是谁。

这个服务是独立的，跟 MCP 平台没关系。平台重启、升级，这里正在扫的码不受影响。端口是 3101。

## 目录

```text
src/index.js          后端逻辑，一个文件，没用框架
Dockerfile            打镜像用
docker-compose.yml    启动用
package.json          只依赖 qrcode，用来生成二维码图片
```

## 流程

一共四步：

1. 数字人屏幕上弹出二维码。内容其实就是一个网页地址，比如 `http://192.168.1.20:3101/m/scan/mscan_xxx`。
2. 顾客用微信或相机扫码，手机打开这个网页，是一张登记表。打开网页这个动作，状态就从 WAITING 变成 SCANNED。
3. 顾客填姓名和手机号，点确认登记。姓名必填，手机号必须是 1 开头的 11 位。后端会再校验一遍。
4. 数字人每 2 秒问一次网关“填完了吗”，问到 SUBMITTED 就把身份记下来，关掉二维码，进入对话。

状态就四个：WAITING（刚出码）、SCANNED（打开了网页）、SUBMITTED（填完了）、EXPIRED（过期了，5 分钟没填完就会过期，过期后数字人会自动出一张新码，不用管）。

数据存在内存的一个 Map 里，不写数据库。网关一重启，正在扫的码就作废，得重新扫。这个是故意的，登记信息没必要存下来。

## 二维码

二维码是 `qrcode` 库生成的 PNG，直接转成 base64 给前端，`qrcodeBase64` 字段，前端拿来就能显示，不用存文件。

注意一个容易踩的坑：二维码里的地址，是网关看“你是用什么地址调它的”现拼的。你在数字人设置里填 `http://127.0.0.1:3101`，二维码里就是 127.0.0.1，手机扫完肯定打不开。所以网关地址一定要填电脑的局域网 IP，比如 `http://192.168.1.20:3101`，手机和电脑连同一个 WiFi。

## 接口

前缀是 `/raphael-healing/api/v1/machine-scan`，跟生产小程序后端对齐，以后切生产，客户端不用改。

| 接口 | 干嘛 |
|---|---|
| `GET /health` | 看服务活着没，顺带看内存里有几个会话 |
| `POST .../session/create` | 建会话，返回 sessionId、二維碼 base64、网页地址、过期时间 |
| `GET .../session/status?sessionId=xxx` | 查状态，数字人每 2 秒问一次。SUBMITTED 时会带 userId（就是手机号）和 userInfo（phone、nickname） |
| `GET /m/scan/:sessionId` | 二维码指向的登记页，手机打开的就是它 |
| `POST .../session/submit?sessionId=xxx` | 登记页提交，body 是 `{ phone, name }` |

拿 curl 就能测通：

```bash
BASE=http://192.168.1.20:3101/raphael-healing/api/v1/machine-scan
curl -X POST $BASE/session/create
SID=mscan_xxx  # 换成上一步返回的
curl "$BASE/session/status?sessionId=$SID"
curl -X POST "$BASE/session/submit?sessionId=$SID" -H 'Content-Type: application/json' -d '{"phone":"13800138000","name":"王女士"}'
curl "$BASE/session/status?sessionId=$SID"
```

## 数字人那边怎么用

数字人只调上面两个接口：create 建码，status 轮询。扫完后把 userId 和 userInfo 放进内存（Pinia 的 machine-scan store，只放内存，不存硬盘，换账号、退出、结束会话都会清空）。

之后每次调 MCP 工具，都会在请求头里带上：

```text
X-Agent-Code      哪台数字人，比如 hsh
X-Customer-Phone  顾客手机号
X-Customer-Name   顾客称呼
X-Session-Id      哪一路对话，防止多路串了
```

手机号不会发给大模型，只在“客户端调预约服务”这一步出现在请求头里。知识库这些服务收到了也不会看，只认 X-Agent-Code。

弹码有两个时机：启动时如果有工具勾了“顾客身份”，会先弹码再对话；对话中如果预约工具返回 IDENTITY_REQUIRED，会中途弹码。都是同一个弹窗。

## 启动

推荐用 docker：

```bash
cd scan-gateway
pnpm docker:up     # 后台起
pnpm docker:logs   # 看日志
pnpm docker:down   # 停
```

直接跑也行：

```bash
pnpm install
pnpm start
```

环境变量三个，默认值一般不用改：

```text
SCAN_GATEWAY_HOST=0.0.0.0   必须 0.0.0.0，不然手机连不进来
SCAN_GATEWAY_PORT=3101
SCAN_SESSION_TTL_MS=300000  5 分钟过期
```

数字人设置里：扫码登录打开，网关地址填 `http://局域网IP:3101`。查 IP 用 `ipconfig`，看 WLAN 那行的 IPv4。电脑防火墙要放行 3101。

## 常见问题

手机扫码打不开：大概是网关地址填了 127.0.0.1，或者手机和电脑不是一个 WiFi，或者防火墙拦了。先在手机浏览器里直接打开二维码里的地址试试。

打开显示会话过期：超过 5 分钟了，或者网关重启过。数字人会自动出新码，重新扫就行。

填完没反应：看提示，手机号格式不对或姓名没填。后端返回的 msg 会直接弹出来。

屏幕一直显示等待扫码：顾客扫了但没点开链接，SCANNED 是靠打开网页触发的。或者弹窗关了轮询就停了。

扫完预约还问手机号：预约那边配的是 personal 模式（数字人即顾客，不用扫码身份），或者身份被清空了。先看预约 compose 里的 IDENTITY_MODE。
