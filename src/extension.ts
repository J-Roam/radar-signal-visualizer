/**
 * ======================================================================
 * extension.ts - 扩展入口文件（相当于 C/C++ 的 main() 函数）
 * ======================================================================
 *
 * 这是 VSCode 扩展的启动文件。VSCode 加载扩展时：
 * 1. 首先加载 main 字段指定的文件（即 out/extension.js）
 * 2. 调用其中的 activate(context) 函数
 * 3. 当扩展被禁用/卸载时调用 deactivate() 函数（可选）
 *
 * 核心概念说明：
 * - vscode.ExtensionContext: VSCode 传给 activate() 的上下文对象，提供：
 *   - context.extensionUri: 扩展安装目录的 URI（用于定位资源文件）
 *   - context.subscriptions: 一个数组，用来注册需要随扩展一起销毁的资源。
 *     VSCode 会在扩展停用时自动调用其中每个对象的 dispose() 方法，
 *     避免内存泄漏。这是 VSCode 扩展开发的重要规范。
 *
 * - 命令（Command）: VSCode 中的操作单元，通过 vscode.commands.registerCommand() 注册。
 *   注册后可以通过命令面板、快捷键、菜单等方式触发。
 *
 * - TreeDataProvider: 树视图数据提供者接口，用于向 VSCode 侧边栏的树形视图提供数据。
 *   需要实现 getTreeItem() 和 getChildren() 两个方法。
 *
 * ======================================================================
 */

import * as vscode from 'vscode';
import { SignalDataProvider } from './dataProvider';
import { SignalVisualizerPanel } from './visualizerPanel';

/**
 * 模块级变量，用于在 activate() 和命令回调之间共享数据。
 * dataProvider 实例负责从调试器获取变量数据并为树视图提供数据源。
 * 使用 let（可变）是因为在开发时可能会重新创建实例（热重载场景）。
 */
let dataProvider: SignalDataProvider;

/**
 * activate() 是扩展的入口函数，在 VSCode 激活扩展时被调用。
 *
 * @param context - VSCode 传入的扩展上下文，包含生命周期管理、扩展元数据等信息。
 *
 * 激活时机由 package.json 中的 activationEvents 控制。
 * 本项目设置为 "onDebug"，所以当用户开始调试时，VSCode 会加载本扩展并调用此函数。
 */
export function activate(context: vscode.ExtensionContext) {
	/**
	 * 1. 创建数据提供者实例。
	 *    构造函数内部会注册调试事件监听（DebugAdapterTrackerFactory），
	 *    一旦调试器命中断点，就会自动更新变量列表。
	 */
	dataProvider = new SignalDataProvider();

	/**
	 * 2. 注册树数据提供者（Tree Data Provider）。
	 *
	 *    registerTreeDataProvider() 的作用：
	 *    将 dataProvider 实例与 package.json 中定义的视图 'rsvSignals' 绑定。
	 *    当视图需要渲染时，VSCode 会调用 dataProvider 的 getChildren() 和 getTreeItem() 方法。
	 *
	 *    第一个参数 'rsvSignals' 对应 package.json -> contributes.views -> id 字段。
	 *    如果这里写的 ID 和 package.json 中的不匹配，视图将无法显示数据。
	 */
	vscode.window.registerTreeDataProvider('rsvSignals', dataProvider);

	/**
	 * 3. 注册命令：打开雷达可视化面板。
	 *
	 *    vscode.commands.registerCommand(命令ID, 回调函数)
	 *
	 *    - 第一个参数是命令的唯一标识符，对应 package.json 中 commands 的 command 字段。
	 *    - 第二个参数是命令触发时执行的回调函数。
	 *
	 *    当用户在命令面板中输入 "Open Radar Visualizer" 并回车时，会执行此回调。
	 *    SignalVisualizerPanel.createOrShow() 是静态工厂方法，采用单例模式：
	 *    如果面板已存在，就激活（reveal）它；否则创建一个新面板。
	 */
	const openPanelCommand = vscode.commands.registerCommand('rsv.openPanel', () => {
		SignalVisualizerPanel.createOrShow(context.extensionUri, dataProvider);
	});

	/**
	 * 4. 注册命令：可视化选中的信号变量。
	 *
	 *    此命令绑定在树节点的右键菜单上（见 package.json 中的 menus.view/item/context）。
	 *    当用户在 Signals 面板中右键点击某个变量并选择 "Visualize Signal" 时触发。
	 *
	 *    VSCode 会自动将树节点对象作为参数（item）传给回调函数。
	 *
	 *    空值合并运算符 ?? 的逻辑：
	 *    - 如果 SignalVisualizerPanel.currentPanel 不为 null/undefined，就使用它。
	 *    - 否则调用 createOrShow() 创建新面板并返回。
	 *    这种写法比 if-else 更简洁。
	 */
	const visualizeVariableCommand = vscode.commands.registerCommand('rsv.visualizeVariable', (item) => {
		const panel = SignalVisualizerPanel.currentPanel ?? SignalVisualizerPanel.createOrShow(context.extensionUri, dataProvider);
		panel.visualizeVariable(item);
	});

	/**
	 * 5. 注册命令：手动刷新信号变量列表。
	 *
	 *    当 DebugAdapterTracker 未能捕获到 stopped 事件（调试适配器不兼容），
	 *    或者用户步进（step）后想主动刷新变量时，可以点击刷新按钮触发此命令。
	 *
	 *    dataProvider.updateVariables() 会重新走一遍：
	 *    获取线程 → 获取调用栈 → 获取作用域 → 获取变量 → 过滤 → 刷新视图。
	 */
	const refreshCommand = vscode.commands.registerCommand('rsv.refreshSignals', () => {
		dataProvider.updateVariables();
	});

	/**
	 * 6. 将注册的命令加入扩展的订阅列表（subscriptions）。
	 *
	 *    context.subscriptions 是一个 Disposable 数组。
	 *    当扩展被停用时，VSCode 会遍历这个数组，调用每个对象的 dispose() 方法来释放资源。
	 *    registerCommand() 返回一个 Disposable 对象，必须加入 subscriptions，
	 *    否则命令会一直存在（即使扩展已停用），导致内存泄漏或冲突。
	 *
	 *    在 VSCode 扩展开发中，凡是注册类操作（命令、事件监听、视图提供者等）
	 *    产生的 Disposable 对象都应该加入 subscriptions。
	 */
	context.subscriptions.push(openPanelCommand, visualizeVariableCommand, refreshCommand);

	/**
	 * 7. 监听断点命中事件，自动展示可视化面板。
	 *
	 *    dataProvider.onDidHitBreakpoint 是我们在 SignalDataProvider 中自定义的事件。
	 *    当 DebugAdapterTracker 检测到 stopped 事件并完成变量更新后，会触发此事件。
	 *
	 *    回调逻辑：
	 *    - 读取用户的配置项 autoDisplayOnBreakpoint。
	 *    - 如果启用且当前有匹配到信号变量，自动创建可视化面板并展示第一个变量。
	 *
	 *    这实现了"断点命中 → 自动弹出波形图"的用户体验。
	 */
	const extensionUri = context.extensionUri;
	dataProvider.onDidHitBreakpoint(variables => {
		const config = vscode.workspace.getConfiguration('rsv');
		const autoDisplay = config.get<boolean>('autoDisplayOnBreakpoint', true);
		if (autoDisplay && variables.length > 0) {
			const panel = SignalVisualizerPanel.createOrShow(extensionUri, dataProvider);
			panel.visualizeVariable(variables[0]);
		}
	});

	/**
	 * 8. 监听调试会话切换事件。
	 *
	 *    onDidChangeActiveDebugSession 在以下场景触发：
	 *    - 用户启动一个新的调试会话。
	 *    - 用户在多个调试会话之间切换（多调试场景）。
	 *    - 当前调试会话结束，回退到前一个会话。
	 *
	 *    当 session 不为 null 时，说明有活跃调试，将 session 传给 dataProvider。
	 *    当 session 为 null 时（所有调试已结束），清除 dataProvider 中的 session。
	 */
	vscode.debug.onDidChangeActiveDebugSession(session => {
		if (session) {
			dataProvider.setDebugSession(session);
		} else {
			dataProvider.clearDebugSession();
		}
	});

	/**
	 * 9. 监听调试会话开始事件。
 *
	 *    onDidStartDebugSession 在用户按 F5 启动调试时触发。
 *    这里我们弹出一个信息提示，告知用户调试已开始。
 *    这是一个可选的用户体验增强，不是必须的。
	 */
	vscode.debug.onDidStartDebugSession(() => {
		vscode.window.showInformationMessage('Debug session started');
	});

	/**
	 * 10. 监听调试会话结束事件。
 *
	 *    onDidTerminateDebugSession 在调试会话终止时触发（正常退出或手动停止）。
 *    这里调用 clearDebugSession() 清空 dataProvider 中的数据并刷新视图，
 *    避免旧的信号变量在调试结束后仍然显示。
	 */
	vscode.debug.onDidTerminateDebugSession(() => {
		dataProvider.clearDebugSession();
	});
}

/**
 * deactivate() 是扩展的清理函数，在扩展被停用时调用。
 *
 * 由于我们所有的资源（命令、事件监听等）都已通过 context.subscriptions 管理，
 * VSCode 会自动调用它们的 dispose() 方法，所以这里不需要额外的清理逻辑。
 *
 * 如果扩展创建了需要手动释放的资源（如文件句柄、网络连接、定时器等），
 * 应该在这里释放。
 */
export function deactivate() {}
