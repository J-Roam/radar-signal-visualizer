/**
 * ======================================================================
 * dataProvider.ts - 数据提供者类
 * ======================================================================
 *
 * 本文件是整个扩展的"大脑"，负责与调试器交互并提取变量数据。
 * 核心职责包括：
 *   1. 监听调试事件（断点命中、调试启动/结束）
 *   2. 通过 DAP（Debug Adapter Protocol）向调试器请求变量信息
 *   3. 过滤出信号相关的变量（按名称模式、类型、大小）
 *   4. 为 VSCode 树视图提供数据（实现 TreeDataProvider 接口）
 *   5. 提取数组变量的实际数值，用于绘图
 *
 * DAP（Debug Adapter Protocol）简介：
 * VSCode 使用一套名为 DAP 的协议与调试器通信。这是一个 JSON-RPC 协议，
 * 客户端（VSCode）发送请求（如 "threads"、"stackTrace"、"variables"），
 * 调试适配器（GDB/LLDB/CUDA-GDB 等）返回响应。
 * 本扩展通过 debugSession.customRequest() 直接向调试器发送 DAP 请求，
 * 绕过 VSCode 的标准 UI 流程，获取原始变量数据。
 *
 * 变量获取的 DAP 流程（四级请求链）：
 *   threads → stackTrace → scopes → variables
 *
 *   1. threads: 获取所有线程（每个线程有一个 ID）
 *   2. stackTrace: 获取某个线程的调用栈（函数调用层次）
 *   3. scopes: 获取某个栈帧的作用域（局部变量、全局变量、寄存器等）
 *   4. variables: 获取某个作用域下的所有变量
 *
 *   获取到变量后，对于数组类型（如 std::vector），还需要通过
 *   variablesReference 递归获取子元素（数组的每个元素）。
 *
 * ======================================================================
 */

import * as vscode from 'vscode';
import { SignalVariable } from './types';

/**
 * SignalDataProvider 实现 VSCode 的 TreeDataProvider 接口。
 *
 * TreeDataProvider 是一个泛型接口 <T>，T 是树节点的数据类型。
 * 这里 T = SignalVariable，表示树中的每个节点对应一个信号变量。
 *
 * 必须实现的核心方法：
 *   - getTreeItem(element: T): vscode.TreeItem
 *     返回一个 TreeItem 对象，控制节点在 UI 中的显示（文字、图标、折叠状态等）。
 *
 *   - getChildren(element?: T): Thenable<T[]>
 *     返回节点的子节点数组。如果 element 为 undefined，返回根节点的子节点。
 *
 * 可选实现：
 *   - onDidChangeTreeData: Event 类型的属性。
 *     当数据变化时触发此事件，通知 VSCode 刷新视图。
 *     如果不实现，视图只会初始化渲染一次，不会响应数据变化。
 */
export class SignalDataProvider implements vscode.TreeDataProvider<SignalVariable> {

	/**
	 * VSCode 树视图要求数据提供者暴露一个 onDidChangeTreeData 事件。
	 *
	 * 工作原理：
	 *   - EventEmitter 是 VSCode 提供的事件发射器类，用于创建自定义事件。
	 *   - 泛型参数 <SignalVariable | undefined | null | void> 表示事件可以携带的数据类型：
	 *     - 传递具体 SignalVariable 对象 → 只刷新该节点及其子树
	 *     - 传递 undefined 或 null → 刷新整个树
	 *     - 传递 void（不传参数）→ 刷新整个树
	 *   - 调用 this._onDidChangeTreeData.fire() 时，事件触发，
	 *     VSCode 收到通知后会重新调用 getChildren() 和 getTreeItem()。
	 *
	 * 这种事件驱动的模式是 VSCode 扩展 UI 更新的标准做法，
	 * 避免了轮询（定时检查）带来的性能浪费。
	 */
	private _onDidChangeTreeData = new vscode.EventEmitter<SignalVariable | undefined | null | void>();

	/**
	 * readonly 修饰符表示这个属性只能被读取，不能被重新赋值。
	 * 但 _onDidChangeTreeData.event 返回的事件对象本身是可以触发（fire）的，
	 * readonly 只是防止外部代码替换整个事件源。
	 *
	 * VSCode 会订阅这个事件，当数据变化时自动刷新树视图。
	 */
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/**
	 * 自定义事件：当断点命中并完成变量更新后触发。
	 *
	 * 与 onDidChangeTreeData 不同，这个事件不是 VSCode 接口要求的，
	 * 而是我们自定义的业务逻辑事件。
	 * 它的作用是通知 extension.ts 中的监听器：变量已更新，可以自动展示可视化面板。
	 *
	 * 携带的数据是匹配到的信号变量数组，监听器可以决定展示哪些变量。
	 */
	private _onDidHitBreakpoint = new vscode.EventEmitter<SignalVariable[]>();
	readonly onDidHitBreakpoint = this._onDidHitBreakpoint.event;

	/**
	 * 当前活跃的调试会话。
	 * undefined 表示没有正在进行的调试。
	 *
	 * vscode.DebugSession 代表一个调试会话实例，包含：
	 *   - id: 会话唯一标识符
	 *   - name: 会话名称（如 "GDB"、"CUDA-GDB"）
	 *   - type: 调试器类型（如 "cppdbg"、"cuda-gdb"）
	 *   - customRequest(command, args): 发送 DAP 请求的核心方法
	 */
	private debugSession: vscode.DebugSession | undefined;

	/**
	 * 当前过滤后的信号变量列表。
	 * 这个数组是树视图的数据源，由 getChildren() 返回。
	 * 每次 updateVariables() 执行后会被重新赋值。
	 */
	private currentVariables: SignalVariable[] = [];

	/**
	 * 最近一次 "stopped" 事件中携带的 threadId。
	 *
	 * DAP stopped 事件的 body 形如：
	 *   { reason: 'breakpoint', threadId: 12345, allThreadsStopped: true, ... }
	 * threadId 是真正触发这次停止的线程。
	 *
	 * 为什么需要保存：
	 *   - CPU (GDB) 场景：单线程程序里 threads[0] 就是主线程，两者等价。
	 *   - CUDA (cuda-gdb) 场景：kernel 断点命中时可能有成千上万个 CUDA 线程，
	 *     threads[0] 几乎一定不是真正停下来的那一个；
	 *     必须用 stopped 事件里给出的 threadId 才能定位到正确的栈帧和变量。
	 *
	 * undefined 表示还没有收到过 stopped 事件，
	 * updateVariables() 会退化为 threads[0]（兜底）。
	 */
	private lastStoppedThreadId: number | undefined;

	/**
	 * 最近一次栈帧查询拿到的 frameId。
	 *
	 * evaluate DAP 请求需要 frameId 来定位“表达式在哪个栈帧的上下文里求值”。
	 * 在 updateVariables() 已经拿到 frameId 的地方顺手缓存一份，
	 * getVariableData() 用到时直接读，避免再次发 stackTrace 请求。
	 */
	private lastStoppedFrameId: number | undefined;

	/**
	 * 构造函数，在 extension.ts 中 new SignalDataProvider() 时调用。
	 * 这里调用 listenToDebugEvents() 注册调试事件监听。
	 *
	 * 注意：构造函数中不应该有耗时的同步操作，
	 * 但注册事件监听是轻量级的，所以可以放在这里。
	 */
	constructor() {
		this.listenToDebugEvents();
	}

	/**
	 * 注册调试事件监听。
	 *
	 * 这里使用了两种机制来捕获调试状态变化：
	 *   1. onDidChangeActiveDebugSession → 获取调试会话对象
	 *   2. DebugAdapterTrackerFactory → 拦截 DAP 消息，检测断点命中
	 *
	 * 为什么需要 DebugAdapterTrackerFactory？
	 * VSCode 的 onDidReceiveDebugSessionCustomEvent 只接收"自定义" DAP 事件，
	 * 而 "stopped"（断点命中/步进停止）是 DAP 标准事件，VSCode 会在内部消费它，
	 * 不会转发给扩展。因此必须通过 DebugAdapterTrackerFactory 来拦截所有 DAP 消息。
	 */
	private listenToDebugEvents() {
		/**
		 * 监听活跃调试会话的变化。
		 *
		 * 触发场景：
		 *   - 用户按 F5 启动调试
		 *   - 用户在多个调试会话间切换
		 *   - 调试会话结束
		 *
		 * 当 session 有值时，保存下来供后续 DAP 请求使用。
		 */
		vscode.debug.onDidChangeActiveDebugSession(session => {
			if (session) {
				this.debugSession = session;
			}
		});

		/**
		 * 注册 DebugAdapterTrackerFactory。
		 *
		 * DebugAdapterTrackerFactory 是 VSCode 提供的一个工厂接口，
		 * 用于为调试适配器创建跟踪器（Tracker）。
		 * 跟踪器可以观察和拦截调试适配器与 VSCode 之间的所有 DAP 消息。
		 *
		 * 第一个参数 '*' 表示对所有类型的调试适配器生效（GDB、LLDB、CUDA-GDB 等）。
		 * 如果只想针对特定调试器，可以替换为具体的 type 值（如 'cppdbg'）。
		 *
		 * createDebugAdapterTracker() 返回一个 DebugAdapterTracker 对象，
		 * 其中可以定义：
		 *   - onWillStartSession(): 调试会话即将开始
		 *   - onWillSendMessage(message): VSCode → 调试适配器的消息
		 *   - onDidReceiveMessage(message): 调试适配器 → VSCode 的消息
		 *   - onWillStopSession(): 调试会话即将结束
		 *   - onDidSendMessage(message): 调试适配器 → VSCode 的消息（与 onDidReceiveMessage 相同）
		 *
		 * 我们关注 onDidSendMessage，因为 "stopped" 事件是从调试适配器发出的。
		 */
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker: (session: vscode.DebugSession) => ({
				/**
				 * 当调试适配器向 VSCode 发送消息时调用。
				 *
				 * 消息格式（DAP 协议）：
				 *   {
				 *     type: 'event' | 'response' | 'request',
				 *     event: 'stopped' | 'terminated' | 'output' | ...,  // 仅 type='event' 时有此字段
				 *     body: { ... },  // 事件/请求的具体数据
				 *     ...
				 *   }
				 *
				 * "stopped" 事件在以下情况触发：
				 *   - 命中断点
				 *   - 用户执行 step over/into/out
				 *   - 程序异常/崩溃
				 *   - 用户手动暂停程序
				 *
				 * 这里的 session 参数是触发此事件的调试会话，
				 * 可能与 this.debugSession 不同（多调试场景下）。
				 */
				onDidSendMessage: (message: any) => {
					if (message.type === 'event' && message.event === 'stopped') {
						this.debugSession = session;
						/**
						 * 从 stopped 事件 body 中提取触发断点的 threadId。
						 *
						 * 对 CUDA 场景至关重要：一次 kernel 调用会产生大量线程，
						 * 只有 body.threadId 指向的才是真正命中断点的那个。
						 *
						 * 某些适配器可能不提供 body.threadId（极少见），
						 * 此时保持 undefined，updateVariables() 会退化到 threads[0]。
						 */
						const stoppedThreadId = message.body && message.body.threadId;
						if (typeof stoppedThreadId === 'number') {
							this.lastStoppedThreadId = stoppedThreadId;
						}
						this.updateVariables();
					} else if (message.type === 'event' && message.event === 'continued') {
						/**
						 * 调试器恢复执行时，之前记录的 threadId / frameId 不再有效，清空。
						 * 下一次 stopped 事件会重新填充。
						 */
						this.lastStoppedThreadId = undefined;
						this.lastStoppedFrameId = undefined;
					}
				}
			})
		});
	}

	/**
	 * 设置当前调试会话。
	 *
	 * 由 extension.ts 中的 onDidChangeActiveDebugSession 事件监听器调用。
	 * 同时刷新视图，确保切换到新调试会话时视图显示最新数据。
	 */
	setDebugSession(session: vscode.DebugSession) {
		this.debugSession = session;
		this.refresh();
	}

	/**
	 * 清除调试会话。
	 *
	 * 在调试结束时调用，清空数据并刷新视图，
	 * 避免调试结束后旧的信号变量仍然显示在面板中。
	 */
	clearDebugSession() {
		this.debugSession = undefined;
		this.currentVariables = [];
		this.lastStoppedThreadId = undefined;
		this.lastStoppedFrameId = undefined;
		this.refresh();
	}

	/**
	 * 从调试器获取当前栈帧的变量并更新信号变量列表。
	 *
	 * 这是本扩展的核心方法，实现了 DAP 四级请求链：
	 *   threads → stackTrace → scopes → variables
	 *
	 * 调用时机：
	 *   - DebugAdapterTracker 检测到 "stopped" 事件时自动调用
	 *   - 用户点击刷新按钮时手动调用（extension.ts 中的 rsv.refreshSignals 命令）
	 *
	 * 异步函数（async）：因为每个 DAP 请求都是网络/IPC 调用，需要等待响应。
	 * await 关键字暂停函数执行，直到异步操作完成。
	 */
	async updateVariables() {
		if (!this.debugSession) {
			console.log('Radar Signal Visualizer: updateVariables called but no debug session');
			return;
		}

		try {
			/**
			 * 第 1 步：获取线程列表。
			 *
			 * customRequest() 是发送 DAP 请求的通用方法。
			 * 第一个参数是 DAP 命令名，第二个参数是命令参数。
			 *
			 * "threads" 请求不需要参数，返回所有线程的信息。
			 * 响应格式：{ threads: [{ id: number, name: string }, ...] }
			 */
			/**
			 * 选择要查询的线程 ID。
			 *
			 * 优先级：
			 *   1. lastStoppedThreadId（来自 DAP stopped 事件）——最准确，
			 *      直接对应用户断点命中的那个线程。
			 *      在 CUDA 场景下是必须的，kernel 断点时可能有上万线程。
			 *   2. threads 请求返回的第一个线程——兜底方案，
			 *      适用于未能捕获到 stopped 事件或手动刷新的情况。
			 *
			 * 这里先看有没有缓存的 stopped threadId，若无再发 threads 请求。
			 */
			let threadId: number | undefined = this.lastStoppedThreadId;
			if (threadId === undefined) {
				const threadsResponse = await this.debugSession.customRequest('threads');
				const threads: { id: number; name: string }[] = threadsResponse.threads || [];
				if (threads.length === 0) {
					console.log('Radar Signal Visualizer: No threads found');
					return;
				}
				threadId = threads[0].id;
			}

			/**
			 * 第 2 步：获取调用栈（Stack Trace）。
			 *
			 * "stackTrace" 请求需要线程 ID 作为参数。
			 * 返回该线程的函数调用栈，从当前函数到 main() 的完整调用链。
			 *
			 * 响应格式：
			 *   {
			 *     stackFrames: [
			 *       { id: number, name: string, line: number, column: number, ... },
			 *       ...
			 *     ],
			 *     totalFrames: number  // 总栈帧数
			 *   }
			 *
			 * stackFrames[0] 是当前正在执行的函数（最内层）。
			 */
			const stackTrace = await this.debugSession.customRequest('stackTrace', {
				threadId
			});

			if (!stackTrace.stackFrames || stackTrace.stackFrames.length === 0) {
				console.log('Radar Signal Visualizer: No stack frames found');
				return;
			}

			/**
			 * 取当前栈帧的 ID（即用户断点所在的函数）。
			 * 后续需要用这个 ID 获取该帧的作用域。
			 */
			const frameId = stackTrace.stackFrames[0].id;
			// 缓存给 getVariableData() 在后续 evaluate 时复用
			this.lastStoppedFrameId = frameId;

			/**
			 * 第 3 步：获取栈帧的作用域（Scopes）。
			 *
			 * "scopes" 请求需要栈帧 ID。
			 * 返回该帧的所有作用域（局部变量、全局变量、寄存器、this 指针等）。
			 *
			 * 响应格式：
			 *   {
			 *     scopes: [
			 *       {
			 *         name: "Locals",          // 作用域名称
			 *         variablesReference: 42,  // 用于获取变量的引用 ID
			 *         expensive: false         // 是否"昂贵"（如全局变量可能需要遍历整个内存）
			 *       },
			 *       { name: "Globals", variablesReference: 43, expensive: true },
			 *       ...
			 *     ]
			 *   }
			 *
			 * 我们取第一个作用域（通常是 "Locals"，局部变量），
			 * 因为信号变量一般定义在函数内部。
			 */
			const scopes = await this.debugSession.customRequest('scopes', {
				frameId
			});

			if (!scopes.scopes || scopes.scopes.length === 0) {
				console.log('Radar Signal Visualizer: No scopes found');
				return;
			}

			/**
			 * 第 4 步：获取变量列表。
			 *
			 * "variables" 请求需要 variablesReference（来自 scopes）。
			 * 返回该作用域下的所有变量。
			 *
			 * 响应格式：
			 *   {
			 *     variables: [
			 *       {
			 *         name: "pulse_data",
			 *         value: "std::vector of length 256, capacity 256",
			 *         type: "std::vector<float>",
			 *         variablesReference: 100  // > 0 表示有子元素（数组元素/结构体字段）
			 *       },
			 *       {
			 *         name: "count",
			 *         value: "42",
			 *         type: "int",
			 *         variablesReference: 0    // == 0 表示无子元素（简单类型）
			 *       },
			 *       ...
			 *     ]
			 *   }
			 *
			 * variablesReference 是 DAP 中非常重要的概念：
			 *   - 0: 变量是简单类型（int、float 等），value 字段就是最终值。
			 *   - > 0: 变量是复合类型（数组、结构体、类），需要再次发 "variables" 请求
			 *          并用这个 reference 作为参数来获取子元素。
			 */
			const variables = await this.debugSession.customRequest('variables', {
				variablesReference: scopes.scopes[0].variablesReference
			});

			const allVars = variables.variables || [];
			console.log(`Radar Signal Visualizer: Found ${allVars.length} variables in scope`);

			/**
			 * 过滤变量：
			 *   1. 名称匹配信号模式（如包含 "signal"、"data" 等）
			 *   2. 是数组类型（有子元素或值中包含数组特征）
			 *   3. 大小在限制范围内（避免超大数组影响性能）
			 *
			 * 过滤后映射为 SignalVariable 类型，供树视图使用。
			 */
			this.currentVariables = this.filterSignalVariables(allVars);
			console.log(`Radar Signal Visualizer: ${this.currentVariables.length} variables matched signal patterns`,
				this.currentVariables.map(v => v.name));

			/**
			 * 刷新树视图：通知 VSCode 数据已变化，重新渲染面板。
			 *
			 * 注意：这里不再预取数据。上一版预取会消耗 vector 的 variablesReference，
			 * 导致用户在 VSCode 自带变量面板里展开 vector 时报错。
			 * 新策略采用 evaluate + 数组表达式，在 getVariableData() 里按需获取，
			 * 完全不碰原变量的 ref。
			 */
			this.refresh();

			/**
			 * 触发自定义断点事件，通知 extension.ts 可以自动展示可视化面板。
			 */
			this._onDidHitBreakpoint.fire(this.currentVariables);

		} catch (error) {
			console.error('Radar Signal Visualizer: Failed to update variables', error);
		}
	}

	/**
	 * 过滤信号变量。
	 *
	 * 对原始变量列表进行三轮过滤：
	 *   1. 名称模式匹配（isSignalVariable）
	 *   2. 数组类型检查（isArrayVariable）
	 *   3. 大小限制检查（isWithinSizeLimit）
	 *
	 * 然后通过 map() 将原始变量对象映射为 SignalVariable 接口格式。
	 *
	 * 这种"函数式链式调用"的写法（filter().filter().filter().map()）
	 * 在 TypeScript/JavaScript 中很常见，比嵌套 if-else 更清晰。
	 */
	private filterSignalVariables(variables: any[]): SignalVariable[] {
		/**
		 * 读取用户配置。
		 *
		 * vscode.workspace.getConfiguration(section: string) 获取指定前缀的配置对象。
		 * section 参数对应 package.json 中 configuration.properties 的键名前缀。
		 * 例如 'rsv' 对应 'rsv.autoDisplayOnBreakpoint'、'rsv.signalNamePatterns' 等。
		 *
		 * config.get<T>(key, defaultValue) 获取具体配置项。
		 * 泛型 <T> 告诉 TypeScript 返回值的类型，提供代码补全和类型检查。
		 * 第二个参数是默认值，当用户未设置此配置时使用。
		 */
		const config = vscode.workspace.getConfiguration('rsv');
		const patterns = config.get<string[]>('signalNamePatterns', ['*signal*', '*data*', '*pulse*', '*sample*']);
		const maxSize = config.get<number>('maxArraySize', 100000);

		return variables
			.filter((v: any) => this.isSignalVariable(v, patterns))
			.filter((v: any) => this.isArrayVariable(v))
			.filter((v: any) => this.isWithinSizeLimit(v, maxSize))
			.map((v: any) => ({
				name: v.name,
				value: v.value,
				type: v.type,
				variablesReference: v.variablesReference,
				children: v.variablesReference > 0  // 有子元素则可折叠
			}));
	}

	/**
	 * 判断变量名是否匹配信号模式。
	 *
	 * 模式语法是通配符风格（如 *signal*），需要转换为正则表达式：
	 *   *signal*  →  .*signal.*  （匹配任何包含 "signal" 的字符串）
	 *   *data*    →  .*data.*
	 *
	 * .replace(/[*]/g, '.*') 将所有星号替换为 .*（正则中的任意字符匹配）。
	 *
	 * .some() 是数组方法，只要有一个模式匹配成功就返回 true。
	 */
	private isSignalVariable(variable: any, patterns: string[]): boolean {
		const name = variable.name.toLowerCase();
		return patterns.some(pattern => {
			const regex = new RegExp(pattern.replace(/\*/g, '.*'));
			return regex.test(name);
		});
	}

	/**
	 * 判断变量是否是数组类型。
	 *
	 * 通过三个条件之一来判断：
	 *   1. value 中包含 "[0]" → C 风格数组的显示格式
	 *   2. value 中包含 "array" → 某些调试器的显示格式
	 *   3. variablesReference > 0 → 有子元素，说明是复合类型（数组/结构体/类）
	 *
	 * 条件 3 是最通用的判断方式，因为 std::vector、原生数组等都有子元素。
	 */
	private isArrayVariable(variable: any): boolean {
		if (!variable.value) return false;
		const value = variable.value.toLowerCase();
		return value.includes('[0]') || value.includes('array') || variable.variablesReference > 0;
	}

	/**
	 * 检查数组大小是否在允许范围内。
	 *
	 * 从 value 字符串中提取数组大小。例如：
	 *   "std::vector of length 256, capacity 256" → 匹配到 [256] → size = 256
	 *   "[1024]" → 匹配到 [1024] → size = 1024
	 *
	 * 正则 /\[(\d+)\]/ 匹配方括号中的数字：
	 *   \[     → 匹配左方括号
	 *   (\d+)  → 捕获一个或多个数字（括号表示捕获组）
	 *   \]     → 匹配右方括号
	 *
	 * 如果没有匹配到大小信息（如 "array"），返回 true（假设大小可接受）。
	 */
	private isWithinSizeLimit(variable: any, maxSize: number): boolean {
		const match = variable.value.match(/\[(\d+)\]/);
		if (match) {
			const size = parseInt(match[1]);
			return size <= maxSize;
		}
		return true;
	}

	/**
	 * 获取变量的实际数值数组，用于绘图。
	 *
	 * 这是绘图的入口方法，由 SignalVisualizerPanel.visualizeVariable() 调用。
	 * 返回值是 Promise<number[]>，因为数据获取是异步的。
	 *
	 * 工作原理：
	 *   1. 检查变量是否有子元素（variablesReference > 0）
	 *   2. 如果有，调用 collectNumericChildren() 递归收集所有数值
	 *   3. 返回收集到的数值数组
	 *
	 * @param variable - 要提取数据的信号变量
	 * @returns Promise<number[]> - 解析为数值的 Promise
	 */
	async getVariableData(variable: SignalVariable): Promise<number[]> {
		if (!this.debugSession) {
			throw new Error('No active debug session');
		}

		const data: number[] = [];

		/**
		 * 核心策略：DAP evaluate 请求 + GDB 的 @ 人工数组语法。
		 *
		 * 为什么不直接用 variable.variablesReference：
		 * cuda-gdb 下同一 ref 只能请求一次。如果我们消耗了该 ref，
		 * 用户在 VSCode 自带变量面板里再点展开就会失败。
		 *
		 * GDB @ 语法简介：
		 *   *pointer@count → 把连续的 count 个元素视为一个人工数组。
		 *   例：对 std::vector<float> v，*v.data()@v.size() 返回一个 float[size] 视图。
		 *   请求返回的 variablesReference 是此次 evaluate 临时生成的新 ref，
		 *   与原 vector 的 ref 完全独立，消耗它不影响用户面板的展开。
		 *
		 * cuda-gdb 基于 GDB，原生支持此语法。
		 */
		try {
			// 1) 判断是否是 STL 容器（决定使用 .data() 还是直接取地址）
			const isStlContainer = /vector|array<|deque/.test(variable.type);

			// 2) 获取数组大小。依次尝试三个来源：
			//    (a) 类型字符串里的 [N]（原生数组 float[256]）
			//    (b) evaluate("name.size()") 发起 inferior call（STL 容器）
			//    (c) value 字符串里的 "length N"（gdb 原生 pretty-print）
			//
			// 为什么要多路径：cuda-gdb 的 pretty-printer 把 vector value 输出为 "{...}"，
			// 无法从中提取 size。必须调 .size() 或依赖类型中的常量大小。
			let size = 0;

			const sizeFromType = variable.type.match(/\[(\d+)\]/);
			if (sizeFromType) {
				size = parseInt(sizeFromType[1]);
			}

			if (size === 0 && isStlContainer) {
				// (b1) 先试 .size() inferior call
				try {
					const sizeResp = await this.debugSession.customRequest('evaluate', {
						expression: `${variable.name}.size()`,
						context: 'watch',
						frameId: this.lastStoppedFrameId
					});
					const m = typeof sizeResp.result === 'string' ? sizeResp.result.match(/-?\d+/) : null;
					const parsed = m ? parseInt(m[0], 10) : NaN;
					if (!isNaN(parsed) && parsed > 0) {
						size = parsed;
					}
				} catch (err) {
					console.warn(`Radar Signal Visualizer: ${variable.name}.size() evaluate failed (may be inlined), will try libstdc++ internals`, err);
				}

				// (b2) fallback：libstdc++ 内部字段指针减法。
				// 为什么这样可行：_M_impl._M_start 和 _M_finish 是成员字段（非函数），
				// 读取它们只是内存加载 + 指针算术，不涉及 inferior call，不会报 "may be inlined"。
				// 适用范围：Linux 下 GNU libstdc++（WSL/Ubuntu 默认）。
				// libc++ 或 MSVC 的 STL 实现字段名不同，但目标平台主要是 libstdc++。
				if (size === 0) {
					try {
						const diffResp = await this.debugSession.customRequest('evaluate', {
							expression: `${variable.name}._M_impl._M_finish - ${variable.name}._M_impl._M_start`,
							context: 'watch',
							frameId: this.lastStoppedFrameId
						});
						const m = typeof diffResp.result === 'string' ? diffResp.result.match(/-?\d+/) : null;
						const parsed = m ? parseInt(m[0], 10) : NaN;
						if (!isNaN(parsed) && parsed > 0) {
							size = parsed;
							console.log(`Radar Signal Visualizer: size for ${variable.name} via libstdc++ internals: ${size}`);
						}
					} catch (err) {
						console.warn(`Radar Signal Visualizer: libstdc++ internals size failed for ${variable.name}`, err);
					}
				}
			}

			if (size === 0) {
				const sizeFromValue = variable.value.match(/length\s+(\d+)/);
				if (sizeFromValue) {
					size = parseInt(sizeFromValue[1]);
				}
			}

			if (size <= 0) {
				console.warn(`Radar Signal Visualizer: cannot determine size of ${variable.name} from value="${variable.value}" type="${variable.type}"`);
				return data;
			}

			// 3) 构造人工数组表达式。
			//    STL 容器：不能用 .data()（同样是 inline 函数），改用 libstdc++ 字段 _M_impl._M_start。
			//      该字段本身就是正确类型的数据指针（如 float*）。
			//    原生数组/指针：*(name)@size 即可。
			const expression = isStlContainer
				? `*(${variable.name}._M_impl._M_start)@${size}`
				: `*(${variable.name})@${size}`;

			console.log(`Radar Signal Visualizer: evaluating "${expression}" (size=${size}) in frame ${this.lastStoppedFrameId}`);

			// 4) 发 evaluate 请求。
			const evalResp = await this.debugSession.customRequest('evaluate', {
				expression,
				context: 'watch',
				frameId: this.lastStoppedFrameId
			});

			// 5) 展开 evaluate 返回的新 ref。
			if (evalResp.variablesReference && evalResp.variablesReference > 0) {
				await this.collectNumericChildren(evalResp.variablesReference, data);
				console.log(`Radar Signal Visualizer: evaluate got ${data.length} values for ${variable.name}`);
			} else {
				console.warn(`Radar Signal Visualizer: evaluate returned no variablesReference for ${variable.name}, result="${evalResp.result}"`);
			}
		} catch (error) {
			console.error('Radar Signal Visualizer: getVariableData (evaluate) failed', error);
			vscode.window.showErrorMessage(`Failed to get variable data: ${error}`);
		}

		return data;
	}

	/**
	 * 递归收集复合变量中的所有数值。
	 *
	 * 这是处理 std::vector、嵌套结构体的核心方法。
	 *
	 * GDB 对 std::vector<float> 的 pretty-print 展开结构示例：
	 *
	 *   pulse_data (variablesReference=100)
	 *   ├── [0] → 0.123        (variablesReference=0)   ← 叶子节点，直接取值
	 *   ├── [1] → 0.456        (variablesReference=0)
	 *   ├── [2] → 0.789        (variablesReference=0)
	 *   └── ...
	 *
	 * 或者对于某些 STL 实现：
	 *
	 *   pulse_data (variablesReference=100)
	 *   └── _M_impl (variablesReference=200)    ← 嵌套结构
	 *       ├── _M_start → 0x7fff... (pointer)  ← 指针，无法直接取值
	 *       └── _M_finish → 0x7fff... (pointer)
	 *
	 * 处理策略：
	 *   1. 如果是叶子节点（variablesReference == 0）且值是数值 → 直接采集
	 *   2. 如果有子元素（variablesReference > 0）：
	 *      a. 如果是数组元素（[0]、[1]、...）→ 尝试取值，否则递归
	 *      b. 否则（嵌套结构 _M_impl 等）→ 递归查找数值
	 *
	 * @param variablesReference - DAP 变量引用 ID
	 * @param data - 累积结果的数组（传引用，直接修改）
	 * @param depth - 当前递归深度（防止无限递归）
	 */
	private async collectNumericChildren(variablesReference: number, data: number[], depth: number = 0): Promise<void> {
		/**
		 * 递归深度限制。
		 *
		 * 防止某些异常数据结构导致无限递归（如循环引用）。
		 * 深度 5 足以覆盖绝大多数 STL 容器的嵌套层次。
		 */
		if (depth > 5) {
			return; // 防止无限递归
		}

		/**
		 * 发送 DAP "variables" 请求，获取子元素列表。
		 * debugSession! 中的 ! 是 TypeScript 的非空断言操作符，
		 * 告诉编译器 this.debugSession 一定不为 undefined（前面已检查过）。
		 */
		const response = await this.debugSession!.customRequest('variables', {
			variablesReference
		});

		const children = response.variables || [];

		for (const child of children) {
			const num = parseFloat(child.value);

			/**
			 * 情况 1：叶子节点（无子元素）且是数值 → 直接采集。
			 * child.variablesReference === 0 表示无子元素。
			 * !isNaN(num) 确保值可以解析为有效数字（排除 "0x7fff..." 等指针）。
			 */
			if (!isNaN(num) && child.variablesReference === 0) {
				data.push(num);

			/**
			 * 情况 2：有子元素的复合类型 → 需要递归处理。
			 */
			} else if (child.variablesReference > 0) {
				/**
				 * 判断是否是数组元素（[0]、[1]、[2]、...）。
				 *
				 * 正则 /^\[\d+\]$/ 匹配：
				 *   ^     → 字符串开头
				 *   \[    → 左方括号
				 *   \d+   → 一个或多个数字
				 *   \]    → 右方括号
				 *   $     → 字符串结尾
				 *
				 * 例如："[0]" → true，"[123]" → true，"_M_impl" → false
				 */
				const isArrayElement = /^\[\d+\]$/.test(child.name);

				if (isArrayElement) {
					/**
					 * 数组元素：优先尝试直接解析值。
					 * 如果值本身就是数值（如 "0.123"），直接采集。
					 * 否则（可能是指针或其他格式），递归获取。
					 */
					if (!isNaN(num)) {
						data.push(num);
					} else {
						await this.collectNumericChildren(child.variablesReference, data, depth + 1);
					}
				} else {
					/**
					 * 非数组元素（如 _M_impl、_M_start 等内部结构）。
					 * 递归查找，可能在更深层找到实际数值。
					 */
					await this.collectNumericChildren(child.variablesReference, data, depth + 1);
				}
			}
		}
	}

	/**
	 * 刷新树视图。
	 *
	 * 调用 _onDidChangeTreeData.fire() 触发数据变化事件。
	 * VSCode 收到事件后会重新调用 getChildren() 和 getTreeItem() 渲染视图。
	 *
	 * 参数说明：
	 *   - 不传参数（或传 undefined/null） → 刷新整个树
	 *   - 传具体 SignalVariable 对象 → 只刷新该节点及其子树（优化性能）
	 *
	 * 这里我们刷新整个树，因为变量列表可能整体变化（断点在不同函数）。
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/**
	 * 返回树节点的 UI 描述（TreeItem）。
	 *
	 * VSCode 在渲染树视图时，对每个节点调用此方法获取显示信息。
	 *
	 * TreeItem 的参数：
	 *   - label: 节点显示的文字（通常是变量名）。
	 *   - collapsibleState: 折叠状态。
	 *     - Collapsed: 可折叠，默认收起。
	 *     - Expanded: 可折叠，默认展开。
	 *     - None: 不可折叠（叶子节点）。
	 *
	 * TreeItem 的其他属性：
	 *   - description: 显示在 label 右侧的描述文字（这里显示变量类型）。
	 *   - tooltip: 鼠标悬停时显示的提示文字。
	 *   - contextValue: 上下文标识符，用于菜单的 "when" 条件判断。
	 *     例如 menus.view/item/context 中 "viewItem == signalVariable"。
	 */
	getTreeItem(element: SignalVariable): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(
			element.name,
			element.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		treeItem.description = `${element.type}`;
		treeItem.tooltip = `${element.name}: ${element.value}`;
		treeItem.contextValue = 'signalVariable';
		return treeItem;
	}

	/**
	 * 返回节点的子节点列表。
	 *
	 * VSCode 渲染树视图时：
	 *   1. 先调用 getChildren(undefined) 获取根节点的子节点（即所有信号变量）。
	 *   2. 对于每个子节点，如果 TreeItemCollapsibleState 不是 None，
	 *      用户展开时会再次调用 getChildren(该节点)，获取其子元素。
	 *
	 * 在本扩展中，我们只展示顶层的信号变量（不展示子元素），所以：
	 *   - element === undefined → 返回所有信号变量
	 *   - element !== undefined → 返回空数组（无子节点）
	 *
	 * Thenable<T> 是 Promise<T> 的超集，可以返回 Promise 或普通值。
	 * Promise.resolve() 将普通值包装为 Promise，保证返回类型一致。
	 */
	getChildren(element?: SignalVariable): Thenable<SignalVariable[]> {
		if (!element) {
			return Promise.resolve(this.currentVariables);
		}
		return Promise.resolve([]);
	}
}
