/**
 * ======================================================================
 * dataProvider.ts - 已 Pin 变量数据提供者
 * ======================================================================
 *
 * 重构版本。旧流程（自动扫描变量名 + 递归展开 DAP variables 子树）已废弃。
 * 新流程：
 *   1. 用户在 VSCode Variables 面板右键某个变量 → rsv.pinVariable
 *      命令收到 ctx = { variable, container, sessionId, frameId } 调 pinFromContext
 *   2. pinFromContext 通过 inferTypeInfo 解析 C++ 类型，生成 PinnedVariable 入队
 *   3. readSignalBytes:
 *        evaluate 得到数据指针（0x... 形式 memoryReference）与 size
 *        customRequest('readMemory', { memoryReference, count, offset }) 拿 base64 裸字节
 *        Buffer.from + DataView 按 elementType 解码为 number[]
 *   4. 通过 _onDidUpdatePinned 通知 extension 层同步 webview 卡片
 *
 * 避开的坑：
 *   • 不调用 .size() / .data() 等 inline 函数，避免 "Cannot evaluate -- may be inlined"
 *   • 不消耗原 vector 的 variablesReference，不会破坏 VSCode 自带变量面板的展开
 *   • stl 走 libstdc++ 私有字段 _M_impl._M_start / _M_impl._M_finish
 *
 * ======================================================================
 */

import * as vscode from 'vscode';
import { PinnedVariable, ContainerKind } from './types';

/**
 * 元素类型 → 单元素字节数。
 * 新元素类型在这里登记；decodeOne 按同一名称取解码函数。
 */
const BYTES_PER_ELEMENT: Record<string, number> = {
	'float': 4, 'double': 8,
	'int': 4, 'int32_t': 4, 'uint32_t': 4, 'unsigned int': 4,
	'short': 2, 'int16_t': 2, 'uint16_t': 2, 'unsigned short': 2,
	'char': 1, 'int8_t': 1, 'uint8_t': 1, 'unsigned char': 1, 'signed char': 1,
	'long': 8, 'int64_t': 8, 'uint64_t': 8, 'unsigned long': 8,
	'long long': 8, 'unsigned long long': 8,
	'cuFloatComplex': 8, 'std::complex<float>': 8,
	'cuDoubleComplex': 16, 'std::complex<double>': 16,
};

export class SignalDataProvider implements vscode.TreeDataProvider<PinnedVariable> {

	/** VSCode TreeView 数据变化事件 */
	private _onDidChangeTreeData = new vscode.EventEmitter<PinnedVariable | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** 自定义事件：pinned 列表或其 lastData 发生变化；extension 层据此通知 webview */
	private _onDidUpdatePinned = new vscode.EventEmitter<PinnedVariable[]>();
	readonly onDidUpdatePinned = this._onDidUpdatePinned.event;

	/** 当前活跃调试会话 */
	private debugSession: vscode.DebugSession | undefined;

	/** 已 Pin 列表，顺序即 UI 中的卡片顺序 */
	private pinned: PinnedVariable[] = [];

	/** 最近一次 stopped 事件的 threadId，用于定位 frameId */
	private lastStoppedThreadId: number | undefined;

	/** 最近一次 stopped 事件的 frameId，所有 evaluate 请求都用它 */
	private lastStoppedFrameId: number | undefined;

	/** 单调递增 ID 生成器，用于卡片 DOM 复用 */
	private nextId = 1;

	constructor() {
		this.listenToDebugEvents();
	}

	// ====================================================================
	// 公有 API（供 extension.ts 调用）
	// ====================================================================

	/** 获取已 Pin 列表快照（webview syncAllCards 用） */
	getPinned(): PinnedVariable[] {
		return this.pinned;
	}

	/**
	 * 由 rsv.pinVariable 命令调用。
	 * ctx 形状：{ variable: DebugProtocol.Variable, container, sessionId, frameId? }
	 * variable 字段含 name / value / type / evaluateName / memoryReference / variablesReference。
	 */
	async pinFromContext(ctx: any): Promise<PinnedVariable | undefined> {
		const v = ctx?.variable;
		if (!v) {
			vscode.window.showErrorMessage('Radar Signal Visualizer: no variable in context');
			return undefined;
		}
		if (!v.type) {
			vscode.window.showErrorMessage(`Radar Signal Visualizer: variable "${v.name}" has no type info`);
			return undefined;
		}

		// 若右键菜单的 ctx 里携带 frameId，优先采用它；否则复用 tracker 缓存的。
		if (typeof ctx.frameId === 'number') {
			this.lastStoppedFrameId = ctx.frameId;
		}

		let info: { containerKind: ContainerKind; elementType: string; bytesPerElement: number; sizeHint?: number };
		try {
			info = this.inferTypeInfo(v.type);
		} catch (e: any) {
			vscode.window.showErrorMessage(`Radar Signal Visualizer: ${e.message ?? e}`);
			return undefined;
		}

		// pointer 种类需要用户输入 size
		let sizeHint = info.sizeHint;
		if (info.containerKind === 'pointer' && sizeHint === undefined) {
			const input = await vscode.window.showInputBox({
				title: `Pin ${v.name}`,
				prompt: `Variable is a raw pointer (${v.type}). Enter element count:`,
				validateInput: s => /^\d+$/.test(s) && parseInt(s) > 0 ? undefined : 'Positive integer required',
			});
			if (!input) return undefined;
			sizeHint = parseInt(input, 10);
		}

		const pinned: PinnedVariable = {
			id: `pin-${this.nextId++}`,
			evaluateName: v.evaluateName ?? v.name,
			displayName: v.name,
			type: v.type,
			containerKind: info.containerKind,
			elementType: info.elementType,
			bytesPerElement: info.bytesPerElement,
			sizeHint,
		};
		this.pinned.push(pinned);

		await this.readSignalBytes(pinned);
		this.refresh();
		this._onDidUpdatePinned.fire(this.pinned);
		return pinned;
	}

	/** 通过 id 移除单个 Pin */
	unpin(id: string): void {
		const i = this.pinned.findIndex(p => p.id === id);
		if (i >= 0) {
			this.pinned.splice(i, 1);
			this.refresh();
			this._onDidUpdatePinned.fire(this.pinned);
		}
	}

	/** 清空所有 Pin */
	clearAllPinned(): void {
		if (this.pinned.length === 0) return;
		this.pinned = [];
		this.refresh();
		this._onDidUpdatePinned.fire(this.pinned);
	}

	/** 刷新所有 Pin 的数据（断点命中或手动按钮触发） */
	async refreshAll(): Promise<void> {
		if (!this.debugSession) return;
		for (const p of this.pinned) {
			await this.readSignalBytes(p);
		}
		this.refresh();
		this._onDidUpdatePinned.fire(this.pinned);
	}

	setDebugSession(session: vscode.DebugSession) {
		this.debugSession = session;
		this.refresh();
	}

	clearDebugSession() {
		this.debugSession = undefined;
		this.lastStoppedThreadId = undefined;
		this.lastStoppedFrameId = undefined;
		// 保留 pinned 条目，但清掉数据
		for (const p of this.pinned) {
			p.lastData = undefined;
			p.lastError = 'No active debug session';
		}
		this.refresh();
		this._onDidUpdatePinned.fire(this.pinned);
	}

	// ====================================================================
	// 核心：字节读取与解码
	// ====================================================================

	/**
	 * 为单个 PinnedVariable 读取裸字节并解码，结果写回 p.lastData / p.lastError。
	 *
	 * 三种容器的 ptr 与 size 获取方式：
	 *   stl     ptr = evaluate(name._M_impl._M_start)
	 *           size = evaluate(name._M_impl._M_finish - name._M_impl._M_start)
	 *   array   ptr = evaluate(&(name[0]))
	 *           size = sizeHint（来自类型 [N]）
	 *   pointer ptr = evaluate(name)
	 *           size = sizeHint（用户输入）
	 *
	 * 拿到的 ptr 用 DAP readMemory 请求读 bytes；base64 解码后按 elementType 逐元素解析。
	 */
	private async readSignalBytes(p: PinnedVariable): Promise<void> {
		try {
			if (!this.debugSession) throw new Error('No active debug session');
			if (this.lastStoppedFrameId === undefined) throw new Error('No stopped frame; hit a breakpoint first');

			// ---- 1) 决定 ptr 表达式与 size ----
			let ptrExpr: string;
			let size: number;
			if (p.containerKind === 'stl') {
				ptrExpr = `${p.evaluateName}._M_impl._M_start`;
				const diffResp = await this.debugSession.customRequest('evaluate', {
					expression: `${p.evaluateName}._M_impl._M_finish - ${p.evaluateName}._M_impl._M_start`,
					context: 'watch',
					frameId: this.lastStoppedFrameId,
				});
				const m = typeof diffResp?.result === 'string' ? diffResp.result.match(/-?\d+/) : null;
				size = m ? parseInt(m[0], 10) : 0;
				if (size <= 0) throw new Error(`size via libstdc++ internals is invalid (got "${diffResp?.result}")`);
				console.log(`Radar Signal Visualizer: size via libstdc++ internals ${size}`);
			} else if (p.containerKind === 'array') {
				ptrExpr = `&(${p.evaluateName}[0])`;
				size = p.sizeHint ?? 0;
				if (size <= 0) throw new Error('array sizeHint missing');
			} else {
				ptrExpr = p.evaluateName;
				size = p.sizeHint ?? 0;
				if (size <= 0) throw new Error('pointer sizeHint missing');
			}

			// ---- 2) evaluate 拿 memoryReference ----
			const ptrResp = await this.debugSession.customRequest('evaluate', {
				expression: ptrExpr,
				context: 'watch',
				frameId: this.lastStoppedFrameId,
			});
			// 优先 DAP 标准字段 memoryReference，退化到从 result 里正则提取 0x... 串
			const memRef: string | undefined = ptrResp?.memoryReference ?? this.extractHex(ptrResp?.result);
			if (!memRef) throw new Error(`No memoryReference from "${ptrExpr}" (result="${ptrResp?.result}")`);

			// ---- 3) readMemory ----
			const count = size * p.bytesPerElement;
			const memResp = await this.debugSession.customRequest('readMemory', {
				memoryReference: memRef,
				count,
				offset: 0,
			});
			const b64: string = memResp?.data ?? '';
			console.log(`Radar Signal Visualizer: readMemory got ${b64.length} base64 chars (${count} bytes) for ${p.displayName}`);
			if (!b64) throw new Error('readMemory returned empty data');

			// ---- 4) base64 → DataView → number[] ----
			const buf = Buffer.from(b64, 'base64');
			const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
			const out: number[] = new Array(size);
			for (let i = 0; i < size; i++) {
				out[i] = this.decodeOne(view, i * p.bytesPerElement, p.elementType);
			}

			p.lastData = out;
			p.lastError = undefined;
			p.lastUpdatedMs = Date.now();
		} catch (error: any) {
			const msg = error?.message ?? String(error);
			p.lastError = msg;
			p.lastUpdatedMs = Date.now();
			console.error(`Radar Signal Visualizer: readSignalBytes failed for ${p.displayName}:`, error);
		}
	}

	/**
	 * 单个元素解码，小端 IEEE754 / two's complement。
	 * 复数类型返回幅度 sqrt(re^2 + im^2)。
	 */
	private decodeOne(view: DataView, off: number, et: string): number {
		switch (et) {
			case 'float':              return view.getFloat32(off, true);
			case 'double':             return view.getFloat64(off, true);
			case 'int':
			case 'int32_t':            return view.getInt32(off, true);
			case 'uint32_t':
			case 'unsigned int':       return view.getUint32(off, true);
			case 'short':
			case 'int16_t':            return view.getInt16(off, true);
			case 'uint16_t':
			case 'unsigned short':     return view.getUint16(off, true);
			case 'char':
			case 'signed char':
			case 'int8_t':             return view.getInt8(off);
			case 'uint8_t':
			case 'unsigned char':      return view.getUint8(off);
			case 'long':
			case 'long long':
			case 'int64_t':            return Number(view.getBigInt64(off, true));
			case 'unsigned long':
			case 'unsigned long long':
			case 'uint64_t':           return Number(view.getBigUint64(off, true));
			case 'cuFloatComplex':
			case 'std::complex<float>': {
				const re = view.getFloat32(off, true);
				const im = view.getFloat32(off + 4, true);
				return Math.sqrt(re * re + im * im);
			}
			case 'cuDoubleComplex':
			case 'std::complex<double>': {
				const re = view.getFloat64(off, true);
				const im = view.getFloat64(off + 8, true);
				return Math.sqrt(re * re + im * im);
			}
			default:
				throw new Error(`Unsupported element type: ${et}`);
		}
	}

	/**
	 * 从 C++ 类型文本推断容器种类/元素类型/元素字节数。
	 *   std::vector<float, ...>     → stl / float / 4
	 *   std::array<int32_t, 256>    → stl / int32_t / 4 / sizeHint=256（尖括号第二参数）
	 *   std::deque<double>          → stl / double / 8
	 *   float [256]                 → array / float / 4 / sizeHint=256
	 *   float*                      → pointer / float / 4
	 *   cuFloatComplex*             → pointer / cuFloatComplex / 8
	 */
	private inferTypeInfo(type: string): { containerKind: ContainerKind; elementType: string; bytesPerElement: number; sizeHint?: number } {
		const trimmed = type.trim();

		// STL: std::[__cxx11::]vector / array / deque <ElemType[, ...]>
		const stlMatch = trimmed.match(/std::(?:__\w+::)?(?:vector|array|deque)\s*<\s*([^,>]+?)\s*(?:,\s*(\d+)\s*>|[,>])/);
		if (stlMatch) {
			const et = this.normalizeElementType(stlMatch[1]);
			const bpe = BYTES_PER_ELEMENT[et];
			if (bpe === undefined) throw new Error(`Unsupported element type "${et}" in STL container`);
			const out: { containerKind: ContainerKind; elementType: string; bytesPerElement: number; sizeHint?: number } = {
				containerKind: 'stl', elementType: et, bytesPerElement: bpe,
			};
			// std::array<T, N> 第二模板参数是静态 size；不是必须，仅作 hint
			if (stlMatch[2]) out.sizeHint = parseInt(stlMatch[2], 10);
			return out;
		}

		// 原生数组 T[N] / T [N]
		const arrMatch = trimmed.match(/^(.+?)\s*\[\s*(\d+)\s*\]\s*$/);
		if (arrMatch) {
			const et = this.normalizeElementType(arrMatch[1]);
			const bpe = BYTES_PER_ELEMENT[et];
			if (bpe === undefined) throw new Error(`Unsupported element type "${et}" in native array`);
			return { containerKind: 'array', elementType: et, bytesPerElement: bpe, sizeHint: parseInt(arrMatch[2], 10) };
		}

		// 指针 T *
		const ptrMatch = trimmed.match(/^(.+?)\s*\*\s*$/);
		if (ptrMatch) {
			const et = this.normalizeElementType(ptrMatch[1]);
			const bpe = BYTES_PER_ELEMENT[et];
			if (bpe === undefined) throw new Error(`Unsupported element type "${et}" in pointer`);
			return { containerKind: 'pointer', elementType: et, bytesPerElement: bpe };
		}

		throw new Error(`Cannot parse variable type: "${type}"`);
	}

	/** 去除 const/volatile/struct 等修饰，规范为 BYTES_PER_ELEMENT 的键 */
	private normalizeElementType(raw: string): string {
		return raw
			.replace(/\b(const|volatile|struct|class)\b/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	/** 从 "0x7fff12345678 <some_symbol>" 中抽出 0x 地址 */
	private extractHex(s: any): string | undefined {
		if (typeof s !== 'string') return undefined;
		const m = s.match(/0x[0-9a-fA-F]+/);
		return m ? m[0] : undefined;
	}

	// ====================================================================
	// 调试事件监听
	// ====================================================================

	private listenToDebugEvents() {
		vscode.debug.onDidChangeActiveDebugSession(session => {
			if (session) this.debugSession = session;
		});

		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker: (session: vscode.DebugSession) => ({
				onDidSendMessage: (message: any) => {
					if (message?.type === 'event' && message.event === 'stopped') {
						this.debugSession = session;
						const tid = message.body?.threadId;
						if (typeof tid === 'number') this.lastStoppedThreadId = tid;
						// 捕获 frameId 再按配置触发 refreshAll
						void this.captureFrameAndMaybeRefresh();
					} else if (message?.type === 'event' && message.event === 'continued') {
						this.lastStoppedThreadId = undefined;
						this.lastStoppedFrameId = undefined;
					}
				},
			}),
		});
	}

	/**
	 * stopped 之后补一次 stackTrace 拿 frameId，然后按配置决定是否刷新所有 Pin。
	 * 拆成独立方法是因为 stopped 回调本身是同步的，不能直接 await。
	 */
	private async captureFrameAndMaybeRefresh() {
		if (!this.debugSession) return;
		try {
			let tid = this.lastStoppedThreadId;
			if (tid === undefined) {
				const tr = await this.debugSession.customRequest('threads');
				tid = tr?.threads?.[0]?.id;
			}
			if (tid === undefined) return;
			const st = await this.debugSession.customRequest('stackTrace', { threadId: tid, startFrame: 0, levels: 1 });
			const fid = st?.stackFrames?.[0]?.id;
			if (typeof fid !== 'number') return;
			this.lastStoppedFrameId = fid;

			const cfg = vscode.workspace.getConfiguration('rsv');
			const auto = cfg.get<boolean>('refreshOnBreakpoint', true);
			if (auto && this.pinned.length > 0) {
				await this.refreshAll();
			}
		} catch (e) {
			console.error('Radar Signal Visualizer: captureFrameAndMaybeRefresh failed', e);
		}
	}

	// ====================================================================
	// TreeDataProvider 实现
	// ====================================================================

	private refresh() {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(p: PinnedVariable): vscode.TreeItem {
		const n = p.lastData?.length ?? p.sizeHint ?? '?';
		const item = new vscode.TreeItem(p.displayName, vscode.TreeItemCollapsibleState.None);
		item.description = `${p.elementType} × ${n}`;
		item.tooltip = p.lastError
			? `${p.evaluateName}\nType: ${p.type}\nError: ${p.lastError}`
			: `${p.evaluateName}\nType: ${p.type}`;
		item.contextValue = 'pinnedVariable';
		item.id = p.id;
		item.iconPath = new vscode.ThemeIcon(p.lastError ? 'warning' : 'graph-line');
		return item;
	}

	getChildren(element?: PinnedVariable): Thenable<PinnedVariable[]> {
		if (!element) return Promise.resolve(this.pinned);
		return Promise.resolve([]);
	}
}
