# Radar Signal Visualizer - VSCode Extension

Phase 1 MVP - 基础版本的雷达信号可视化工具

## 功能特性

- ✅ 断点时自动识别信号变量
- ✅ 在侧边栏显示候选信号变量
- ✅ 点击变量可视化显示时域波形
- ✅ 显示信号统计信息（样本数、最小值、最大值、平均值）
- ✅ Chart.js 交互式图表

## 安装步骤

### 1. 编译扩展
```bash
cd radar-signal-visualizer
npm install
npm run compile
```

### 2. 在VSCode中安装扩展

#### 方法A: 开发模式（推荐用于测试）
1. 按 `F5` 或点击 "Run > Start Debugging"
2. 这会打开一个新的VSCode窗口（Extension Development Host）
3. 在新窗口中打开本目录

#### 方法B: 打包安装
```bash
npm install -g vsce
vsce package
```
然后安装生成的 `.vsix` 文件

### 3. 编译测试程序
```bash
./build.sh
```

## 使用方法

### 基本使用流程

1. **打开可视化面板**
   - 按 `Ctrl+Shift+P`
   - 输入 "Open Radar Visualizer"
   - 或者在侧边栏点击 "Radar Signals" 图标

2. **启动调试**
   - 打开 `test_radar.cpp`
   - 在 `main()` 函数中设置断点（例如，在生成信号之后）
   - 按 `F5` 启动调试

3. **查看信号**
   - 程序在断点处暂停时，侧边栏会自动显示信号变量
   - 点击任意信号变量进行可视化
   - 图表会显示该变量的时域波形

### 配置选项

在 `settings.json` 中可以配置：

```json
{
  "rsv.autoDisplayOnBreakpoint": true,
  "rsv.signalNamePatterns": [
    "*signal*",
    "*data*",
    "*pulse*",
    "*sample*"
  ],
  "rsv.maxArraySize": 100000
}
```

- `autoDisplayOnBreakpoint`: 断点时是否自动更新变量列表
- `signalNamePatterns`: 用于识别信号变量的名称模式
- `maxArraySize`: 自动显示的最大数组大小

## 项目结构

```
radar-signal-visualizer/
├── src/
│   ├── extension.ts           # 扩展入口
│   ├── dataProvider.ts        # 数据提供者，获取调试变量
│   ├── visualizerPanel.ts     # WebView面板管理
│   └── types.ts               # 类型定义
├── assets/
│   ├── webview.js            # WebView前端逻辑
│   ├── webview.css           # WebView样式
│   └── icon.svg              # 扩展图标
├── test_radar.cpp             # 测试程序
├── CMakeLists.txt             # CMake构建配置
├── build.sh                   # 构建脚本
└── package.json               # 扩展配置
```

## 调试器支持

当前支持：
- GDB (标准调试)
- 计划支持：CUDA-GDB

## 已知限制（Phase 1）

- 仅支持数值类型的数组
- 仅支持时域波形显示
- 不支持复数数据
- 大型数组可能性能较慢

## 下一步计划 (Phase 2)

- [ ] 添加FFT频谱显示
- [ ] 支持复数数据（I/Q）
- [ ] 多信号对比
- [ ] 数据导出功能
- [ ] CUDA-GDB支持
- [ ] 频谱图显示

## 故障排除

### 侧边栏没有显示信号变量
- 确保调试器正在运行
- 检查变量名是否匹配配置的模式
- 确认变量是数组类型

### 图表不显示
- 检查浏览器控制台是否有错误
- 确认数据可以正常读取

### 编译错误
- 确保已安装 Node.js 和 npm
- 运行 `npm install` 安装依赖

## 开发

### 监听模式编译
```bash
npm run watch
```

### 调试扩展
1. 在 `src/extension.ts` 中设置断点
2. 按 `F5` 启动扩展开发主机
3. 在新窗口中测试扩展

## 许可证

ISC
