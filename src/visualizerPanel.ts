/**
 * ======================================================================
 * visualizerPanel.ts - 可视化面板（多卡片版本）
 * ======================================================================
 *
 * 单例 WebviewPanel。数据流改为：
 *   extension → webview 的 4 种消息
 *     - syncAllCards  全量同步，webview 端按 id diff 增/删/更新
 *     - updateCard    单卡片刷新
 *     - removeCard    删除单卡片
 *     - clearAll      清空所有卡片
 *   webview → extension 仅有 ready 消息，用于握手后触发初次同步。
 * ======================================================================
 */

import * as vscode from 'vscode';
import { SignalDataProvider } from './dataProvider';
import { PinnedVariable, CardPayload } from './types';

export class SignalVisualizerPanel {
	public static currentPanel: SignalVisualizerPanel | undefined;
	public static readonly viewType = 'radarSignalVisualizer';

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];
	private dataProvider: SignalDataProvider;
	/** webview 是否已发来 ready 消息；未 ready 时所有 post 暂存 */
	private ready = false;

	public static createOrShow(extensionUri: vscode.Uri, dataProvider: SignalDataProvider): SignalVisualizerPanel {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (SignalVisualizerPanel.currentPanel) {
			SignalVisualizerPanel.currentPanel._panel.reveal(column);
			return SignalVisualizerPanel.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			SignalVisualizerPanel.viewType,
			'Radar Signal Visualizer',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
			},
		);

		SignalVisualizerPanel.currentPanel = new SignalVisualizerPanel(panel, extensionUri, dataProvider);
		return SignalVisualizerPanel.currentPanel;
	}

	private constructor(panel: vscode.WebviewPanel, private readonly _extensionUri: vscode.Uri, dataProvider: SignalDataProvider) {
		this._panel = panel;
		this.dataProvider = dataProvider;

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(message => {
			if (message?.command === 'ready') {
				this.ready = true;
				// 握手后把已有的 pin 同步一次
				this.syncAllCards(this.dataProvider.getPinned());
			} else if (message?.command === 'exportBin') {
				this.handleExportBin(message.id, message.length);
			}
		}, null, this._disposables);

		this.update();
	}

	// ================================================================
	// 对外消息协议
	// ================================================================

	public syncAllCards(pinned: PinnedVariable[]) {
		const cards = pinned.map(p => this.toCardPayload(p));
		this.post({ command: 'syncAllCards', cards });
	}

	public updateCard(p: PinnedVariable) {
		this.post({ command: 'updateCard', card: this.toCardPayload(p) });
	}

	public removeCard(id: string) {
		this.post({ command: 'removeCard', id });
	}

	public clearAllCards() {
		this.post({ command: 'clearAll' });
	}

	// ================================================================
	// 内部工具
	// ================================================================

	private toCardPayload(p: PinnedVariable): CardPayload {
		const cfg = vscode.workspace.getConfiguration('rsv');
		const pageSize = cfg.get<number>('tablePageSize', 200);
		return {
			id: p.id,
			displayName: p.displayName,
			type: p.type,
			elementType: p.elementType,
			isComplex: p.isComplex,
			data: p.lastData ?? [],
			dataIm: p.lastDataIm,
			error: p.lastError,
			pageSize,
		};
	}

	private post(message: any) {
		// webview 未 ready 时也调 postMessage —— VSCode 会缓冲到 ready 为止。
		// 显式 ready 标志仅用于第一次 syncAllCards 时机控制。
		this._panel.webview.postMessage(message);
	}

	// ================================================================
	// 导出为 .bin：根据 elementType 以原始裸字节写入（无 header）
	// 复数交错 (re,im,re,im,...)，little-endian。
	// numpy: np.fromfile(path, dtype='<f4'/'<f8'/'<c8'/'<c16'/...)
	// ================================================================

	private async handleExportBin(id: string, length: number) {
		const v = this.dataProvider.getPinned().find(p => p.id === id);
		if (!v) {
			vscode.window.showWarningMessage('Export failed: variable not found.');
			return;
		}
		if (!v.lastData || v.lastData.length === 0) {
			vscode.window.showWarningMessage(`Export failed: "${v.displayName}" has no data.`);
			return;
		}
		const total = v.lastData.length;
		let eff = Math.max(1, Math.min(length || total, total));
		const re = v.lastData.slice(0, eff);
		const im = v.lastDataIm ? v.lastDataIm.slice(0, eff) : undefined;

		const safeName = sanitizeFileName(v.displayName);
		const safeType = sanitizeFileName(v.elementType);
		const defaultFileName = `${safeName}_${safeType}_${eff}.bin`;
		const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
		const defaultUri = wsFolder
			? vscode.Uri.joinPath(wsFolder, defaultFileName)
			: vscode.Uri.file(defaultFileName);

		const target = await vscode.window.showSaveDialog({
			defaultUri,
			filters: { 'Binary': ['bin'], 'All Files': ['*'] },
			saveLabel: 'Export',
			title: `Export ${v.displayName} (${v.elementType} × ${eff}) to .bin`,
		});
		if (!target) return; // 用户取消

		try {
			const bytes = serializeToBin(v.elementType, v.isComplex, re, im);
			await vscode.workspace.fs.writeFile(target, bytes);
			vscode.window.showInformationMessage(
				`Exported ${eff} elements (${v.elementType}${v.isComplex ? ', interleaved I/Q' : ''}) → ${target.fsPath}`
			);
		} catch (err: any) {
			vscode.window.showErrorMessage(`Export failed: ${err?.message ?? String(err)}`);
		}
	}

	public update() {
		const webview = this._panel.webview;
		this._panel.title = 'Radar Signal Visualizer';
		this._panel.webview.html = this._getHtmlForWebview(webview);
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'webview.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'webview.css'));
		const chartUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'assets', 'chart.umd.min.js'));
		const nonce = getNonce();

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
						<div class="hint">Right-click any variable in the Variables panel and choose "Pin to Radar Signal Visualizer".</div>
					</div>
					<div id="cards-root" class="cards-root"></div>
					<div id="empty-hint" class="empty-hint">No pinned variables yet.</div>
				</div>
				<script src="${chartUri}" nonce="${nonce}"></script>
				<script src="${scriptUri}" nonce="${nonce}"></script>
			</body>
			</html>`;
	}

	public dispose() {
		SignalVisualizerPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const d = this._disposables.pop();
			if (d) d.dispose();
		}
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * 文件名 sanitize：去掉 Windows 不允许的字符 + 空格 + std::xxx 中的冒号
 * 仅限底线，保留字母数字下划线点号。
 */
function sanitizeFileName(s: string): string {
	return s.replace(/[<>:"/\\|?*\s]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * 按 elementType 将 number[] 序列化为裸字节。
 *
 *  实数：只用 re；复数：交错写 (re,im,re,im,...)
 *  输出 little-endian，无 header，numpy / MATLAB 可直接 fromfile 读取。
 */
function serializeToBin(et: string, isComplex: boolean, re: number[], im?: number[]): Uint8Array {
	const N = re.length;
	if (isComplex) {
		const im2 = im ?? new Array(N).fill(0);
		switch (et) {
			case 'cuFloatComplex':
			case 'std::complex<float>':
			case 'float2': {
				const buf = new ArrayBuffer(N * 8);
				const v = new DataView(buf);
				for (let i = 0; i < N; i++) {
					v.setFloat32(i * 8,     re[i],  true);
					v.setFloat32(i * 8 + 4, im2[i], true);
				}
				return new Uint8Array(buf);
			}
			case 'cuDoubleComplex':
			case 'std::complex<double>':
			case 'double2': {
				const buf = new ArrayBuffer(N * 16);
				const v = new DataView(buf);
				for (let i = 0; i < N; i++) {
					v.setFloat64(i * 16,     re[i],  true);
					v.setFloat64(i * 16 + 8, im2[i], true);
				}
				return new Uint8Array(buf);
			}
			default:
				throw new Error(`Unsupported complex elementType for export: "${et}"`);
		}
	}
	// 实数
	switch (et) {
		case 'float': {
			const arr = new Float32Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i];
			return new Uint8Array(arr.buffer);
		}
		case 'double': {
			const arr = new Float64Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i];
			return new Uint8Array(arr.buffer);
		}
		case 'int':
		case 'int32_t': {
			const arr = new Int32Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i] | 0;
			return new Uint8Array(arr.buffer);
		}
		case 'uint32_t':
		case 'unsigned int': {
			const arr = new Uint32Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i] >>> 0;
			return new Uint8Array(arr.buffer);
		}
		case 'short':
		case 'int16_t': {
			const arr = new Int16Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i];
			return new Uint8Array(arr.buffer);
		}
		case 'uint16_t':
		case 'unsigned short': {
			const arr = new Uint16Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i];
			return new Uint8Array(arr.buffer);
		}
		case 'char':
		case 'int8_t':
		case 'signed char': {
			const arr = new Int8Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i];
			return new Uint8Array(arr.buffer);
		}
		case 'uint8_t':
		case 'unsigned char': {
			const arr = new Uint8Array(N);
			for (let i = 0; i < N; i++) arr[i] = re[i];
			return arr;
		}
		case 'long':
		case 'int64_t':
		case 'long long': {
			// JS Number 仅能精确表达 53-bit 内整数；dataProvider 读出时已是 number，
			// 这里仅作能达范围内的反向错输出。
			const arr = new BigInt64Array(N);
			for (let i = 0; i < N; i++) arr[i] = BigInt(Math.trunc(re[i]));
			return new Uint8Array(arr.buffer);
		}
		case 'unsigned long':
		case 'uint64_t':
		case 'unsigned long long': {
			const arr = new BigUint64Array(N);
			for (let i = 0; i < N; i++) {
				const x = Math.trunc(re[i]);
				arr[i] = x < 0 ? 0n : BigInt(x);
			}
			return new Uint8Array(arr.buffer);
		}
		default:
			throw new Error(`Unsupported elementType for export: "${et}"`);
	}
}
