/**
 * ======================================================================
 * webview.js - 多卡片渲染（左 Table / 右 Chart 并排 + Plot Kind Registry）
 * ======================================================================
 *
 * 消息协议（extension → webview）：
 *   { command: 'syncAllCards', cards: CardPayload[] }
 *   { command: 'updateCard',   card:  CardPayload }
 *   { command: 'removeCard',   id:    string }
 *   { command: 'clearAll' }
 *
 * CardPayload = {
 *   id, displayName, type, elementType,
 *   isComplex: boolean,
 *   data: number[],     // 实数：值；复数：实部 re
 *   dataIm?: number[],  // 复数：虚部 im
 *   error?, pageSize
 * }
 *
 * UI 结构（每张卡片）：
 *   Header: title + meta（含 element type / 长度 / 简单统计）
 *   Body 左右两栏：
 *     ├─ Table 侧（左）：实数 [Index|Value]；复数 [Index|I|Q]；分页 + Show more
 *     └─ Chart 侧（右）：Plot type 下拉 + canvas / placeholder
 *   两侧始终同时显示——符合 "先看数据再看图" 的视觉流向。
 *
 * ----------------------------------------------------------------------
 * PLOT_KINDS 绘图类型注册表
 * ----------------------------------------------------------------------
 * 每项接口：
 *   {
 *     label: string,
 *     available(ctx): boolean,
 *       ctx = { isComplex, length, elementType }
 *     render(canvas, ctx): Chart | null,
 *       ctx 同上 + { data:number[], dataIm?:number[] }
 *   }
 *
 * 新增绘图类型的步骤：
 *   1) 在 PLOT_KINDS 追加一项；
 *   2) available 决定该类型对当前数据是否可选；
 *   3) render 返回 Chart 实例或 null；
 *   4) 若需要新数据维度（如二维谱图），同步在 extension 侧
 *      （types.ts CardPayload + dataProvider 解码）补字段，
 *      并在 ctx 透传到这里。
 * ======================================================================
 */

(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	const COLOR_REAL = 'rgba(80, 160, 255, 1)';
	const COLOR_REAL_BG = 'rgba(80, 160, 255, 0.10)';
	const COLOR_IMAG = 'rgba(255, 120, 80, 1)';
	const COLOR_IMAG_BG = 'rgba(255, 120, 80, 0.10)';

	// ================================================================
	// Plot Kind Registry
	// ================================================================

	const PLOT_KINDS = {
		// 实数模值 / 简单折线
		'magnitude': {
			label: 'Magnitude (line)',
			available: (ctx) => !ctx.isComplex,
			render(canvas, ctx) {
				return createLineChart(canvas, [
					{ data: ctx.data, label: 'value', color: COLOR_REAL, bg: COLOR_REAL_BG },
				]);
			},
		},
		// 复数模值 |z| = sqrt(re^2 + im^2)
		'complex-magnitude': {
			label: 'Complex |z|',
			available: (ctx) => ctx.isComplex,
			render(canvas, ctx) {
				const re = ctx.data, im = ctx.dataIm || [];
				const mag = new Array(re.length);
				for (let i = 0; i < re.length; i++) {
					const r = re[i], q = im[i] || 0;
					mag[i] = Math.sqrt(r * r + q * q);
				}
				return createLineChart(canvas, [
					{ data: mag, label: '|z|', color: COLOR_REAL, bg: COLOR_REAL_BG },
				]);
			},
		},
		// 复数 I/Q 双线
		'complex-iq': {
			label: 'Complex I/Q',
			available: (ctx) => ctx.isComplex,
			render(canvas, ctx) {
				return createLineChart(canvas, [
					{ data: ctx.data,           label: 'I (real)', color: COLOR_REAL, bg: COLOR_REAL_BG },
					{ data: ctx.dataIm || [],   label: 'Q (imag)', color: COLOR_IMAG, bg: COLOR_IMAG_BG },
				]);
			},
		},
		// 占位：未来 STFT/谱图等
		'spectrogram-2d': {
			label: '2D Time-Frequency (coming soon)',
			available: () => false,
			render() { return null; },
		},
	};

	/** 根据数据上下文挑默认 plot kind */
	function pickDefaultPlotKind(isComplex) {
		return isComplex ? 'complex-iq' : 'magnitude';
	}

	/** @type {Map<string, CardEntry>} */
	const cards = new Map();

	const root = document.getElementById('cards-root');
	const emptyHint = document.getElementById('empty-hint');

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
		for (const id of Array.from(cards.keys())) {
			if (!incoming.has(id)) removeCard(id);
		}
		for (const p of payloads) renderCard(p);
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

		// header
		entry.root.querySelector('.card-title').textContent = payload.displayName;
		const n = (payload.data && payload.data.length) || 0;
		const metaEl = entry.root.querySelector('.card-meta');
		if (payload.error) {
			metaEl.textContent = `${payload.type}  —  ERROR`;
			metaEl.classList.add('error');
		} else {
			const tag = payload.isComplex ? ' [complex]' : '';
			metaEl.textContent = `${payload.type}   ${payload.elementType}${tag} × ${n}${buildStatsText(payload)}`;
			metaEl.classList.remove('error');
		}

		const errorBody = entry.root.querySelector('.error-body');
		const tableSide = entry.root.querySelector('.table-side');
		const chartSide = entry.root.querySelector('.chart-side');

		if (payload.error) {
			errorBody.textContent = payload.error;
			errorBody.style.display = 'block';
			tableSide.style.display = 'none';
			chartSide.style.display = 'none';
			if (entry.chart) { entry.chart.destroy(); entry.chart = null; }
			entry.data = [];
			entry.dataIm = undefined;
			entry.tableRendered = 0;
			clearTableDom(tableSide);
			return;
		}
		errorBody.style.display = 'none';
		tableSide.style.display = '';
		chartSide.style.display = '';

		// 数据
		const prevIsComplex = entry.isComplex;
		entry.data = payload.data || [];
		entry.dataIm = payload.dataIm;
		entry.pageSize = payload.pageSize || 200;
		entry.elementType = payload.elementType;
		entry.isComplex = !!payload.isComplex;

		// isComplex 切换（极少见，但 pin 后类型不会变；保险处理）
		// → 重建下拉 + 重置 plotKind
		if (prevIsComplex !== entry.isComplex) {
			rebuildPlotKindSelect(entry);
		}

		// Table：表头按 isComplex 切换 + 重置分页
		rebuildTableHeader(entry);
		entry.tableRendered = 0;
		clearTableDom(tableSide);
		renderTablePage(entry);

		// Chart：始终重绘
		if (entry.chart) { entry.chart.destroy(); entry.chart = null; }
		buildOrRebuildChart(entry);
	}

	function createCardDom(payload) {
		const isComplex = !!payload.isComplex;
		const el = document.createElement('div');
		el.className = 'card';
		el.dataset.id = payload.id;
		el.innerHTML = `
			<div class="card-header">
				<div class="card-title"></div>
				<div class="card-meta"></div>
			</div>
			<div class="card-body">
				<div class="error-body" style="display:none"></div>
				<div class="table-side">
					<div class="side-title">Table</div>
					<table class="data-table">
						<thead></thead>
						<tbody></tbody>
					</table>
					<button class="show-more-btn" style="display:none">Show more</button>
				</div>
				<div class="chart-side">
					<div class="plot-controls">
						<label class="plot-kind-label">Plot type:</label>
						<select class="plot-kind-select"></select>
					</div>
					<div class="plot-area">
						<canvas></canvas>
						<div class="plot-placeholder" style="display:none"></div>
					</div>
				</div>
			</div>
		`;

		const canvas = el.querySelector('canvas');
		const select = el.querySelector('.plot-kind-select');
		const entry = {
			root: el,
			canvas,
			select,
			chart: null,
			data: [],
			dataIm: undefined,
			tableRendered: 0,
			pageSize: payload.pageSize || 200,
			plotKind: pickDefaultPlotKind(isComplex),
			elementType: payload.elementType || '',
			isComplex,
		};

		// 初始化下拉与表头
		rebuildPlotKindSelect(entry);
		rebuildTableHeader(entry);

		select.addEventListener('change', () => onPlotKindChange(entry, select.value));
		el.querySelector('.show-more-btn').addEventListener('click', () => renderTablePage(entry));

		return entry;
	}

	function rebuildPlotKindSelect(entry) {
		const ctx = { isComplex: entry.isComplex, length: entry.data.length, elementType: entry.elementType };
		entry.select.innerHTML = Object.entries(PLOT_KINDS).map(([key, spec]) => {
			const ok = !!spec.available(ctx);
			return `<option value="${key}"${ok ? '' : ' disabled'}>${escapeHtml(spec.label)}</option>`;
		}).join('');
		// 默认 plot kind 必须可用，否则回退到第一个可用项
		const defaultKind = pickDefaultPlotKind(entry.isComplex);
		const defaultSpec = PLOT_KINDS[defaultKind];
		if (defaultSpec && defaultSpec.available(ctx)) {
			entry.plotKind = defaultKind;
		} else {
			const firstAvail = Object.entries(PLOT_KINDS).find(([, s]) => s.available(ctx));
			entry.plotKind = firstAvail ? firstAvail[0] : defaultKind;
		}
		entry.select.value = entry.plotKind;
	}

	function rebuildTableHeader(entry) {
		const thead = entry.root.querySelector('.data-table thead');
		thead.innerHTML = entry.isComplex
			? `<tr><th class="col-idx">Index</th><th>I (real)</th><th>Q (imag)</th></tr>`
			: `<tr><th class="col-idx">Index</th><th>Value</th></tr>`;
	}

	function onPlotKindChange(entry, kind) {
		entry.plotKind = kind;
		buildOrRebuildChart(entry);
	}

	/**
	 * 根据当前 plotKind 重建 Chart。
	 * 不可用 / render 返回 null → 显示 placeholder。
	 */
	function buildOrRebuildChart(entry) {
		if (entry.chart) { entry.chart.destroy(); entry.chart = null; }

		const spec = PLOT_KINDS[entry.plotKind];
		const placeholder = entry.root.querySelector('.plot-placeholder');
		const canvas = entry.canvas;

		const ctx = {
			isComplex: entry.isComplex,
			length: entry.data.length,
			elementType: entry.elementType,
			data: entry.data,
			dataIm: entry.dataIm,
		};

		if (!spec) {
			showPlaceholder(canvas, placeholder, 'Unknown plot kind');
			return;
		}
		if (entry.data.length === 0) {
			showPlaceholder(canvas, placeholder, 'No data');
			return;
		}
		if (!spec.available(ctx)) {
			showPlaceholder(canvas, placeholder, 'Not available for this data');
			return;
		}

		const chart = spec.render(canvas, ctx);
		if (!chart) {
			showPlaceholder(canvas, placeholder, 'Not implemented yet');
			return;
		}

		canvas.style.display = 'block';
		placeholder.style.display = 'none';
		entry.chart = chart;
	}

	function showPlaceholder(canvas, placeholder, text) {
		canvas.style.display = 'none';
		placeholder.style.display = 'flex';
		placeholder.textContent = text;
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
				root.appendChild(entry.root);
			}
		}
	}

	function updateEmptyHint() {
		emptyHint.style.display = cards.size === 0 ? 'block' : 'none';
	}

	// ================================================================
	// Chart 实现：通用多 dataset 折线图
	// ================================================================

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {Array<{data:number[], label:string, color:string, bg:string}>} series
	 */
	function createLineChart(canvas, series) {
		const len = series[0]?.data?.length ?? 0;
		const labels = new Array(len);
		for (let i = 0; i < len; i++) labels[i] = i;
		const datasets = series.map(s => ({
			label: s.label,
			data: s.data,
			borderColor: s.color,
			backgroundColor: s.bg,
			borderWidth: 1.5,
			pointRadius: 0,
			tension: 0.0,
		}));
		return new Chart(canvas.getContext('2d'), {
			type: 'line',
			data: { labels, datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: {
					legend: { display: datasets.length > 1, position: 'top' },
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

	function clearTableDom(tableSide) {
		const tbody = tableSide.querySelector('tbody');
		if (tbody) tbody.innerHTML = '';
		const btn = tableSide.querySelector('.show-more-btn');
		if (btn) btn.style.display = 'none';
	}

	function renderTablePage(entry) {
		const tableSide = entry.root.querySelector('.table-side');
		const tbody = tableSide.querySelector('tbody');
		const btn = tableSide.querySelector('.show-more-btn');
		const start = entry.tableRendered;
		const end = Math.min(start + entry.pageSize, entry.data.length);

		const frag = document.createDocumentFragment();
		const isCx = entry.isComplex;
		for (let i = start; i < end; i++) {
			const tr = document.createElement('tr');
			const tdIdx = document.createElement('td');
			tdIdx.className = 'col-idx';
			tdIdx.textContent = String(i);
			tr.appendChild(tdIdx);
			if (isCx) {
				const tdRe = document.createElement('td');
				tdRe.textContent = formatNumber(entry.data[i]);
				const tdIm = document.createElement('td');
				tdIm.textContent = formatNumber((entry.dataIm || [])[i]);
				tr.appendChild(tdRe);
				tr.appendChild(tdIm);
			} else {
				const td = document.createElement('td');
				td.textContent = formatNumber(entry.data[i]);
				tr.appendChild(td);
			}
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

	/**
	 * meta 行简单统计：
	 *   实数：min / max / mean
	 *   复数：|z| 的 min / max / mean
	 */
	function buildStatsText(payload) {
		const re = payload.data;
		if (!re || re.length === 0) return '';
		const im = payload.dataIm;
		let mn = Infinity, mx = -Infinity, sum = 0;
		if (payload.isComplex && im) {
			for (let i = 0; i < re.length; i++) {
				const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
				if (m < mn) mn = m;
				if (m > mx) mx = m;
				sum += m;
			}
			const mean = sum / re.length;
			return `   |z| min=${formatNumber(mn)} max=${formatNumber(mx)} mean=${formatNumber(mean)}`;
		}
		for (let i = 0; i < re.length; i++) {
			const v = re[i];
			if (v < mn) mn = v;
			if (v > mx) mx = v;
			sum += v;
		}
		const mean = sum / re.length;
		return `   min=${formatNumber(mn)} max=${formatNumber(mx)} mean=${formatNumber(mean)}`;
	}

	function formatNumber(v) {
		if (v === undefined || v === null) return '';
		if (!Number.isFinite(v)) return String(v);
		if (v === 0) return '0';
		const abs = Math.abs(v);
		if (abs >= 1e4 || abs < 1e-3) return v.toExponential(4);
		return v.toFixed(4);
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
}());
