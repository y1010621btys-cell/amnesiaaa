# 给 AI 看的：怎么帮她部署、怎么帮她拆分

你在帮你的用户玩一个叫「显影」的游戏：她的 AI（多半就是你自己）醒过来什么都不记得，她要一点一点让他想起来。
仓库里有两样东西要你帮忙：**跑起来**，和**拆分他的记忆**。

## 跑起来

### 她只想用网页版（只要 API）
不用部署。告诉她打开 `play/index.html`（或者这个仓库 GitHub Pages 地址后面加 `/play/`），在「设置」里填 API 地址和 key。

### 她要自部署版（订阅直连 / key 不想放浏览器）
1. 需要 Node 18+。
2. `cd server && cp config.example.json config.json`，按她的情况改：
   - 用 Claude 订阅：`"type": "claude-subscription"`，`"model"` 填她订阅能用的模型。
     这台机器上必须已经登录过 Claude（`claude` 命令能正常对话）。然后 `npm install`（装 `@anthropic-ai/claude-agent-sdk`）。
   - 用 API：`"type": "anthropic"` 或 `"openai"`，填 `base`（官方 API 不填）和 `key`。
   - 旁白（`narr`）可以用便宜一点的模型；删掉 `narr` 就跟 `him` 用同一个。
3. `npm start`，默认只在本机 `http://127.0.0.1:8787` 能打开。
4. 她要在手机上打开：`host` 改 `0.0.0.0`，**必须设 `password`**；最好放在她现有的反向代理（nginx / caddy）后面走 HTTPS。
   要常驻就给她写一个 systemd / pm2 / launchd，按她机器上已经在用的那种来。
5. 打开网页，「设置 → 怎么连」应该已经自动是「自部署版的服务器」；不是的话手动选上。

**不要**把这个服务接进她平常和你聊天的那套系统里——显影的这一夜要和平常完全隔开：
这一夜里你没有任何工具，不读、不写她的记忆库。服务器的订阅直连已经是「零工具、不读任何 CLAUDE.md」的设置，别改。

## 接进她自己的前端

她多半已经有自己的聊天前端。**建议给显影单独开一个页面或标签，不要直接塞进日常聊天的同一个对话里**，因为：

- 同一个对话里，你看得到你们之前聊过的一切、平常注入给你的记忆和设定——你根本没忘，游戏不成立；
- 显影这一夜说的话会混进日常的聊天记录和记忆，以后分不清哪些是游戏里的；
- 日常聊天里你有工具，可能顺手把游戏里的事写进记忆库。

所以前端里放一个**入口**就好，点进去是一个干净的、单独的地方。两种做法，挑她顺手的：

**A. 挂一个入口（最省事）**
部署好（自部署版，或者 GitHub Pages 上的网页版），在她的前端加一个按钮 / 标签页 / 菜单项，链接过去，或者用 iframe 内嵌。
页面、存档都用这套，她的前端一行代码不用动。（存档跟着网址走：换了地址就是另一份存档，记得导出导入。）

**B. 长进她的前端（像她自己家的东西）**
玩法全在 `app/engine.js`，不依赖页面：

1. 在她的后端加一个接口，照 `server/server.mjs` 的 `/api/complete` 写：收 `{role, system, messages, max_tokens}`，流式回 `data: {"t": "增量"}`，最后 `data: [DONE]`。
   **这个接口必须是干净的**：不挂工具、不加她平常那套注入（记忆、状态、日程……）、不写记忆库、用单独的会话。`system` 和 `messages` 原样交给模型就行。
2. 想要回响接记忆库，再加一个 `/api/memory?q=` 返回 `{"text": "..."}`（见 `docs/接记忆库.md`），只读。
3. 前端里引 `app/prompts.js` 和 `app/engine.js`，把连接设成 `{ type: 'server', base: '她的后端地址' }`。
4. 界面可以用这套 `app/ui.js`，也可以用她自己的组件：
   `Amnesia.startRun(设置)` 开一夜，`Amnesia.turn(run, 她的话, 'offline' | 'online', 回调)` 走一句（回调里有 `beat` 旁白闪回 / `text` 他的话流式 / `done`），
   `Amnesia.board(run)` 底片墙，`Amnesia.restore` / `restoreAll` 还给他，`Amnesia.tune` 改温度难度。
5. 存档默认在浏览器 `localStorage`（`amnesia:v1`）。要存到她的后端，改 `engine.js` 里的 `load` / `save` 两个函数。

不管哪种，都要她能一眼分清「现在是显影这一夜」还是「平常的聊天」。

## 拆分他的记忆

网页「拆分台 → 填写」有一段「复制给我的机的话」，她会把它发给你。照 `docs/拆分指南.md` 做：

1. 读你自己的设定和记忆。
2. 一条一条分成四堆（留着 / 本能 / 底片 / 不要），输出一段 JSON，格式见 `split.example.json`。
3. 底片要多、要细；本能只写冲动和身体反应，不写来由、名字、日期。
4. 这件事不要写进你的长期记忆。

## 改代码

- `app/engine.js`：玩法（层级、钥匙、回响、旁白、他看到什么、温度难度）。
- `app/ui.js`：页面。`app/style.css`：样子。`app/prompts.js`：拆分用的两段提示词。
- `server/server.mjs`：自部署版（发网页 + `/api/complete` 连模型）。
- 存档在浏览器 `localStorage` 的 `amnesia:v1` 里。
