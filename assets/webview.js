/**
 * ======================================================================
 * webview.js - 多卡片渲染逻辑（Chart + Table）
 * ======================================================================
 *
 * 消息协议（extension → webview）：
 *   { command: 'syncAllCards', cards: CardPayload[] }
 *   { command: 'updateCard',   card:  CardPayload }
 *   { command: 'removeCard',   id:    string }
 *   { command: 'clearAll' }
 *
 * CardPayload = { id, displayName, type, elementType, data:number[], error?, pageSize }
 *
 * 每个 Pin 对应一张卡片；同 id 的卡片刷新时复用 DOM，销毁旧 Chart 重建。
 * ======================================================================
 */

(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	/** @type {Map<string, { root:HTMLElement, canvas:HTMLCanvasElement, chart:any, data:number[], tableRendered:number, pageSize:number, activeTab:'chart'|'table' }>} */
	const cards = new Map();

	const root = document.getElementById('cards-root');
	const emptyHint = document.getElementById('empty-hint');

	// 通知 extension 可以开始推送
	vscode.postMessage({ command: 'ready' });

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.command) {
			case 'syncAllCards': handleSyncAllCards(msg.cards || []); break;
			case 'updateCard':   handleUpdateCard(msg.card); break;
			case 'removeCard':   handleRemoveCard(msg.id); break;
			case 'clearAll':     handleClearAll(); break;
		}
	});

	// ================================================================
	// 消息处理
	// ================================================================

	function handleSyncAllCards(payloads) {
		const incoming = new Set(payloads.map(c => c.id));
		// 删除不在新集合里的卡片
		for (const id of Array.from(cards.keys())) {
			if (!incoming.has(id)) removeCard(id);
		}
		// 按顺序渲染/复用
		for (const p of payloads) renderCard(p);
		// 确保 DOM 顺序与 payloads 一致
		reorderCards(payloads.map(p => p.id));
		updateEmptyHint();
	}

	function handleUpdateCard(card) {
		if (!card) return;
		renderCard(card);
		updateEmptyHint();
	}

	function handleRemoveCard(id) {
		removeCard(id);
		updateEmptyHint();
	}

	function handleClearAll() {
		for (const id of Array.from(cards.keys())) removeCard(id);
		updateEmptyHint();
	}

	// ================================================================
	// 卡片渲染
	// ================================================================

	function renderCard(payload) {
		let entry = cards.get(payload.id);
		if (!entry) {
			entry = createCardDom(payload);
			cards.set(payload.id, entry);
			root.appendChild(entry.root);
		}

		// 更新 header 文案
		entry.root.querySelector('.card-title').textContent = payload.displayName;
		const n = (payload.data && payload.data.length) || 0;
		const metaEl = entry.root.querySelector('.card-meta');
		if (payload.error) {
			metaEl.textContent = `${payload.type}  —  ERROR`;
			metaEl.classList.add('error');
		} else {
			metaEl.textContent = `${payload.type}   ${payload.elementType} × ${n}${buildStatsText(payload.data)}`;
			metaEl.classList.remove('error');
		}

		// 更新 body
		const errorBody = entry.root.querySelector('.error-body');
		const chartBody = entry.root.querySelector('.chart-body');
		const tableBody = entry.root.querySelector('.table-body');

		if (payload.error) {
			errorBody.textContent = payload.error;
			errorBody.style.display = 'block';
			chartBody.style.display = 'none';
			tableBody.style.display = 'none';
			if (entry.chart) { entry.chart.destroy(); entry.chart = null; }
			entry.data = [];
			entry.tableRendered = 0;
			clearTableDom(tableBody);
			return;
		}

		errorBody.style.display = 'none';
		// 确保 active tab 可见
		applyTabVisibility(entry);

		entry.data = payload.data || [];
		entry.pageSize = payload.pageSize || 200;
		entry.tableRendered = 0;

		// Chart 重绘
		if (entry.chart) { entry.chart.destroy(); entry.chart = null; }
		entry.chart = createChart(entry.canvas, entry.data);

		// Table 懒渲染：仅当当前激活 tab 是 table 时立即渲染
		clearTableDom(tableBody);
		if (entry.activeTab === 'table') {
			renderTablePage(entry);
		}
	}

	function createCardDom(payload) {
		const el = document.createElement('div');
		el.className = 'card';
		el.dataset.id = payload.id;
		el.innerHTML = `
			<div class="card-header">
				<div class="card-title"></div>
				<div class="card-meta"></div>
				<div class="card-tabs">
					<button class="tab-btn active" data-tab="chart">Chart</button>
					<button class="tab-btn" data-tab="table">Table</button>
				</div>
			</div>
			<div class="card-body">
				<div class="error-body" style="display:none"></div>
				<div class="tab-body chart-body"><canvas></canvas></div>
				<div class="tab-body table-body" style="display:none">
					<table class="data-table">
						<thead><tr><th class="col-idx">Index</th><th>Value</th></tr></thead>
						<tbody></tbody>
					</table>
					<button class="show-more-btn" style="display:none">Show more</button>
				</div>
			</div>
		`;

		const canvas = el.querySelector('canvas');
		const entry = {
			root: el,
			canvas,
			chart: null,
			data: [],
			tableRendered: 0,
			pageSize: payload.pageSize || 200,
			activeTab: 'chart',
		};

		// tab 切换
		el.querySelectorAll('.tab-btn').forEach(btn => {
			btn.addEventListener('click', () => switchTab(entry, btn.dataset.tab));
		});

		// show more
		el.querySelector('.show-more-btn').addEventListener('click', () => renderTablePage(entry));

		return entry;
	}

	function switchTab(entry, tab) {
		if (entry.activeTab === tab) return;
		entry.activeTab = tab;
		entry.root.querySelectorAll('.tab-btn').forEach(btn => {
			btn.classList.toggle('active', btn.dataset.tab === tab);
		});
		applyTabVisibility(entry);
		// 懒渲染 Table
		if (tab === 'table' && entry.tableRendered === 0 && entry.data.length > 0) {
			renderTablePage(entry);
		}
	}

	function applyTabVisibility(entry) {
		const chartBody = entry.root.querySelector('.chart-body');
		const tableBody = entry.root.querySelector('.table-body');
		chartBody.style.display = entry.activeTab === 'chart' ? 'block' : 'none';
		tableBody.style.display = entry.activeTab === 'table' ? 'block' : 'none';
	}

	function removeCard(id) {
		const entry = cards.get(id);
		if (!entry) return;
		if (entry.chart) { entry.chart.destroy(); entry.chart = null; }
		entry.root.remove();
		cards.delete(id);
	}

	function reorderCards(orderedIds) {
		for (const id of orderedIds) {
			const entry = cards.get(id);
			if (entry && entry.root.parentElement === root) {
				root.appendChild(entry.root); // appendChild 已存在节点会移到末尾
			}
		}
	}

	function updateEmptyHint() {
		emptyHint.style.display = cards.size === 0 ? 'block' : 'none';
	}

	// ================================================================
	// Chart 创建
	// ================================================================

	function createChart(canvas, data) {
		const labels = data.map((_, i) => i);
		return new Chart(canvas.getContext('2d'), {
			type: 'line',
			data: {
				labels,
				datasets: [{
					data,
					borderColor: 'rgba(80, 160, 255, 1)',
					backgroundColor: 'rgba(80, 160, 255, 0.1)',
					borderWidth: 1.5,
					pointRadius: 0,
					tension: 0.0,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: {
					legend: { display: false },
					tooltip: { mode: 'index', intersect: false },
				},
				scales: {
					x: { ticks: { maxTicksLimit: 12 }, grid: { color: 'rgba(255,255,255,0.06)' } },
					y: { grid: { color: 'rgba(255,255,255,0.06)' } },
				},
			},
		});
	}

	// ================================================================
	// Table 分页渲染
	// ================================================================

	function clearTableDom(tableBody) {
		const tbody = tableBody.querySelector('tbody');
		if (tbody) tbody.innerHTML = '';
		const btn = tableBody.querySelector('.show-more-btn');
		if (btn) btn.style.display = 'none';
	}

	function renderTablePage(entry) {
		const tableBody = entry.root.querySelector('.table-body');
		const tbody = tableBody.querySelector('tbody');
		const btn = tableBody.querySelector('.show-more-btn');
		const start = entry.tableRendered;
		const end = Math.min(start + entry.pageSize, entry.data.length);

		const frag = document.createDocumentFragment();
		for (let i = start; i < end; i++) {
			const tr = document.createElement('tr');
			const td1 = document.createElement('td');
			td1.className = 'col-idx';
			td1.textContent = String(i);
			const td2 = document.createElement('td');
			td2.textContent = formatNumber(entry.data[i]);
			tr.appendChild(td1);
			tr.appendChild(td2);
			frag.appendChild(tr);
		}
		tbody.appendChild(frag);
		entry.tableRendered = end;

		if (end < entry.data.length) {
			btn.style.display = 'inline-block';
			btn.textContent = `Show more (${end} / ${entry.data.length})`;
		} else {
			btn.style.display = 'none';
		}
	}

	// ================================================================
	// 工具
	// ================================================================

	function buildStatsText(data) {
		if (!data || data.length === 0) return '';
		let mn = Infinity, mx = -Infinity, sum = 0;
		for (let i = 0; i < data.length; i++) {
			const v = data[i];
			if (v < mn) mn = v;
			if (v > mx) mx = v;
			sum += v;
		}
		const mean = sum / data.length;
		return `   min=${formatNumber(mn)} max=${formatNumber(mx)} mean=${formatNumber(mean)}`;
	}

	function formatNumber(v) {
		if (!Number.isFinite(v)) return String(v);
		if (v === 0) return '0';
		const abs = Math.abs(v);
		if (abs >= 1e4 || abs < 1e-3) return v.toExponential(4);
		return v.toFixed(4);
	}
}());
