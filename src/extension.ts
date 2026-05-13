/**
 * ======================================================================
 * extension.ts - 扩展入口（重构版本）
 * ======================================================================
 *
 * 新架构：
 *   • 用户在 VSCode Variables 面板右键变量 → rsv.pinVariable
 *   • 侧边栏 "Pinned Signals" 显示已 Pin 列表，item 右键 → rsv.unpinVariable
 *   • view/title 栏提供 refreshAllPinned / clearAllPinned 按钮
 *   • 断点命中时按 rsv.refreshOnBreakpoint 配置自动刷新
 *   • dataProvider.onDidUpdatePinned 触发 → 同步所有卡片到 webview
 *
 * 旧的 rsv.visualizeVariable / rsv.refreshSignals / 自动扫描逻辑已移除。
 * ======================================================================
 */

import * as vscode from 'vscode';
import { SignalDataProvider } from './dataProvider';
import { SignalVisualizerPanel } from './visualizerPanel';

let dataProvider: SignalDataProvider;

export function activate(context: vscode.ExtensionContext) {
	dataProvider = new SignalDataProvider();

	vscode.window.registerTreeDataProvider('rsvSignals', dataProvider);

	// --- 命令 1: 打开可视化面板 ---
	const openPanelCommand = vscode.commands.registerCommand('rsv.openPanel', () => {
		SignalVisualizerPanel.createOrShow(context.extensionUri, dataProvider);
	});

	// --- 命令 2: Pin 变量（来自 debug/variables/context 菜单） ---
	// VSCode 在触发此命令时会把 { variable, container, sessionId, frameId? } 作为 ctx 传入。
	const pinCommand = vscode.commands.registerCommand('rsv.pinVariable', async (ctx: any) => {
		const panel = SignalVisualizerPanel.currentPanel
			?? SignalVisualizerPanel.createOrShow(context.extensionUri, dataProvider);
		const pinned = await dataProvider.pinFromContext(ctx);
		if (pinned) {
			panel.syncAllCards(dataProvider.getPinned());
		}
	});

	// --- 命令 3: Unpin（来自 view/item/context）---
	// VSCode 把 TreeDataProvider 的 element（PinnedVariable）作为第一个参数传入。
	const unpinCommand = vscode.commands.registerCommand('rsv.unpinVariable', (arg: any) => {
		const id: string | undefined = arg?.id ?? arg?.pinnedId;
		if (!id) return;
		dataProvider.unpin(id);
		SignalVisualizerPanel.currentPanel?.removeCard(id);
	});

	// --- 命令 4: 手动刷新所有 Pin ---
	const refreshAllCommand = vscode.commands.registerCommand('rsv.refreshAllPinned', async () => {
		await dataProvider.refreshAll();
		SignalVisualizerPanel.currentPanel?.syncAllCards(dataProvider.getPinned());
	});

	// --- 命令 5: 清空所有 Pin ---
	const clearAllCommand = vscode.commands.registerCommand('rsv.clearAllPinned', () => {
		dataProvider.clearAllPinned();
		SignalVisualizerPanel.currentPanel?.clearAllCards();
	});

	context.subscriptions.push(
		openPanelCommand, pinCommand, unpinCommand, refreshAllCommand, clearAllCommand,
	);

	// --- 桥接 dataProvider → webview ---
	// 断点触发的自动刷新、pinFromContext 内的初次 fire 都会经过这里
	// （pinVariable 命令里已手动 syncAllCards，这里再保险一次不会重复渲染——webview 端按 id 幂等复用 DOM）。
	context.subscriptions.push(
		dataProvider.onDidUpdatePinned(pinned => {
			SignalVisualizerPanel.currentPanel?.syncAllCards(pinned);
		})
	);

	// --- 调试会话生命周期 ---
	vscode.debug.onDidChangeActiveDebugSession(session => {
		if (session) dataProvider.setDebugSession(session);
		else dataProvider.clearDebugSession();
	});

	vscode.debug.onDidStartDebugSession(() => {
		vscode.window.showInformationMessage('Debug session started');
	});

	vscode.debug.onDidTerminateDebugSession(() => {
		dataProvider.clearDebugSession();
	});
}

export function deactivate() {}
