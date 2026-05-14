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

	// dB 计算下限：|x| < EPS_AMP 或 power < EPS_PWR 时钙住，避免 log10(0) 产生 -Infinity
	// EPS_AMP = 1e-12 → 幅值下限 -240 dB；EPS_PWR = EPS_AMP^2 = 1e-24
	const EPS_AMP = 1e-12;
	const EPS_PWR = 1e-24;

	// ================================================================
	// Plot Kind Registry
	// ================================================================

	const PLOT_KINDS = {
		'magnitude': {
			label: 'Magnitude (line)',
			available: (ctx) => !ctx.isComplex,
			render(ctx) {
				return createLineChart(ctx.canvases.main, [
					{ data: ctx.data, label: 'value', color: COLOR_REAL, bg: COLOR_REAL_BG },
				]);
			},
		},
		'magnitude-db': {
			label: 'Magnitude (dB)',
			available: (ctx) => !ctx.isComplex,
			render(ctx) {
				const src = ctx.data;
				const dB = new Array(src.length);
				for (let i = 0; i < src.length; i++) {
					const a = Math.abs(src[i]);
					dB[i] = 20 * Math.log10(a > EPS_AMP ? a : EPS_AMP);
				}
				return createLineChart(ctx.canvases.main, [
					{ data: dB, label: '|x| (dB)', color: COLOR_REAL, bg: COLOR_REAL_BG },
				]);
			},
		},
		'complex-magnitude': {
			label: 'Complex |z|',
			available: (ctx) => ctx.isComplex,
			render(ctx) {
				const re = ctx.data, im = ctx.dataIm || [];
				const mag = new Array(re.length);
				for (let i = 0; i < re.length; i++) {
					const r = re[i], q = im[i] || 0;
					mag[i] = Math.sqrt(r * r + q * q);
				}
				return createLineChart(ctx.canvases.main, [
					{ data: mag, label: '|z|', color: COLOR_REAL, bg: COLOR_REAL_BG },
				]);
			},
		},
		'complex-magnitude-db': {
			label: 'Complex |z| (dB)',
			available: (ctx) => ctx.isComplex,
			render(ctx) {
				const re = ctx.data, im = ctx.dataIm || [];
				const dB = new Array(re.length);
				for (let i = 0; i < re.length; i++) {
					const r = re[i], q = im[i] || 0;
					const pwr = r * r + q * q;
					dB[i] = 10 * Math.log10(pwr > EPS_PWR ? pwr : EPS_PWR);
				}
				return createLineChart(ctx.canvases.main, [
					{ data: dB, label: '|z| (dB)', color: COLOR_REAL, bg: COLOR_REAL_BG },
				]);
			},
		},
		// 复数信号分析器：I/Q + 归一化频谱 + 归一化时频图
		'complex-iq': {
			label: 'Complex I/Q + Spectrum + Spectrogram',
			available: (ctx) => ctx.isComplex,
			render(ctx) {
				const { main, spectrum, spectrogram } = ctx.canvases;
				const { spectrum: spectrumSub, spectrogram: spectrogramSub } = ctx.subPanels;
				const charts = [];
				charts.push(createLineChart(main, [
					{ data: ctx.data,         label: 'I (real)', color: COLOR_REAL, bg: COLOR_REAL_BG },
					{ data: ctx.dataIm || [], label: 'Q (imag)', color: COLOR_IMAG, bg: COLOR_IMAG_BG },
				]));
				const specChart = renderSpectrumChart(spectrum, ctx.data, ctx.dataIm || []);
				if (specChart) charts.push(specChart);
				spectrumSub.style.display = 'flex';
				if (ctx.data.length >= 16) {
					renderSpectrogramCanvas(spectrogram, ctx.data, ctx.dataIm || []);
					spectrogramSub.style.display = 'flex';
				}
				return { charts };
			},
		},
		// 2D 热力图：一维数组按 rows × cols 行主序展开，颜色 = 模值（复数）或原值（实数）
		// 实数/复数都可用，需要用户手动在 controls 栏指定 Rows/Cols。
		'heatmap-2d': {
			label: '2D Heatmap (|·| intensity)',
			available: () => true,
			render(ctx) {
				const { main } = ctx.canvases;
				const N = ctx.data.length;
				const rows = ctx.rows | 0;
				const cols = ctx.cols | 0;
				if (rows < 1 || cols < 1) {
					drawCanvasMessage(main, 'Set Rows & Cols ≥ 1 in controls above');
					return { charts: [] };
				}
				if (rows * cols > N) {
					drawCanvasMessage(main, `Rows × Cols = ${rows}×${cols} = ${rows * cols} > data length ${N}`);
					return { charts: [] };
				}
				const meta = renderHeatmapCanvas(main, ctx.data, ctx.dataIm || null, rows, cols, !!ctx.isComplex);
				return { charts: [], heatmapMeta: meta };
			},
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
		const fullLen = (payload.data && payload.data.length) || 0;

		const errorBody = entry.root.querySelector('.error-body');
		const tableSide = entry.root.querySelector('.table-side');
		const chartSide = entry.root.querySelector('.chart-side');
		const metaEl = entry.root.querySelector('.card-meta');

		if (payload.error) {
			metaEl.textContent = `${payload.type}  —  ERROR`;
			metaEl.classList.add('error');
			errorBody.textContent = payload.error;
			errorBody.style.display = 'block';
			tableSide.style.display = 'none';
			chartSide.style.display = 'none';
			destroyCharts(entry);
			entry.data = [];
			entry.dataIm = undefined;
			entry.tableRendered = 0;
			clearTableDom(tableSide);
			return;
		}
		metaEl.classList.remove('error');
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

		// 有效长度策略：用户未手动设置过 → 跟随 vector 全长；
		// 设置过但超新全长 → clamp。
		if (!entry.userLengthSet) {
			entry.length = fullLen;
		} else {
			entry.length = Math.max(1, Math.min(entry.length || fullLen, fullLen));
		}
		syncLengthInput(entry);

		// isComplex 切换（极少见，但 pin 后类型不会变；保险处理）
		if (prevIsComplex !== entry.isComplex) {
			rebuildPlotKindSelect(entry);
		}

		// meta 行（基于有效长度的统计）
		updateCardMeta(entry, payload);

		// Table：表头按 isComplex 切换 + 重置分页
		rebuildTableHeader(entry);
		entry.tableRendered = 0;
		clearTableDom(tableSide);
		renderTablePage(entry);

		// Chart：手动确认绘图模式下，数据刷新后**不**自动重绘。
		// 旧图基于旧数据，必须清除；同时重置 heatmap meta，按当前 plotKind 同步 UI。
		destroyCharts(entry);
		clearMainCanvas(entry);
		entry.heatmapData = null;
		if (entry.heatmapTitle) entry.heatmapTitle.style.display = 'none';
		hideHeatmapTooltip(entry);
		syncPlotControlsUI(entry);
		const placeholder = entry.root.querySelector('.plot-placeholder');
		showPlaceholder(entry, placeholder, 'Data updated · click “📊 Plot” to render');
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
					<div class="side-title">
						<span>Table</span>
						<button class="export-bin-btn" title="Export current variable as raw .bin (length = effective length)">💾 Export .bin</button>
					</div>
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
						<label class="length-label">Length:</label>
						<input type="number" class="length-input" min="1" step="1" />
						<span class="length-total"></span>
						<button class="length-reset-btn" title="Reset to full length">Full</button>
						<span class="heatmap-controls">
							<label>Rows</label>
							<input type="number" class="rows-input" min="1" step="1" />
							<label>× Cols</label>
							<input type="number" class="cols-input" min="1" step="1" />
						</span>
						<button class="apply-plot-btn" title="Apply current plot parameters">📊 Plot</button>
					</div>
					<div class="plot-area">
						<div class="sub-plot main-plot">
							<canvas class="main-canvas"></canvas>
							<div class="sub-plot-title heatmap-title" style="display:none"></div>
							<div class="heatmap-tooltip"></div>
						</div>
						<div class="sub-plot spectrum-plot" style="display:none">
							<div class="sub-plot-title">Spectrum · |X(f)| / max</div>
							<canvas class="spectrum-canvas"></canvas>
						</div>
						<div class="sub-plot spectrogram-plot" style="display:none">
							<div class="sub-plot-title">Spectrogram · STFT magnitude</div>
							<canvas class="spectrogram-canvas"></canvas>
						</div>
						<div class="plot-placeholder" style="display:none"></div>
					</div>
				</div>
			</div>
		`;

		const mainCanvas        = el.querySelector('.main-canvas');
		const spectrumCanvas    = el.querySelector('.spectrum-canvas');
		const spectrogramCanvas = el.querySelector('.spectrogram-canvas');
		const mainSub           = el.querySelector('.main-plot');
		const spectrumSub       = el.querySelector('.spectrum-plot');
		const spectrogramSub    = el.querySelector('.spectrogram-plot');
		const select            = el.querySelector('.plot-kind-select');
		const lengthInput       = el.querySelector('.length-input');
		const lengthTotal       = el.querySelector('.length-total');
		const lengthResetBtn    = el.querySelector('.length-reset-btn');
		const heatmapCtrl       = el.querySelector('.heatmap-controls');
		const rowsInput         = el.querySelector('.rows-input');
		const colsInput         = el.querySelector('.cols-input');
		const heatmapTooltip    = el.querySelector('.heatmap-tooltip');
		const heatmapTitle      = el.querySelector('.heatmap-title');
		const entry = {
			root: el,
			canvases:  { main: mainCanvas, spectrum: spectrumCanvas, spectrogram: spectrogramCanvas },
			subPanels: { main: mainSub,    spectrum: spectrumSub,    spectrogram: spectrogramSub },
			select,
			lengthInput,
			lengthTotal,
			heatmapCtrl,
			rowsInput,
			colsInput,
			heatmapTooltip,
			heatmapTitle,
			heatmapData: null,      // {rows, cols, isComplex, raw, im, vmin, vmax}
			charts: [],            // Chart.js 实例数组（spectrogram 非 Chart.js，不在此列）
			data: [],
			dataIm: undefined,
			length: 0,              // 有效长度
			userLengthSet: false,   // 用户是否手动改过 Length
			rows: 0,                // heatmap-2d 用：行数，0 = 未初始化
			cols: 0,                // heatmap-2d 用：列数
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
		lengthInput.addEventListener('change', () => onLengthChange(entry, lengthInput.value));
		lengthInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') onLengthChange(entry, lengthInput.value);
		});
		lengthResetBtn.addEventListener('click', () => onLengthReset(entry));
		rowsInput.addEventListener('change', () => onHeatmapDimChange(entry));
		rowsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onHeatmapDimChange(entry); });
		colsInput.addEventListener('change', () => onHeatmapDimChange(entry));
		colsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onHeatmapDimChange(entry); });
		mainCanvas.addEventListener('mousemove', (e) => onHeatmapHover(entry, e));
		mainCanvas.addEventListener('mouseleave', () => hideHeatmapTooltip(entry));
		el.querySelector('.apply-plot-btn').addEventListener('click', () => buildOrRebuildChart(entry));
		el.querySelector('.export-bin-btn').addEventListener('click', () => onExportBin(entry));
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
		// 手动确认模式：只切换控件 UI（heatmap controls / canvas 像素拉伸），不实际重绘
		syncPlotControlsUI(entry);
	}

	// ================================================================
	// Length 有效长度控制
	// ================================================================

	/** 将 entry.length 的数值同步到 input（不触发 change 事件） */
	function syncLengthInput(entry) {
		const full = entry.data.length;
		entry.lengthInput.value = String(entry.length || 0);
		entry.lengthInput.max = String(full);
		entry.lengthTotal.textContent = `/ ${full}`;
	}

	function onLengthChange(entry, rawVal) {
		const full = entry.data.length;
		let v = parseInt(rawVal, 10);
		if (!Number.isFinite(v) || v <= 0) v = 1;
		if (v > full) v = full;
		if (v === entry.length) { syncLengthInput(entry); return; }
		entry.length = v;
		entry.userLengthSet = true;
		syncLengthInput(entry);
		reRenderAfterLengthChange(entry);
	}

	function onLengthReset(entry) {
		const full = entry.data.length;
		entry.length = full;
		entry.userLengthSet = false; // 下次断点刷新时恢复跟随 vector 全长
		syncLengthInput(entry);
		reRenderAfterLengthChange(entry);
	}

	function reRenderAfterLengthChange(entry) {
		updateCardMeta(entry, null);
		entry.tableRendered = 0;
		clearTableDom(entry.root.querySelector('.table-side'));
		renderTablePage(entry);
		// 手动确认模式：长度变化后不自动重绘，需点击 “📊 Plot”
		// 仅同步 heatmap 输入框上限，避免与新 length 不一致
		if (entry.plotKind === 'heatmap-2d') ensureHeatmapDims(entry);
	}

	// ================================================================
	// Heatmap 2D 维度控制（rows / cols）
	// ================================================================

	/** 初始化或校正 entry.rows / entry.cols，同步到输入框。仅为 heatmap-2d 使用。*/
	function ensureHeatmapDims(entry) {
		const N = entry.length | 0;
		if (N <= 0) { entry.rows = 0; entry.cols = 0; }
		else if (entry.rows < 1 || entry.cols < 1) {
			// 默认：1 行 × N 列（退化为一维条）
			entry.rows = 1;
			entry.cols = N;
		}
		if (entry.rowsInput) {
			entry.rowsInput.value = String(entry.rows || 0);
			entry.rowsInput.max   = String(Math.max(1, N));
		}
		if (entry.colsInput) {
			entry.colsInput.value = String(entry.cols || 0);
			entry.colsInput.max   = String(Math.max(1, N));
		}
	}

	function onHeatmapDimChange(entry) {
		const N = entry.length | 0;
		let r = parseInt(entry.rowsInput.value, 10);
		let c = parseInt(entry.colsInput.value, 10);
		if (!Number.isFinite(r) || r < 1) r = 1;
		if (!Number.isFinite(c) || c < 1) c = 1;
		if (r > N) r = N;
		if (c > N) c = N;
		entry.rows = r;
		entry.cols = c;
		ensureHeatmapDims(entry);
		// 手动确认模式：Rows/Cols 变动后不自动重绘，需点击 “📊 Plot”
	}

	// ================================================================
	// 数据导出为 .bin
	// ================================================================

	/** 向 extension 发送导出请求。数据本体由 extension 从 dataProvider 中取，
	 *  避免通过 postMessage 传输大数组。webview 只传 id + 有效长度。 */
	function onExportBin(entry) {
		const id = entry.root.dataset.id;
		if (!id) return;
		const N = entry.data ? entry.data.length : 0;
		if (N <= 0) return;
		const eff = Math.max(1, Math.min(entry.length || N, N));
		vscode.postMessage({
			command: 'exportBin',
			id,
			length: eff,
		});
	}

	/**
	 * meta 行文本渲染：可选传 payload（新数据到来时）用于保留原 type 与 elementType
	 * 或传 null（仅 Length 变动的重渲染）从 entry 现有值重建。
	 */
	function updateCardMeta(entry, payload) {
		const metaEl = entry.root.querySelector('.card-meta');
		const typeStr = (payload && payload.type) || entry._type || '';
		entry._type = typeStr;
		const tag = entry.isComplex ? ' [complex]' : '';
		const eff = entry.length;
		const full = entry.data.length;
		const lenText = (eff === full) ? `× ${full}` : `× ${eff} / ${full}`;
		const effRe = entry.data.slice(0, eff);
		const effIm = entry.dataIm ? entry.dataIm.slice(0, eff) : undefined;
		const stats = buildStatsFromArrays(effRe, effIm, entry.isComplex);
		metaEl.textContent = `${typeStr}   ${entry.elementType}${tag} ${lenText}${stats}`;
	}

	/**
	 * 根据当前 plotKind 重建 Chart。
	 * 不可用 / render 返回 null → 显示 placeholder。
	 * 多图 plot kind（如 complex-iq）由其 render 函数自行展开额外子面板。
	 */
	function buildOrRebuildChart(entry) {
		destroyCharts(entry);

		const spec = PLOT_KINDS[entry.plotKind];
		const placeholder = entry.root.querySelector('.plot-placeholder');
		const isHeatmap = entry.plotKind === 'heatmap-2d';

		// 重置子面板：默认只显示主图，频谱 / 时频图隐藏
		entry.subPanels.main.style.display        = 'flex';
		entry.subPanels.spectrum.style.display    = 'none';
		entry.subPanels.spectrogram.style.display = 'none';
		placeholder.style.display                 = 'none';

		// 切控件 UI（heatmap controls / canvas .heatmap class / rows-cols 输入同步）
		syncPlotControlsUI(entry);

		// 按用户有效长度截断
		const eff = entry.length;
		const effData = entry.data.slice(0, eff);
		const effIm = entry.dataIm ? entry.dataIm.slice(0, eff) : undefined;

		const ctx = {
			isComplex: entry.isComplex,
			length: eff,
			elementType: entry.elementType,
			data: effData,
			dataIm: effIm,
			canvases: entry.canvases,
			subPanels: entry.subPanels,
			rows: entry.rows,
			cols: entry.cols,
		};

		if (!spec) { showPlaceholder(entry, placeholder, 'Unknown plot kind'); return; }
		if (eff === 0) { showPlaceholder(entry, placeholder, 'No data'); return; }
		if (!spec.available(ctx)) { showPlaceholder(entry, placeholder, 'Not available for this data'); return; }

		const result = spec.render(ctx);
		if (!result) { showPlaceholder(entry, placeholder, 'Not implemented yet'); return; }

		entry.charts = Array.isArray(result)
			? result
			: (result && Array.isArray(result.charts) ? result.charts : [result]);

		// heatmap meta 同步与右上角维度标示
		if (isHeatmap && result && result.heatmapMeta) {
			entry.heatmapData = result.heatmapMeta;
			if (entry.heatmapTitle) {
				entry.heatmapTitle.textContent = `${result.heatmapMeta.rows} × ${result.heatmapMeta.cols} (rows × cols)`;
				entry.heatmapTitle.style.display = 'block';
			}
		} else {
			entry.heatmapData = null;
			if (entry.heatmapTitle) entry.heatmapTitle.style.display = 'none';
			hideHeatmapTooltip(entry);
		}
	}

	/** 只切控件 UI（不实际重绘）：heatmap controls 显隐 + main canvas .heatmap class + Rows/Cols 输入同步 */
	function syncPlotControlsUI(entry) {
		const isHeatmap = entry.plotKind === 'heatmap-2d';
		if (entry.heatmapCtrl) entry.heatmapCtrl.classList.toggle('active', isHeatmap);
		if (entry.subPanels && entry.subPanels.main) {
			entry.subPanels.main.classList.toggle('heatmap', isHeatmap);
		}
		if (isHeatmap) ensureHeatmapDims(entry);
	}

	/** 清空 main canvas 上的旧热力图 / 提示文本，避免过期内容残留 */
	function clearMainCanvas(entry) {
		const c = entry.canvases && entry.canvases.main;
		if (!c) return;
		const ctx2d = c.getContext('2d');
		if (ctx2d) ctx2d.clearRect(0, 0, c.width, c.height);
	}

	/** 清空当前卡片上所有 Chart.js 实例（spectrogram 非 Chart.js，无需 destroy） */
	function destroyCharts(entry) {
		if (entry.charts && entry.charts.length) {
			for (const c of entry.charts) {
				try { c && c.destroy && c.destroy(); } catch (_) { /* ignore */ }
			}
		}
		entry.charts = [];
	}

	function showPlaceholder(entry, placeholder, text) {
		entry.subPanels.main.style.display        = 'none';
		entry.subPanels.spectrum.style.display    = 'none';
		entry.subPanels.spectrogram.style.display = 'none';
		placeholder.style.display = 'flex';
		placeholder.textContent = text;
	}

	function removeCard(id) {
		const entry = cards.get(id);
		if (!entry) return;
		destroyCharts(entry);
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
	// FFT · Spectrum · Spectrogram（复数信号分析器用）
	// ================================================================

	function nextPow2(n) {
		let p = 1;
		while (p < n) p <<= 1;
		return p;
	}

	/**
	 * 返回不小于 x 的“nice number”步长（1/2/5 × 10^k）。
	 * 用于生成等齐的整数刻度，避免出现 51.2 / 102.4 之类的碎步长。
	 */
	function niceStepNumber(x) {
		if (!(x > 0)) return 1;
		const exp = Math.floor(Math.log10(x));
		const base = Math.pow(10, exp);
		const frac = x / base;
		let nice;
		if (frac < 1.5) nice = 1;
		else if (frac < 3) nice = 2;
		else if (frac < 7) nice = 5;
		else nice = 10;
		return nice * base;
	}

	/** 原地 Cooley-Tukey radix-2 FFT。re/im 长度必须为 2 的幂。*/
	function fftInPlace(re, im) {
		const n = re.length;
		if (n <= 1) return;
		// bit-reversal 重排
		let j = 0;
		for (let i = 1; i < n; i++) {
			let bit = n >> 1;
			for (; (j & bit); bit >>= 1) j ^= bit;
			j ^= bit;
			if (i < j) {
				const tr = re[i]; re[i] = re[j]; re[j] = tr;
				const ti = im[i]; im[i] = im[j]; im[j] = ti;
			}
		}
		// 蝴蝶运算
		for (let size = 2; size <= n; size <<= 1) {
			const half = size >> 1;
			const theta = -2 * Math.PI / size;
			const wpr = Math.cos(theta);
			const wpi = Math.sin(theta);
			for (let start = 0; start < n; start += size) {
				let wr = 1, wi = 0;
				for (let k = 0; k < half; k++) {
					const i0 = start + k;
					const i1 = i0 + half;
					const tr = re[i1] * wr - im[i1] * wi;
					const ti = re[i1] * wi + im[i1] * wr;
					re[i1] = re[i0] - tr;
					im[i1] = im[i0] - ti;
					re[i0] += tr;
					im[i0] += ti;
					const nwr = wr * wpr - wi * wpi;
					wi = wr * wpi + wi * wpr;
					wr = nwr;
				}
			}
		}
	}

	/**
	 * 频谱：|X(f)| / max；横轴归一化频率 [-0.5, 0.5)，纵轴归一化幅度。
	 * 内部做 FFT + fftshift（零频居中）；N 非 2 幂时补零到下一个 2 幂。
	 */
	function renderSpectrumChart(canvas, dataRe, dataIm) {
		const N = dataRe.length;
		if (N === 0) return null;
		const Nf = nextPow2(N);
		const re = new Float64Array(Nf);
		const im = new Float64Array(Nf);
		for (let i = 0; i < N; i++) {
			re[i] = dataRe[i] || 0;
			im[i] = dataIm[i] || 0;
		}
		fftInPlace(re, im);
		const half = Nf >> 1;
		// {x: 归一化频率, y: 归一化幅度} 点对 → linear 轴配合 stepSize=0.1，
		// 从而得到11个刻度 -0.5,-0.4,...,0,...,0.4,0.5（恠10格且中心为0）。
		const points = new Array(Nf);
		let mx = 0;
		for (let i = 0; i < Nf; i++) {
			const srcIdx = (i < half) ? (i + half) : (i - half);
			const m = Math.sqrt(re[srcIdx] * re[srcIdx] + im[srcIdx] * im[srcIdx]);
			points[i] = { x: (i - half) / Nf, y: m };
			if (m > mx) mx = m;
		}
		if (mx > 0) for (let i = 0; i < Nf; i++) points[i].y /= mx;
		return new Chart(canvas.getContext('2d'), {
			type: 'line',
			data: {
				datasets: [{
					data: points,
					label: '|X(f)| / max',
					borderColor: COLOR_REAL,
					backgroundColor: COLOR_REAL_BG,
					borderWidth: 1.2,
					pointRadius: 0,
					tension: 0,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: {
					legend: { display: false },
					tooltip: { mode: 'nearest', intersect: false, axis: 'x' },
				},
				scales: {
					x: {
						type: 'linear',
						min: -0.5,
						max: 0.5,
						title: { display: true, text: 'Normalized frequency (cycles / sample)' },
						ticks: {
							stepSize: 0.1,
							autoSkip: false,
							// 避免浮点精度尾巴（-0.30000000000000004 → -0.3）
							callback: (v) => Number(v).toFixed(1),
						},
						grid: { color: 'rgba(255,255,255,0.06)' },
					},
					y: {
						min: 0, max: 1.05,
						title: { display: true, text: '|X| (norm.)' },
						grid: { color: 'rgba(255,255,255,0.06)' },
					},
				},
			},
		});
	}

	/**
	 * 时频图：STFT + viridis 调色板像素图。
	 * X 轴：样本索引（与 I/Q 图对应）；Y 轴：归一化频率（顶 +0.5，底 -0.5）；
	 * 颜色：归一化到 [0,1] 的幅值。窗长自适应≈N/16，50% 重叠，Hann 窗。
	 */
	function renderSpectrogramCanvas(canvas, dataRe, dataIm) {
		const N = dataRe.length;
		const canvasCtx = canvas.getContext('2d');
		if (N < 16) { canvas.width = 1; canvas.height = 1; canvasCtx.clearRect(0, 0, 1, 1); return; }
		let W = nextPow2(Math.max(8, Math.floor(N / 16)));
		if (W > 256) W = 256;
		if (W > N) W = Math.max(8, nextPow2(N) >> 1);
		if (W < 8) W = 8;
		const H = Math.max(1, W >> 1);
		const NT = Math.max(1, Math.floor((N - W) / H) + 1);
		const win = new Float64Array(W);
		for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (W - 1));
		const frames = new Array(NT);
		let mx = 0;
		const re = new Float64Array(W);
		const im = new Float64Array(W);
		const halfW = W >> 1;
		for (let t = 0; t < NT; t++) {
			const start = t * H;
			for (let i = 0; i < W; i++) {
				const w = win[i];
				re[i] = (dataRe[start + i] || 0) * w;
				im[i] = (dataIm[start + i] || 0) * w;
			}
			fftInPlace(re, im);
			const frame = new Float32Array(W);
			for (let i = 0; i < W; i++) {
				const srcIdx = (i < halfW) ? (i + halfW) : (i - halfW);
				const m = Math.sqrt(re[srcIdx] * re[srcIdx] + im[srcIdx] * im[srcIdx]);
				frame[i] = m;
				if (m > mx) mx = m;
			}
			frames[t] = frame;
		}
		if (mx > 0) {
			for (let t = 0; t < NT; t++) {
				const f = frames[t];
				for (let i = 0; i < W; i++) f[i] /= mx;
			}
		}
		canvas.width = NT;
		canvas.height = W;
		const imageData = canvasCtx.createImageData(NT, W);
		const px = imageData.data;
		for (let t = 0; t < NT; t++) {
			const f = frames[t];
			for (let y = 0; y < W; y++) {
				const srcIdx = W - 1 - y;  // y=0 为顶部 = 最高频 +0.5
				const v = f[srcIdx];
				const rgb = viridisColor(v);
				const pIdx = (y * NT + t) * 4;
				px[pIdx]     = rgb[0];
				px[pIdx + 1] = rgb[1];
				px[pIdx + 2] = rgb[2];
				px[pIdx + 3] = 255;
			}
		}
		canvasCtx.putImageData(imageData, 0, 0);
	}

	/**
	 * 2D 热力图：将一维数组按行主序（row_i * cols + col_j）展开为 rows×cols 的矩阵，
	 * 每个元素按值映射到 viridis 调色板。
	 *   • 复数：v_ij = sqrt(re_k² + im_k²)（k = i*cols + j）
	 *   • 实数：v_ij = src_k 直接使用（可能为负）
	 *   • 归一化：(v - vmin) / (vmax - vmin)，vmin==vmax 时整片填色 0
	 * canvas 像素尺寸正好 = cols × rows，CSS 会按 pixelated 拉伸到面板大小。
	 */
	function renderHeatmapCanvas(canvas, srcRe, srcIm, rows, cols, isComplex) {
		const total = rows * cols;
		// raw 保持原始值供 tooltip 读取（复数下 raw=re，im 单独缓存）
		const raw = new Float64Array(total);
		const im  = isComplex ? new Float64Array(total) : null;
		const mag = new Float64Array(total);
		let vmin = Infinity, vmax = -Infinity;
		if (isComplex) {
			for (let i = 0; i < total; i++) {
				const r = srcRe[i] || 0;
				const q = (srcIm && srcIm[i]) || 0;
				raw[i] = r;
				im[i]  = q;
				const m = Math.sqrt(r * r + q * q);
				mag[i] = m;
				if (m < vmin) vmin = m;
				if (m > vmax) vmax = m;
			}
		} else {
			for (let i = 0; i < total; i++) {
				const v = srcRe[i] || 0;
				raw[i] = v;
				mag[i] = v;
				if (v < vmin) vmin = v;
				if (v > vmax) vmax = v;
			}
		}
		const span = vmax - vmin;
		const inv = span > 0 ? (1 / span) : 0;
		canvas.width = cols;
		canvas.height = rows;
		const ctx2d = canvas.getContext('2d');
		const imageData = ctx2d.createImageData(cols, rows);
		const px = imageData.data;
		for (let r = 0; r < rows; r++) {
			const rowBase = r * cols;
			for (let c = 0; c < cols; c++) {
				const v = span > 0 ? (mag[rowBase + c] - vmin) * inv : 0;
				const rgb = viridisColor(v);
				const pIdx = (rowBase + c) * 4;
				px[pIdx]     = rgb[0];
				px[pIdx + 1] = rgb[1];
				px[pIdx + 2] = rgb[2];
				px[pIdx + 3] = 255;
			}
		}
		ctx2d.putImageData(imageData, 0, 0);
		return { rows, cols, isComplex, raw, im, vmin, vmax };
	}

	// ================================================================
	// Heatmap 鼠标悬停 tooltip：显示 row / col / value
	// ================================================================

	function onHeatmapHover(entry, ev) {
		if (entry.plotKind !== 'heatmap-2d') return;
		const meta = entry.heatmapData;
		if (!meta || !meta.rows || !meta.cols) { hideHeatmapTooltip(entry); return; }
		const canvas = entry.canvases.main;
		const rect = canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const x = ev.clientX - rect.left;
		const y = ev.clientY - rect.top;
		let col = Math.floor((x / rect.width)  * meta.cols);
		let row = Math.floor((y / rect.height) * meta.rows);
		if (col < 0) col = 0; if (col >= meta.cols) col = meta.cols - 1;
		if (row < 0) row = 0; if (row >= meta.rows) row = meta.rows - 1;
		const idx = row * meta.cols + col;
		let valText;
		if (meta.isComplex) {
			const re = meta.raw[idx];
			const qi = (meta.im && meta.im[idx]) || 0;
			const m  = Math.sqrt(re * re + qi * qi);
			valText = `|z|=${formatNumber(m)}\nre=${formatNumber(re)}  im=${formatNumber(qi)}`;
		} else {
			valText = `value=${formatNumber(meta.raw[idx])}`;
		}
		const tip = entry.heatmapTooltip;
		if (!tip) return;
		tip.textContent = `row=${row}  col=${col}\n${valText}`;
		tip.style.whiteSpace = 'pre';
		tip.classList.add('active');
		// 定位：相对于 .main-plot 容器
		const host = entry.subPanels.main;
		const hostRect = host.getBoundingClientRect();
		let tx = ev.clientX - hostRect.left + 12;
		let ty = ev.clientY - hostRect.top  + 12;
		// 防超边：右 / 下超出时跳到鼠标左上侧
		const tipW = tip.offsetWidth  || 140;
		const tipH = tip.offsetHeight || 40;
		if (tx + tipW > hostRect.width)  tx = ev.clientX - hostRect.left - tipW - 12;
		if (ty + tipH > hostRect.height) ty = ev.clientY - hostRect.top  - tipH - 12;
		if (tx < 0) tx = 0;
		if (ty < 0) ty = 0;
		tip.style.left = `${tx}px`;
		tip.style.top  = `${ty}px`;
	}

	function hideHeatmapTooltip(entry) {
		if (entry && entry.heatmapTooltip) entry.heatmapTooltip.classList.remove('active');
	}

	/** 数值格式化：极小或极大用科学计数法，其余保留 4 位小数 */
	function formatNumber(v) {
		if (!Number.isFinite(v)) return String(v);
		if (v === 0) return '0';
		const a = Math.abs(v);
		if (a < 1e-3 || a >= 1e6) return v.toExponential(3);
		return v.toFixed(4);
	}

	/** 在 canvas 上居中绘制一段红色提示文本（用于 heatmap 参数无效时） */
	function drawCanvasMessage(canvas, text) {
		const dpr = window.devicePixelRatio || 1;
		const cssW = canvas.clientWidth  || 400;
		const cssH = canvas.clientHeight || 200;
		canvas.width  = Math.max(1, Math.floor(cssW * dpr));
		canvas.height = Math.max(1, Math.floor(cssH * dpr));
		const ctx2d = canvas.getContext('2d');
		ctx2d.clearRect(0, 0, canvas.width, canvas.height);
		ctx2d.fillStyle = 'rgba(220, 80, 80, 0.9)';
		ctx2d.font = `${Math.round(14 * dpr)}px sans-serif`;
		ctx2d.textAlign = 'center';
		ctx2d.textBaseline = 'middle';
		ctx2d.fillText(text, canvas.width / 2, canvas.height / 2);
	}

	/** 简化 Viridis 调色板：5 段线性插值，输入 v ∈ [0,1]。*/
	function viridisColor(v) {
		if (!Number.isFinite(v)) v = 0;
		if (v < 0) v = 0; else if (v > 1) v = 1;
		const stops = [
			[68, 1, 84],
			[59, 82, 139],
			[33, 145, 140],
			[94, 201, 98],
			[253, 231, 37],
		];
		const s = v * (stops.length - 1);
		const i = Math.floor(s);
		const frac = s - i;
		if (i >= stops.length - 1) return stops[stops.length - 1];
		const a = stops[i], b = stops[i + 1];
		return [
			Math.round(a[0] + frac * (b[0] - a[0])),
			Math.round(a[1] + frac * (b[1] - a[1])),
			Math.round(a[2] + frac * (b[2] - a[2])),
		];
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
		const datasets = series.map(s => ({
			label: s.label,
			// {x,y} 点对 + linear 轴 → 保证最右端 x=len-1 一定能被显示
			data: s.data.map((v, i) => ({ x: i, y: v })),
			borderColor: s.color,
			backgroundColor: s.bg,
			borderWidth: 1.5,
			pointRadius: 0,
			tension: 0.0,
		}));
		const xMax = Math.max(0, len - 1);
		return new Chart(canvas.getContext('2d'), {
			type: 'line',
			data: { datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: {
					legend: { display: datasets.length > 1, position: 'top' },
					tooltip: { mode: 'nearest', intersect: false, axis: 'x' },
				},
				scales: {
					x: {
						type: 'linear',
						bounds: 'data',
						min: 0,
						max: xMax,
						// 关掉 autoSkip，完全自行生成 nice-number 刻度：
						//   • 基本刻度按 xMax/10 取 1/2/5×10^k的整齐步长
						//   • 最右必须是 xMax；若与最后一个 nice tick 距离过近（<40% 步长）
						//     就替掉它而非追加，避免两个标签重叠（例如 500 vs 511）。
						ticks: { autoSkip: false, maxRotation: 0, precision: 0 },
						afterBuildTicks: (scale) => {
							if (xMax <= 0) { scale.ticks = [{ value: 0 }]; return; }
							const niceStep = niceStepNumber(xMax / 10);
							const ticks = [];
							for (let v = 0; v <= xMax + 1e-9; v += niceStep) {
								ticks.push({ value: Math.round(v) });
							}
							const last = ticks[ticks.length - 1].value;
							if (last < xMax) {
								if (xMax - last < niceStep * 0.4) {
									ticks[ticks.length - 1] = { value: xMax };
								} else {
									ticks.push({ value: xMax });
								}
							} else if (last > xMax) {
								ticks[ticks.length - 1] = { value: xMax };
							}
							scale.ticks = ticks;
						},
						grid: { color: 'rgba(255,255,255,0.06)' },
					},
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
		const eff = entry.length;                          // 用户有效长度
		const start = entry.tableRendered;
		const end = Math.min(start + entry.pageSize, eff);

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

		if (end < eff) {
			btn.style.display = 'inline-block';
			btn.textContent = `Show more (${end} / ${eff})`;
		} else {
			btn.style.display = 'none';
		}
	}

	// ================================================================
	// 工具
	// ================================================================

	/**
	 * meta 行统计：已由调用方截断好的 re / im 数组计算。
	 *   实数：min / max / mean
	 *   复数：|z| 的 min / max / mean
	 */
	function buildStatsFromArrays(re, im, isComplex) {
		if (!re || re.length === 0) return '';
		let mn = Infinity, mx = -Infinity, sum = 0;
		if (isComplex && im) {
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
