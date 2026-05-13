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
