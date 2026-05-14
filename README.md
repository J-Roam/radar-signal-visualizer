# Radar Signal Visualizer

一款面向 C/C++ / CUDA 雷达 & 信号处理开发者的 VSCode 调试可视化插件。
在断点处把任意一段连续内存（`std::vector` / 原生数组 / 裸指针）一键 Pin 到面板，
即时查看时域、频谱、时频谱、2D 热力图，并支持原始字节导出为 `.bin` 文件。

---

## 目录

- [核心功能](#核心功能)
- [支持的数据类型](#支持的数据类型)
- [安装：打包成 .vsix 并装到任意工程](#安装打包成-vsix-并装到任意工程)
- [在你自己的工程中使用](#在你自己的工程中使用)
- [使用流程](#使用流程)
- [绘图模式说明](#绘图模式说明)
- [数据导出](#数据导出)
- [配置项](#配置项)
- [开发与调试](#开发与调试)
- [已知限制](#已知限制)

---

## 核心功能

| 功能 | 说明 |
|---|---|
| **手动 Pin** | 在 VSCode Variables 面板右键 → `Pin to Radar Signal Visualizer`，无须配置识别规则 |
| **DAP readMemory** | 通过 Debug Adapter Protocol 直接读裸字节，避开变量子树展开慢 / 截断的问题 |
| **复数支持** | `cuFloatComplex` / `cuDoubleComplex` / `std::complex<float>` / `std::complex<double>` / `float2` / `double2` |
| **时域绘图** | 实数波形、复数模值、dB 模值（20·log10\|x\|） |
| **复数 I/Q 三联视图** | 同卡片显示 I/Q 时域 + 归一化频谱（-0.5 ~ 0.5）+ 时频谱 (STFT) |
| **2D 热力图** | 手动指定 Rows × Cols，将一维数据按行主序展开为热力图（默认 viridis 调色板）<br>鼠标悬停显示 `row / col / value` |
| **手动确认绘图** | 所有参数变更（plot type / Length / Rows / Cols）均**不自动重绘**，必须点击 `📊 Plot` 按钮，避免半成品状态被误绘 |
| **数据导出 `.bin`** | 按当前 elementType 以 little-endian 裸字节写入，复数交错 (re,im,re,im,…)，可直接 `numpy.fromfile` |
| **Chart.js 刻度优化** | x 轴末端不会再缺失（512 点能看到 511）；频谱固定 10 格，中心为 0 |
| **CUDA-GDB 兼容** | 同时支持 `cppdbg` 与 NVIDIA Nsight 的 `cuda-gdb` |

---

## 支持的数据类型

### 容器
- `std::vector<T>`、`std::array<T, N>`、`std::deque<T>`
- 原生数组 `T[N]`
- 裸指针 `T*`（需要在使用时手动指定大小，详见下方"裸指针"小节）

### 元素类型 `T`
- 浮点：`float` / `double`
- 整型：`int` / `int32_t` / `uint32_t` / `short` / `int16_t` / `uint16_t` / `char` / `int8_t` / `uint8_t` / `long` / `int64_t` / `uint64_t` / `long long`
- 复数：`cuFloatComplex` / `cuDoubleComplex` / `std::complex<float>` / `std::complex<double>` / `float2` / `double2`

---

## 安装：打包成 .vsix 并装到任意工程

### 1) 在本仓库打包 `.vsix`

```bash
# 仅首次需要全局装一次 vsce
npm install -g @vscode/vsce

# 在本仓库根目录
npm install
npm run compile
vsce package
```

执行完成会在仓库根目录生成形如 `radar-signal-visualizer-0.0.1.vsix` 的文件。

> **如果 vsce 提示 LICENSE / repository 缺失**：在 `package.json` 加上 `"repository"` 字段，或加 `--allow-missing-repository` 参数；提示没有 README 时可加 `--no-yarn`。

### 2) 安装到任意 VSCode 实例

**图形界面**：
- VSCode 左侧 Extensions（`Ctrl+Shift+X`）→ 点击右上角 `…` → `Install from VSIX...` → 选择刚生成的 `.vsix`

**命令行**：
```bash
code --install-extension /path/to/radar-signal-visualizer-0.0.1.vsix
```

> **WSL / Remote-SSH 环境**：插件需要装在「实际跑调试器的那一端」。如果你在 WSL 里调 `cuda-gdb`，请在 WSL 那侧的 VSCode 中安装；可在 Extensions 列表里点齿轮 → `Install in WSL`。

### 3) 验证安装
- 打开任意带 `launch.json` 的工程，启动调试
- 命中断点后，左侧 Activity Bar 里应能看到雷达图标的 **Radar Signals** 视图
- 在 Variables 面板任一数组变量上**右键** → 出现 `Pin to Radar Signal Visualizer` 即说明安装成功

---

## 在你自己的工程中使用

### 第一步：配置调试器

仅需用 VSCode 内置 / 官方调试器即可，本插件**不替换**调试器，只是在 DAP 之上读内存。

#### CPU C/C++（cppdbg + gdb / lldb）
`.vscode/launch.json`：
```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug (gdb)",
      "type": "cppdbg",
      "request": "launch",
      "program": "${workspaceFolder}/build/your_app",
      "MIMode": "gdb",
      "cwd": "${workspaceFolder}",
      "stopAtEntry": false
    }
  ]
}
```

#### CUDA（cuda-gdb）
需先安装 NVIDIA `Nsight Visual Studio Code Edition` 扩展。
```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "CUDA C++: Launch",
      "type": "cuda-gdb",
      "request": "launch",
      "program": "${workspaceFolder}/build/your_kernel",
      "stopAtEntry": false
    }
  ]
}
```

> 编译目标程序时务必带调试符号：CPU `-g -O0`，CUDA `-G -g`。

### 第二步：调试 → Pin → 看图 → 导出

1. 在你工程的源文件中下断点，`F5` 启动调试
2. 命中断点后，在左侧 **Variables** 面板里找到你想观察的数组 / vector / 指针
3. **右键** → `Pin to Radar Signal Visualizer`
4. 自动打开 `Radar Signal Visualizer` 面板，卡片即出现
5. 调好参数后点击卡片右上的 **📊 Plot** 渲染图像
6. 需要带回原始数据 → 点击 Table 区右侧 **💾 Export .bin**

### 裸指针（`T*` / `cuFloatComplex*` 等）

裸指针没有大小信息，Pin 时插件会弹输入框让你输入元素个数。

### 多次断点
每次断点命中、`Step` 之后，所有已 Pin 的卡片都会自动重新读内存并刷新 Table，但**绘图不会自动刷新**——你需要再次点击 📊 Plot（这是刻意设计，避免参数没改完就乱绘）。

---

## 使用流程

```
启动调试 → 命中断点 → Variables 面板右键 Pin
        → 在卡片中选择 Plot Type / Length / Rows×Cols
        → 点击 📊 Plot 渲染
        → （可选）💾 Export .bin 导出原始字节
        → 单步 / Continue → 数据更新 → 再次点击 📊 Plot
```

---

## 绘图模式说明

| Plot Type | 适用 | 内容 |
|---|---|---|
| **Time Domain** | 实数 | 简单时域波形（蓝色折线） |
| **Magnitude** | 复数 | \|x[n]\| 时域曲线 |
| **Magnitude (dB)** | 实数/复数 | 20·log10\|x[n]\|，含 -inf 防护 |
| **Complex I/Q** | 复数 | 三联：I/Q 时域 + 归一化频谱(-0.5..0.5) + STFT 时频谱 |
| **2D Heatmap (\|·\| intensity)** | 一维 → 二维 | 手动指定 Rows × Cols 后按行主序展开；hover 显示 `row/col/value`（复数另显示 \|z\|、re、im） |

**频谱横坐标**：固定 10 格，刻度 `-0.5 -0.4 … 0 … 0.4 0.5`，中心为 0，方便目测频率。

**时域 x 轴**：保证显示最右端样本（512 点能看到 511），且自动避开标签视觉重叠（如 500 与 511 太近时合并）。

---

## 数据导出

点击 Table 区右侧的 **💾 Export .bin** 按钮：
- 弹出系统保存对话框，默认目录 = workspace 根
- 默认文件名：`<displayName>_<elementType>_<N>.bin`
- 文件格式：**裸字节流，无 header，little-endian**，复数交错 `(re, im, re, im, …)`

### 在 NumPy 中读取

| 类型 | dtype |
|---|---|
| `float`                   | `<f4` |
| `double`                  | `<f8` |
| `int32_t` / `int`         | `<i4` |
| `uint32_t` / `unsigned int` | `<u4` |
| `int16_t`                 | `<i2` |
| `int8_t` / `char`         | `<i1` |
| `uint8_t`                 | `<u1` |
| `int64_t` / `long`        | `<i8` |
| `cuFloatComplex` / `std::complex<float>`  | `<c8`  |
| `cuDoubleComplex` / `std::complex<double>` | `<c16` |

```python
import numpy as np
x = np.fromfile('prt_signal_cuFloatComplex_65536.bin', dtype='<c8').reshape(64, 1024)
```

### 在 MATLAB 中读取

```matlab
fid = fopen('signal_float_512.bin', 'r');
x   = fread(fid, [512, 1], 'float32=>float32');
fclose(fid);

% 复数 cuFloatComplex
fid = fopen('iq.bin', 'r');
raw = fread(fid, 'float32');                  % 交错 re,im,re,im
x   = complex(raw(1:2:end), raw(2:2:end));
fclose(fid);
```

---

## 配置项

`settings.json` 中可配：

```jsonc
{
  // Table 单页行数
  "rsv.tablePageSize": 200
}
```

---

## 开发与调试

### 监听编译
```bash
npm run watch
```

### 在 Extension Host 里调试本插件
1. 在本仓库根目录用 VSCode 打开
2. 按 `F5` → 启动 Extension Development Host（已配 `.vscode/launch.json`）
3. 在新窗口中打开本目录下的 `test-workspace/`，加载 `test_radar.cu`
4. 命中断点后右键 Pin 任意变量

### 测试用例
仓库自带 `test-workspace/test_radar.cu`，包含：
- 实数 `float` 数组
- `std::complex<float>` 信号
- `cuFloatComplex` 设备/主机数组
- `1024 × 64` 多 PRT 帧（前 512 LFM + 后 512 零填充，每个 PRT 相同），**最适合验证 2D Heatmap**

---

## 已知限制

- `int64_t` / `uint64_t` 在数值超过 2^53 时由于 JS Number 精度丢失，导出 `.bin` 会失真（绘图本身就有同样限制）
- 频谱图采用 Hann 加窗 + 朴素 DFT（O(N²)）；超长信号（≥ 8192 点）建议在导出后离线分析
- 仅支持连续内存：`std::list` / `std::map` 等链表 / 树结构无法 Pin
- WSL 下 cuda-gdb 偶尔需要在 `launch.json` 加 `"environment": [{"name":"CUDA_VISIBLE_DEVICES","value":"0"}]`

---

## License

ISC
