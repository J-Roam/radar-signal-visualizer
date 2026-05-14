# 快速启动指南

> 完整说明请查阅 [README.md](./README.md)。本文档只覆盖三种最常见场景。

---

## 场景 A：在本仓库内开发 / 试用

```bash
git clone <repo>
cd radar-signal-visualizer
npm install
npm run compile
```

在 VSCode 中打开本目录，按 **F5** 启动 *Extension Development Host*。
新窗口里打开 `test-workspace/`，构建并调试 `test_radar.cu`：

1. 在 `test_radar.cu` 想观察的位置下断点
2. 启动调试，命中断点后在 **Variables** 面板找到 `prt_signal` / `complex_signal` 等
3. **右键 → Pin to Radar Signal Visualizer**
4. 在面板卡片里选 Plot Type，点击右上角 **📊 Plot** 渲染

---

## 场景 B：打包 .vsix 装到任意 VSCode 工程

```bash
# 一次性安装打包工具
npm install -g @vscode/vsce

# 在本仓库根目录
npm install
npm run compile
vsce package
# → 生成 radar-signal-visualizer-<version>.vsix
```

**安装到目标机器**：

```bash
# 命令行
code --install-extension /path/to/radar-signal-visualizer-<ver>.vsix

# 或：VSCode → Extensions(Ctrl+Shift+X) → 右上角 ... → Install from VSIX
```

> WSL / Remote-SSH：要装在「实际跑调试器的那一端」。
> 在 Extensions 列表中点齿轮 → `Install in WSL` 或 `Install in SSH: xxx`。

---

## 场景 C：在你自己的 C++/CUDA 工程里使用

### 1. 配 `.vscode/launch.json`

CPU 程序：
```jsonc
{
  "name": "Debug (gdb)",
  "type": "cppdbg",
  "request": "launch",
  "program": "${workspaceFolder}/build/your_app",
  "MIMode": "gdb",
  "cwd": "${workspaceFolder}"
}
```

CUDA 程序（需先装 NVIDIA `Nsight Visual Studio Code Edition`）：
```jsonc
{
  "name": "CUDA: Launch",
  "type": "cuda-gdb",
  "request": "launch",
  "program": "${workspaceFolder}/build/your_kernel"
}
```

> 编译选项：CPU 加 `-g -O0`，CUDA 加 `-G -g`，否则 `readMemory` 拿不到符号。

### 2. 调试 → Pin → 看图 → 导出

1. 设断点，`F5` 启动，命中断点
2. **Variables** 面板里右键你的 `std::vector<float>` / `cuFloatComplex*` / 数组 → **Pin to Radar Signal Visualizer**
3. 裸指针会弹框让你输入元素个数
4. 在卡片选好 Plot Type / Length / 2D Heatmap 的 Rows × Cols
5. 点 **📊 Plot** 渲染（参数变更不自动重绘，必须按按钮）
6. 想带回数据 → Table 区右上 **💾 Export .bin** → 系统保存对话框 → 选目录

---

## FAQ

**Q：右键菜单没有 "Pin to Radar Signal Visualizer"？**
A：必须先**启动并命中断点**；右键的目标必须是 Variables 面板里**已展开的变量**，不是 Watch 表达式。

**Q：Pin 之后卡片显示 "Data updated · click 📊 Plot to render"？**
A：这是手动确认绘图模式的提示，点击卡片右侧 📊 Plot 按钮即可渲染。

**Q：2D Heatmap 没出图，提示 `Set Rows & Cols ≥ 1`？**
A：在 Plot type 选 `2D Heatmap` 后，左侧会出现 `Rows × Cols` 输入框；填好后回车，再按 📊 Plot。

**Q：`Rows × Cols > data length`？**
A：行列乘积必须 ≤ 当前 Length。可改 Length 或减小行列数。

**Q：导出的 `.bin` 怎么读？**
A：见 README → [数据导出](./README.md#数据导出) 表格，本质是 little-endian 裸字节，复数交错。

**Q：单步后图怎么没更新？**
A：单步后数据已自动重读，但绘图被刻意设计为**不自动刷新**，需再次点击 📊 Plot。

---

## 项目结构

```
src/
├── extension.ts          # 扩展入口、命令注册、调试事件钩子
├── dataProvider.ts       # readMemory + elementType 解码 + Pin 列表管理
├── visualizerPanel.ts    # Webview 面板 + .bin 导出
└── types.ts              # 接口定义

assets/
├── webview.js            # 前端：表格、Chart.js、热力图、I/Q 三联视图、tooltip、导出
├── webview.css           # 样式
├── chart.umd.min.js      # Chart.js 离线副本
└── icon.svg

test-workspace/
└── test_radar.cu         # CUDA 测试程序（含 1024×64 多 PRT 帧）
```
