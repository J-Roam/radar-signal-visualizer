# 快速启动指南

## 1. 安装依赖
```bash
npm install
```

## 2. 编译扩展
```bash
npm run compile
```

## 3. 编译测试程序
```bash
./build.sh
```

## 4. 启动VSCode扩展开发模式
1. 在VSCode中按 `F5` 启动调试
2. 会打开一个新的VSCode窗口（Extension Development Host）

## 5. 在新窗口中测试
1. 打开 `test_radar.cpp`
2. 在第46行（混合信号之后）设置断点
3. 按 `F5` 启动GDB调试
4. 程序会在断点处暂停
5. 在左侧侧边栏找到 "Radar Signals" 图标并点击
6. 应该能看到 `pulse_data`, `noise_data`, `chirp_signal`, `mixed_signal` 等变量
7. 点击任意变量查看波形图

## 常见问题

### Q: 侧边栏没有显示Radar Signals图标？
A: 确保你是在Extension Development Host窗口中，并且已经启动了调试会话。

### Q: 信号变量列表是空的？
A: 确保调试器已经暂停，并且变量名匹配配置的模式（默认包含 *signal*, *data*, *pulse*, *sample*）。

### Q: 图表不显示？
A: 检查变量是否是数组类型且包含数值数据。

## 项目结构说明

```
src/
├── extension.ts        # 扩展入口，注册命令和调试事件
├── dataProvider.ts     # 从调试器获取变量数据
├── visualizerPanel.ts  # 管理WebView面板
└── types.ts            # TypeScript类型定义

assets/
├── webview.js          # WebView前端，负责图表渲染
├── webview.css         # WebView样式
└── icon.svg            # 扩展图标

test_radar.cpp          # 测试程序，生成雷达信号
```

## 调试扩展本身

如果需要调试扩展代码：
1. 在 `src/` 目录的TypeScript文件中设置断点
2. 按 `F5` 启动扩展开发主机
3. 在新窗口中触发扩展功能
4. 断点会在原窗口中触发
