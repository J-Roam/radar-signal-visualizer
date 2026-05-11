/**
 * ======================================================================
 * visualizerPanel.ts - 可视化面板管理类
 * ======================================================================
 *
 * 本文件负责创建和管理 VSCode 中的 WebviewPanel。
 * Webview 是 VSCode 中的一种特殊视图，可以在其中运行完整的 HTML/JavaScript，
 * 就像在一个嵌入式浏览器中一样。
 *
 * Webview 的核心概念：
 *   1. 安全性：Webview 运行在沙箱中，默认不能访问外部资源（网络、文件系统）。
 *      所有脚本和样式必须通过 nonce 或本地资源 URI（vscode-resource://）加载。
 *   2. 通信：Webview 和扩展代码之间通过 postMessage() 进行双向通信。
 *      - 扩展 → Webview: panel.webview.postMessage(message)
 *      - Webview → 扩展: window.addEventListener('message', handler)
 *   3. 生命周期：WebviewPanel 需要在不用时 dispose() 释放资源。
 *      通常使用单例模式（本项目），确保同一时间只有一个面板实例。
 *
 * Webview 的典型应用场景：
 *   - 图表可视化（本项目）
 *   - HTML 文档预览（Markdown、PDF 等）
 *   - 自定义表单/配置界面
 *   - 游戏/交互式内容
 *
 * ======================================================================
 */

import * as vscode from 'vscode';
import { SignalDataProvider } from './dataProvider';
import { SignalVariable } from './types';

/**
 * SignalVisualizerPanel 采用单例模式（Singleton Pattern）。
 *
 * 单例模式确保一个类只有一个实例，并提供全局访问点。
 * 在这个场景下，我们只需要一个可视化面板，多次调用 "Open Radar Visualizer"
 * 应该复用已有的面板，而不是创建多个。
 *
 * 实现单例的关键点：
 *   1. 静态属性 currentPanel 保存唯一的实例。
 *   2. 私有构造函数，防止外部直接 new。
 *   3. 静态工厂方法 createOrShow() 控制实例的创建和获取。
 */
export class SignalVisualizerPanel {

	/**
	 * 静态属性，保存当前面板的唯一实例。
	 * undefined 表示面板尚未创建或已被关闭。
	 *
	 * 静态属性属于类本身，不属于实例。通过 SignalVisualizerPanel.currentPanel 访问。
	 */
	public static currentPanel: SignalVisualizerPanel | undefined;

	/**
	 * WebviewPanel 的类型标识符。
	 *
	 * viewType 是 WebviewPanel 的唯一标识，用于：
	 *   - 创建面板时告诉 VSCode 这是什么类型的面板。
	 *   - 如果实现 onDidChangeViewState 等事件，可以通过 viewType 过滤。
	 *
	 * 通常使用反向域名表示法（如 com.company.feature），
	 * 这里使用简单的驼峰命名也可以。
	 */
	public static readonly viewType = 'radarSignalVisualizer';

	/**
	 * VSCode 的 WebviewPanel 实例。
	 * readonly 表示面板创建后不会替换为另一个面板实例，
	 * 但面板的内容（HTML）可以更改。
	 */
	private readonly _panel: vscode.WebviewPanel;

	/**
	 * Disposable 数组，用于管理需要随面板一起销毁的资源。
	 *
	 * 在 VSCode 中，许多 API（如事件订阅、命令注册）返回 Disposable 对象。
	 * 当不再需要这些资源时，调用 dispose() 方法释放。
	 *
	 * 例如：
	 *   this._panel.onDidDispose(...) 返回一个 Disposable，
	 *   如果不 dispose()，事件监听器会一直存在（即使面板已关闭）。
	 */
	private _disposables: vscode.Disposable[] = [];

	/**
	 * 数据提供者实例的引用，用于获取变量数据。
	 * 通过构造函数注入，而不是在类内部创建（依赖注入模式）。
	 */
	private dataProvider: SignalDataProvider;

	/**
	 * 静态工厂方法：创建或显示面板。
	 *
	 * 单例模式的实现核心：
	 *   1. 如果 currentPanel 已存在 → 激活（显示）已有面板，返回它。
	 *   2. 如果 currentPanel 不存在 → 创建新面板，保存到 currentPanel，返回它。
	 *
	 * @param extensionUri - 扩展安装目录的 URI（来自 context.extensionUri）。
	 * @param dataProvider - 数据提供者实例，用于后续获取变量数据。
	 * @returns SignalVisualizerPanel - 面板实例（同步返回，不是 Promise）。
	 */
	public static createOrShow(extensionUri: vscode.Uri, dataProvider: SignalDataProvider): SignalVisualizerPanel {
		/**
		 * 确定面板应该在哪一列打开。
		 *
		 * vscode.window.activeTextEditor 是当前聚焦的文本编辑器。
		 * viewColumn 是编辑器的列位置（如 ViewColumn.One、ViewColumn.Two 等）。
		 * 如果没有打开任何编辑器，返回 undefined，VSCode 会默认使用第一列。
		 */
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		/**
		 * 如果面板已存在，调用 reveal() 让它获得焦点（显示在最前面）。
		 * 不创建新面板，保持单例。
		 */
		if (SignalVisualizerPanel.currentPanel) {
			SignalVisualizerPanel.currentPanel._panel.reveal(column);
			return SignalVisualizerPanel.currentPanel;
		}

		/**
		 * 创建新的 WebviewPanel。
		 *
		 * createWebviewPanel() 的参数：
		 *   1. viewType: 面板类型标识符（静态属性）。
		 *   2. title: 面板标题，显示在标签页上。
		 *   3. showOptions: 显示位置（列）。
		 *   4. options: 面板配置选项。
		 *
		 * options 说明：
		 *   - enableScripts: true → 允许执行 JavaScript（必须开启，否则图表库无法运行）。
		 *   - retainContextWhenHidden: true → 当面板隐藏时保留 DOM 状态。
		 *     如果设为 false，切换到其他面板时 Webview 会被销毁，切换回来时重新加载。
		 *     开启后，面板隐藏时图表数据、滚动位置等都会保留，体验更好。
		 *     代价是占用更多内存（即使隐藏也要保持 DOM 树）。
		 *   - localResourceRoots: 允许加载的本地资源目录。
		 *     Webview 默认不能访问扩展目录中的文件，需要显式声明允许的路径。
		 *     vscode.Uri.joinPath() 拼接路径，类似 C 的 strcat 但更安全。
		 */
		const panel = vscode.window.createWebviewPanel(
			SignalVisualizerPanel.viewType,
			'Radar Signal Visualizer',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(extensionUri, 'assets')
				]
			}
		);

		/**
		 * 调用私有构造函数创建实例，并保存到静态属性中。
		 *
		 * 注意：这里不能用 new SignalVisualizerPanel() 替代 createOrShow()，
		 * 因为构造函数是私有的（private），外部无法直接调用。
		 * 这是单例模式的标准实现方式。
		 */
		SignalVisualizerPanel.currentPanel = new SignalVisualizerPanel(panel, extensionUri, dataProvider);
		return SignalVisualizerPanel.currentPanel;
	}

	/**
	 * 私有构造函数。
	 *
	 * 在 TypeScript 中，将构造函数设为 private 可以防止外部代码直接 new 该类，
	 * 强制通过静态工厂方法创建实例。
	 *
	 * 构造函数参数：
	 *   - panel: 刚创建的 WebviewPanel 实例。
	 *   - _extensionUri: 扩展目录 URI（readonly，保存为实例属性）。
	 *   - dataProvider: 数据提供者实例。
	 *
	 * private readonly _extensionUri 是 TypeScript 的参数属性语法，
	 * 等价于在类中声明 private readonly _extensionUri: vscode.Uri; 并赋值。
	 * 这是 TypeScript 的语法糖，简化代码。
	 */
	private constructor(panel: vscode.WebviewPanel, private readonly _extensionUri: vscode.Uri, dataProvider: SignalDataProvider) {
		this._panel = panel;
		this.dataProvider = dataProvider;

		/**
		 * 监听面板关闭事件。
		 *
		 * onDidDispose 是 WebviewPanel 的事件，在用户关闭面板（点 X）时触发。
		 * 这里我们调用 dispose() 清理资源并将 currentPanel 置为 undefined，
		 * 下次调用 createOrShow() 时就会创建新面板。
		 *
		 * 第二个参数 null 是 thisArg（事件回调中的 this 指向），传 null 表示使用箭头函数的词法 this。
		 * 第三个参数 this._disposables 是 Disposable 列表，事件订阅会自动加入其中。
		 */
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		/**
		 * 监听 Webview 发来的消息。
		 *
		 * 这是扩展代码 ← Webview 的通信通道。
		 * Webview 中的 JavaScript 通过 vscode.postMessage({ command: 'xxx' }) 发消息，
		 * 这里通过 onDidReceiveMessage 接收并处理。
		 *
		 * 消息处理使用 switch-case 模式，根据 message.command 分发到不同逻辑。
		 * 目前只处理 'ready' 命令（Webview 加载完成时发送）。
		 */
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'ready':
						/**
						 * Webview 加载完成后发送 'ready' 消息。
						 * 这里我们发送 'init' 消息作为响应，通知 Webview 可以准备接收数据。
						 * （目前 init 消息没有特殊处理，只是一个握手信号）
						 */
						this.sendInitialData();
						break;
				}
			},
			null,
			this._disposables
		);

		/**
		 * 初始化 Webview 的 HTML 内容。
		 *
		 * update() 方法会调用 _getHtmlForWebview() 生成 HTML 并设置到面板。
		 * 面板创建后立即执行，确保用户看到内容。
		 */
		this.update();
	}

	/**
	 * 发送初始数据给 Webview。
	 *
	 * postMessage() 是扩展 → Webview 的通信方式。
	 * 消息可以是任意 JSON 可序列化的对象。
	 *
	 * Webview 中通过 window.addEventListener('message', handler) 接收。
	 *
	 * 这里的 'init' 命令目前没有特殊处理，但保留作为握手信号，
	 * 后续如果需要向 Webview 发送初始配置（如主题色），可以在这里扩展。
	 */
	private sendInitialData() {
		this._panel.webview.postMessage({
			command: 'init'
		});
	}

	/**
	 * 可视化指定的信号变量。
	 *
	 * 这是扩展代码 → Webview 的主要数据流入口。
	 * 调用流程：
	 *   1. 调用 dataProvider.getVariableData() 从调试器获取变量的实际数值。
	 *   2. 将数值通过 postMessage() 发送给 Webview。
	 *   3. Webview 收到 'plotSignal' 消息后，用 Chart.js 渲染波形。
	 *
	 * .then() 是 Promise 的链式调用方法，在异步操作完成后执行回调。
	 * 等价于 async/await 写法：
	 *   const data = await this.dataProvider.getVariableData(variable);
	 *   this._panel.webview.postMessage({ ... });
	 */
	public visualizeVariable(variable: SignalVariable) {
		this.dataProvider.getVariableData(variable).then(data => {
			this._panel.webview.postMessage({
				command: 'plotSignal',
				variable: {
					name: variable.name,
					type: variable.type,
					data: data
				}
			});
		});
	}

	/**
	 * 更新 Webview 内容。
	 *
	 * 通常在面板创建时调用，也可以在需要刷新 HTML 时调用（如配置变更）。
	 */
	public update() {
		const webview = this._panel.webview;
		this._panel.title = 'Radar Signal Visualizer';
		this._panel.webview.html = this._getHtmlForWebview(webview);
	}

	/**
	 * 生成 Webview 的 HTML 内容。
	 *
	 * VSCode 的 Webview 要求使用完整的 HTML 文档（不是片段）。
	 * 这里返回一个 HTML 字符串，包含：
	 *   - 页面结构和样式
	 *   - Chart.js 库（本地文件）
	 *   - 自定义 JavaScript（webview.js）
	 *
	 * 安全机制（CSP + Nonce）：
	 *   Webview 使用内容安全策略（CSP）来控制可以加载的资源。
	 *   CSP 通过 <meta http-equiv="Content-Security-Policy"> 标签设置。
	 *
	 *   CSP 指令说明：
	 *     - default-src 'none': 默认禁止所有外部资源。
	 *     - style-src ${webview.cspSource}: 允许加载本地样式文件。
	 *       webview.cspSource 是 vscode-resource:// 协议的 URI。
	 *     - script-src 'nonce-${nonce}': 只允许带有指定 nonce 值的脚本。
	 *       nonce（number used once）是一个随机字符串，每次生成 HTML 时不同，
	 *       防止 XSS 攻击（恶意脚本注入）。
	 *     - img-src ${webview.cspSource}: 允许加载本地图片。
	 *
	 *   nonce 生成：由 getNonce() 函数生成 32 位随机字符串。
	 *   每个 <script> 标签都需要带上 nonce="${nonce}" 属性。
	 *
	 * 资源加载：
	 *   webview.asWebviewUri() 将本地文件路径转换为 Webview 可访问的 URI。
	 *   转换后的 URI 格式为 vscode-resource://... 或 vscode-webview://...
	 */
	private _getHtmlForWebview(webview: vscode.Webview): string {
		/**
		 * 将本地文件路径转换为 Webview 安全 URI。
		 *
		 * vscode.Uri.joinPath(baseUri, ...segments) 拼接路径，类似于 path.join()。
		 * 例如：extensionUri 是 /home/user/.vscode/extensions/xxx
		 *       joinPath(extensionUri, 'assets', 'webview.js')
		 *       结果是 /home/user/.vscode/extensions/xxx/assets/webview.js
		 *
		 * asWebviewUri() 将其转换为 Webview 可访问的 URI。
		 */
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'webview.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'webview.css'));
		const chartUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'chart.umd.min.js'));

		/**
		 * 生成 nonce（随机字符串）。
		 * 每次生成 HTML 时重新生成，确保安全性。
		 */
		const nonce = getNonce();

		/**
		 * 使用模板字符串（反引号 ``）构建 HTML。
		 * 模板字符串支持多行和变量插值（${变量名}）。
		 *
		 * HTML 结构说明：
		 *   - .container: Flexbox 布局的根容器，纵向排列（column）。
		 *   - .header: 标题和信号信息区域。
		 *   - .chart-container: 图表区域，flex: 1 占据剩余空间。
		 *   - .controls: 底部统计信息面板。
		 *
		 * 脚本加载顺序：
		 *   1. Chart.js（图表库） → 必须首先加载，因为 webview.js 依赖它。
		 *   2. webview.js（自定义逻辑） → 在 Chart.js 之后加载。
		 */
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
				<link rel="stylesheet" href="${styleUri}">
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h1>Radar Signal Visualizer</h1>
						<div id="signalInfo" class="signal-info"></div>
					</div>
					<div class="chart-container">
						<canvas id="signalChart"></canvas>
					</div>
					<div class="controls">
						<div class="stat">
							<span class="label">Samples:</span>
							<span id="sampleCount">0</span>
						</div>
						<div class="stat">
							<span class="label">Min:</span>
							<span id="minValue">-</span>
						</div>
						<div class="stat">
							<span class="label">Max:</span>
							<span id="maxValue">-</span>
						</div>
						<div class="stat">
							<span class="label">Mean:</span>
							<span id="meanValue">-</span>
						</div>
					</div>
				</div>
				<script src="${chartUri}" nonce="${nonce}"></script>
				<script src="${scriptUri}" nonce="${nonce}"></script>
			</body>
			</html>`;
	}

	/**
	 * 清理面板资源。
	 *
	 * 当用户关闭面板或扩展停用时调用。
	 * 清理步骤：
	 *   1. 将静态属性 currentPanel 置为 undefined（允许下次创建新面板）。
	 *   2. 调用 _panel.dispose() 关闭 Webview 面板。
	 *   3. 遍历 _disposables 数组，释放所有资源（事件监听等）。
	 *
	 * 在 VSCode 扩展开发中，及时释放资源是避免内存泄漏的关键。
	 * 特别是事件监听器、定时器、文件句柄等，如果不 dispose()，
	 * 会在扩展停用后继续存在。
	 */
	public dispose() {
		SignalVisualizerPanel.currentPanel = undefined;
		this._panel.dispose();

		/**
		 * 清理所有 Disposable 资源。
		 *
		 * while 循环从数组末尾开始弹出（pop）元素，避免数组索引变化导致的问题。
		 * 对每个元素调用 dispose() 释放资源。
		 */
		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}

/**
 * 生成 nonce（随机字符串）。
 *
 * nonce（number used once）是内容安全策略（CSP）中的安全机制。
 * 通过为每个脚本标签分配一个唯一的随机字符串，
 * CSP 可以确保只有带有正确 nonce 值的脚本才能执行。
 *
 * 这防止了 XSS 攻击：即使攻击者向页面注入了 <script> 标签，
 * 由于没有正确的 nonce 值，浏览器会拒绝执行。
 *
 * 这里生成 32 位由大小写字母和数字组成的随机字符串。
 * Math.random() 生成 [0, 1) 区间的随机浮点数。
 * Math.floor() 向下取整。
 * possible.charAt(...) 从字符集中取出对应位置的字符。
 *
 * @returns 32 位随机字符串
 */
function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
