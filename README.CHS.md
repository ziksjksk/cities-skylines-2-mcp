# CS2MCP — Cities: Skylines II 的 MCP 服务器

[English](README.md) | **简体中文**

让 Claude 等 MCP 客户端对正在运行的《城市：天际线 2》进行**真实、受能力合同约束的操作**：读取城市数据、动态发现运行时预设、分析地图与道路图、控制相机与截图、建设道路/轨道/建筑/树木/装饰、铺设原生地表、修改地形、划区、管理财政政策、控制模拟时间、按原生交通占用定位瓶颈并执行有界平行道路改造，并运行分阶段自治建城循环。尚未接入的系统会明确返回 plan-only/unsupported，不伪造成功。

> 基础工具加上 autonomy 层工具，覆盖「看 / 建 / 调 / 管 / 时间 / 规划 / 验证」；已验证的道路回退施工、物理轨道段、公交站点、站点绑定线路、车站/车库、装饰物、地表、地形、实时对象移动、公用设施图观察、原生道路/交通图观察、资源/风向/外部连接观察、线路设置/只读分析，以及自治循环都会走真实游戏管线。存档加载/回滚和线路路点数量增删已接入原生路径；逐车发车现在通过原生交通请求/寻路管线实现，并且只有 RouteVehicle 实体读回后才报告成功，通用对象改色仍会按能力合同明确标记。隧道能力现在由运行时扫描 `PlaceableNetData.m_UndergroundPrefab` 动态决定，只有当前游戏返回可用隧道预设时才会报告可用，并且仍须用精确预设和实体/道路图回读确认，不把规划结果冒充为游戏成功。

2026-08-25 的干净近空存档复验完成了一次有限自治周期：`12` 段道路全部读回、`4` 个分区成功、`4` 组分区成功、`8` 个原生服务建筑完成放置与读回、`2` 个公交站点绑定到 `1` 条线路，并生成多角度验证截图。该周期还读回了原生资源、风向、外部连接、道路/交通图和线路分析；随后线路设置回归将实时线路改为 Night、间隔 `37`、unbunching `0.45`、票价 `11`，并同时通过 ECS 与 UI 读回。另一次完整重启后的设施回归读回了 1 个 `BusStation02`、3 个集成站台和 2 个带可用车辆的 `Pack7-BusDepot01`。更大范围探测达到 `52` 段道路、`6` 个分区、`68` 栋建筑和 `1191` 个分区格，但人口仍为 `0` 且有 `198` 条通知；严格的公用设施连通门因此不会把它宣称为健康大都市。当前自治循环仍是有界规模，必须逐阶段验证后再扩建。

## 架构

```
Claude Code / Claude Desktop（任意 MCP 客户端）
      │  MCP (stdio)
      ▼
cs2-mcp  (mcp-server/，Node.js 进程)
      │  HTTP，仅本机 127.0.0.1:8642
      ▼
CS2MCP 桥接 Mod  (CS2MCP.Bridge/，游戏进程内)
      │  ECS 查询与写入均在模拟主线程执行
      ▼
Cities: Skylines II
```

- **游戏内 Mod**（C#）：在游戏进程里用 `TcpListener` 起一个仅监听 127.0.0.1 的极简 HTTP 服务。请求由监听线程排队，在注册于 `SystemUpdatePhase.UIUpdate` 的 ECS System 中于模拟主线程执行（暂停时也可用）。建设操作通过自定义 `ToolBaseSystem` 走游戏原生的定义/校验/提交管线，拆除走推土机管线——不做任何绕过游戏校验的直接实体修改。
- **MCP Server**（TypeScript）：把 MCP 工具调用翻译为对桥接 Mod 的 HTTP 请求，stdio 传输。

## 环境要求

- Windows + Steam 版《城市：天际线 2》
- .NET SDK 8.0+（编译 Mod）
- Node.js 18+（运行 MCP server）

## 构建与安装

```powershell
# 1. 编译游戏内 Mod（构建后自动部署到游戏的本地 Mods 目录）
dotnet build CS2MCP.Bridge\CS2MCP.Bridge.csproj

# 2. 构建 MCP server
cd mcp-server
npm install
npm run build
```

Mod 会部署到 `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Mods\CS2MCP\`，游戏启动时自动加载，无需发布到 Paradox Mods。想临时禁用：把该文件夹改名为 `.CS2MCP`。

### 游戏路径配置

编译 Mod 需要引用游戏目录下的程序集。查找顺序（先命中先用）：

1. 命令行参数：`dotnet build -p:GamePath="X:\...\Cities Skylines II"`
2. 环境变量 **`CS2_PATH`**
3. 环境变量 `CSII_INSTALLATIONPATH`（官方 Modding 工具链设置）
4. 常见 Steam 库位置自动探测（`C:\Program Files (x86)\Steam`、各盘符 `Steam` / `SteamLibrary`）

找不到游戏时构建会报出明确错误。设置环境变量示例：

```powershell
setx CS2_PATH "D:\Steam\steamapps\common\Cities Skylines II"
```

### 运行时环境变量（支持 .env）

MCP server 通过 [dotenv](https://github.com/motdotla/dotenv) 读取 `mcp-server/.env`（参考 `.env.example`）：

| 变量 | 作用域 | 默认值 | 说明 |
|---|---|---|---|
| `CS2_BRIDGE_URL` | MCP server | `http://127.0.0.1:8642` | 桥接 Mod 的地址 |
| `CS2MCP_PORT` | 游戏进程 | `8642` | 桥接 Mod 的监听端口（改它需同步改 `CS2_BRIDGE_URL`） |
| `CS2_PATH` | 构建期 | 自动探测 | 游戏安装目录 |

## 在 Claude 中使用

**Claude Code**：仓库根目录的 [.mcp.json](.mcp.json) 已注册 `cs2` 服务器，在项目目录里打开 Claude Code 即可（首次会询问是否信任）。在其他目录手动注册：

```powershell
claude mcp add cs2 -- node <仓库路径>\mcp-server\dist\index.js
```

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "cs2": {
      "command": "node",
      "args": ["<仓库路径>\\mcp-server\\dist\\index.js"]
    }
  }
}
```

启动游戏、读取存档，然后问 Claude："看看我的城市财政状况"、"在河边划一片住宅区"、"修一条路把工业区接上高速"。

## 工具总览

**状态与画面**

| 工具 | 说明 |
|---|---|
| `cs2_ping` | 桥存活、Mod 版本、游戏模式（读档中也能响应） |
| `cs2_game_state` | 模式、城市名、暂停/速度、游戏内日期时间 |
| `cs2_city_overview` | 人口、幸福度、健康度、资金、XP、日期 |
| `cs2_screenshot` | 当前画面 PNG（帧末采集，默认缩至 1280 宽） |
| `cs2_get_camera` / `cs2_set_camera` | 相机读写（观察点/角度/距离），配合截图 = AI 自主取景 |

**城市数据**

| 工具 | 说明 |
|---|---|
| `cs2_demand` | RCI 需求 + 需求因子（内部 0-255 刻度，暂停时不刷新） |
| `cs2_budget` | 收支明细：14 项收入 / 15 项支出来源 |
| `cs2_city_services` | 电力、水务、垃圾状态 |
| `cs2_labor` | 就业、失业率、按教育等级的岗位供需、年龄结构 |
| `cs2_statistics` | 60+ 种统计项历史曲线（每游戏日 32 采样） |
| `cs2_terrain` | 全图高度 + 水体栅格 |
| `cs2_gridmap` | 地价/地面污染/空气污染/噪音/地下水等 6 层原生栅格 |
| `cs2_zoning` | 区划现状汇总（占用/空置） |
| `cs2_notifications` | 全城警告图标（缺电缺水/弃置等）+ 目标实体 |
| `cs2_inspect` | 单实体详情（住户/雇员/状态标志） |
| `cs2_query_resources` / `cs2_query_wind` | 原生分页查询资源矿藏与风向/风速；不从其他栅格推断零值 |
| `cs2_query_outside_connections` | 原生外部连接节点、预设、位置和运输元数据 |

**建设**

| 工具 | 说明 |
|---|---|
| `cs2_find_prefabs` | 按名称搜索建筑/道路/网络/树木预设 |
| `cs2_place_building` | 放置建筑（默认对齐原生 8m 网格、读取建筑道路需求并检查道路前沿、地形高度自动采样、旋转可调、原生校验）；树木由自治层的原生树木工具处理 |
| `cs2_place_prop` / `cs2_list_props` | 放置运行时发现的装饰物，或读取通用静态装饰实体 |
| `cs2_paint_surface` | 预览或通过原生区域定义管线绘制多边形地表 |
| `cs2_build_road` | 任意网络段或复合路径：直线 / Bezier / Arc / Spline / Polyline；支持 `start/end`、`controlPoints[]`、`points[]`、`elevation`、`startElevation`、`endElevation`、`targetSlope`、`parallelOffset`，最终仍由游戏原生道路/网格校验裁决 |
| `cs2_upgrade_road` | 道路升级：草地/树/宽人行道/隔音屏/停车位/路灯/中央绿化 |
| `cs2_zone_area` / `cs2_list_zones` | 通过原生分区工具/网格划区与读取区划类型（`None` 清除） |
| `cs2_demolish` | 通过推土机管线拆除建筑/路段/树木/地区，并读回实体已消失 |
| `cs2_list_buildings` / `cs2_list_roads` / `cs2_list_objects` | 实体清单（ID、坐标） |

**自治与交通**

| 工具 | 说明 |
|---|---|
| `cs2_analyze_map` | 汇总地形/环境/道路/交通，并明确 observed 与 unavailable 状态 |
| `cs2_transport_analysis` | 原生车站、车库、站点、线路绑定、候车人数、车辆时序和线路设置读回 |
| `cs2_set_transport_line_settings` | 预览/应用线路名称、日/夜/停用时段、启用状态、间隔、unbunching 与票价，并延后一帧验证 ECS/UI |
| `cs2_run_autonomous_city_cycle` | 有界的观察 → 规划 → 原生建设 → 模拟 → 修复 → 验证循环，包含存档、截图和质量门槛 |

**财政与政策**

| 工具 | 说明 |
|---|---|
| `cs2_get_taxes` / `cs2_set_tax` | 四大区类税率（钳制在游戏允许范围） |
| `cs2_policies` / `cs2_set_policy` | 城市政策（含本地化名称） |
| `cs2_service_budgets` / `cs2_set_service_budget` | 服务预算滑条 50-150% |
| `cs2_get_fees` / `cs2_set_fee` | 水电/医疗/教育等服务收费 |
| `cs2_get_loan` / `cs2_set_loan` | 贷款借还 |
| `cs2_list_districts` / `cs2_create_district` | 地区列表 / 多边形画地区 |
| `cs2_district_policies` / `cs2_set_district_policy` | 地区政策 |
| `cs2_tiles_info` | 地块持有/维护费信息 |

**时间与元操作**

| 工具 | 说明 |
|---|---|
| `cs2_set_simulation` | 暂停/调速（0-8） |
| `cs2_run_simulation` | 定时快进：跑 N 游戏小时后自动暂停 |
| `cs2_save_game` | 触发存档（建议 AI 大规模操作前调用） |

## 排障

- **`cs2_ping` 连不上**：Mod 未加载。查 `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Logs\CS2MCP.log`（正常应有 `bridge listening on ...`）；无此文件则查同目录 `Player.log`。
- **409 no city loaded**：还在主菜单，先读档。
- **锁定状态显示异常**：读档后先短暂解除暂停一次（相关接口在未跑过模拟时会返回 `stalenessWarning`）。
- **端口冲突**：给游戏进程设 `CS2MCP_PORT`，并同步修改 `.env` 中的 `CS2_BRIDGE_URL`。

## 已知限制 / 路线图

- 购买地块已接入原生 `MapTilePurchaseSystem` 的选择/经济路径；地形操作已接入游戏的 `ToolOutputBarrier` 定义管线，并在 CS2 1.6.0f1 新城市中通过原生高度采样和截图验证
- 地表绘制和装饰物放置已接入运行时 `SurfacePrefab` / `StaticObjectPrefab` 发现与原生定义管线；装饰物随机预设可能在游戏中解析为具体变体，应使用 `cs2_list_props`/`cs2_inspect` 复核
- 具有 `Transform + PrefabRef` 的实时对象可通过 `cs2_transform_object` 走原生 `Relocate` 定义管线移动；默认先 dry-run，并必须用实体读回确认位置。道路边仍使用专用网络修改路径
 - 公交站点、站点到线路绑定、物理轨道段施工、只读原生道路/车道/交通图观察、车站/车库放置，以及原生交通线路创建、同点数修改、路点增删、删除、路点读回、线路设置/分析、原生逐车请求和实时对象移动已接入原生路径；逐车请求只有 RouteVehicle 读回后才算成功，车站/车库自动挂线和通用对象改色仍按能力合同明确不可用。隧道能力通过运行时 `PlaceableNetData.m_UndergroundPrefab` 探测，能力为真时才允许进入隧道预设选择和施工验证。存档加载/回滚走原生 save id 路径，并在自治失败时保留前置存档点；源代码变更后的最新游戏会话复验仍需单独执行
- 公用设施观察与建设分别返回原生边、建筑连接组件和通知变化；仅放置管线或电线不会被当作“已经接通”，必须看到原生图或通知改善证据
- 地图资源、风向和外部连接现在通过原生 `NaturalResourceSystem`、`WindSystem`、`OutsideConnection + Node` 分页查询；当前运行时已读回非零资源、风矢量和外部连接元数据，森林资源仍不会从其他栅格推断
- 自治循环已在近空白 Runtime Test 存档完成有界实机闭环（道路、分区、服务、公交站/线路、造景、非零模拟、诊断/修复、双角度截图、前置/最终保存）；这不等同于已证明数万居民规模的完整大都市成长验收
- 匝道只能接在路段端点（节点），尚不支持路中段平滑汇入
- 截图为游戏当前渲染画面：道路类工具面板开启时游戏会以白色轮廓模式渲染

## 免责与致谢

- 本项目为非官方社区 Mod，与 Colossal Order / Paradox Interactive 无关。
- `CS2MCP.Bridge/CreateDefinitions.cs` 移植自 [LineTool-CS2](https://github.com/algernon-A/LineTool-CS2)（Apache-2.0，© algernon），其中含有源自游戏反编译代码的部分，适用 Paradox 用户协议。
- 感谢 CS2 modding 社区的先行者们：LineTool、InfoLoom、Traffic、unity-mcp 等项目的公开代码是本项目的重要参考。

## License

[Apache-2.0](LICENSE)
