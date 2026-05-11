/**
 * ======================================================================
 * webview.js - Webview 前端逻辑
 * ======================================================================
 *
 * 本文件运行在 Webview 的浏览器沙箱中（不是 Node.js 环境）。
 * 因此不能使用 Node.js API（如 fs、path），只能使用浏览器 API（如 DOM、Window）。
 *
 * 主要职责：
 *   1. 初始化 Chart.js 图表（配置坐标轴、样式、交互）
 *   2. 监听来自扩展代码的消息（plotSignal 命令）
 *   3. 更新图表数据并渲染波形
 *   4. 计算并显示信号统计信息（最小值、最大值、平均值）
 *
 * Webview 与扩展代码的通信模式：
 *   - 扩展 → Webview: 发送 plotSignal 消息（包含变量名和数据）。
 *     使用 panel.webview.postMessage(message)。
 *   - Webview → 扩展: 发送 ready 消息（通知扩展 Webview 已加载完成）。
 *     使用 vscode.postMessage(message)。
 *     注意：vscode 是 Webview 中的全局对象，由 VSCode 注入。
 *
 * 调试技巧：
 *   在 Webview 中按 Ctrl+Shift+I 可以打开开发者工具（类似 Chrome DevTools），
 *   查看 console.log 输出、DOM 结构、网络请求等。
 *
 * ======================================================================
 */

/**
 * chart 是 Chart.js 实例的全局引用。
 * 声明为全局变量（不在函数内）是因为需要在多个函数中访问和更新它。
 *
 * let（可变）vs const（常量）：
 *   这里用 let 是因为 initChart() 中赋了一次值，后续只更新数据，不会替换实例。
 *   如果用 const，就不能重新赋值（但对象内部属性可以修改）。
 *   用 let 更灵活，但要注意不要意外覆盖。
 */
let chart = null;

/**
 * window.addEventListener('load', ...) 在页面加载完成后执行。
 *
 * 'load' 事件在所有资源（HTML、CSS、JS）加载完成后触发。
 * 这确保 Chart.js 库已经加载，可以正常使用。
 *
 * 箭头函数（() => { ... }）是 ES6 语法，等价于：
 *   function() { ... }
 * 箭头函数的特点是不绑定自己的 this，但在本场景中不使用 this，所以无影响。
 */
window.addEventListener('load', () => {
	/**
	 * 初始化图表。
	 * 在页面加载时创建一个空的折线图（无数据），等待接收数据后填充。
	 */
	initChart();

	/**
	 * 监听来自扩展代码的消息。
	 *
	 * 这是 Webview → 扩展的通信通道的反向：扩展 → Webview。
	 *
	 * event.data 是消息内容，格式由扩展代码定义（postMessage 的参数）。
	 *
	 * 消息协议（自定义）：
	 *   { command: 'init', ... }       → 扩展初始化后发送（握手信号）
	 *   { command: 'plotSignal', ... }  → 扩展发送绘图数据
	 *
	 * switch-case 是处理多种命令的标准模式，比多个 if-else 更清晰。
	 */
	window.addEventListener('message', event => {
		const message = event.data;

		switch (message.command) {
			case 'init':
				/**
				 * 收到 init 消息（握手）。
				 * 目前不需要特殊处理，图表已在 load 事件中初始化。
				 * 后续可以在这里执行一些初始化逻辑（如加载保存的配置）。
				 */
				break;

			case 'plotSignal':
				/**
				 * 收到 plotSignal 消息，包含要绘制的信号数据。
				 * message.variable 的结构：
				 *   {
				 *     name: 'pulse_data',
				 *     type: 'std::vector<float>',
				 *     data: [0.1, 0.2, 0.3, ...]
				 *   }
				 */
				plotSignal(message.variable);
				break;
		}
	});
});

/**
 * 初始化 Chart.js 图表。
 *
 * Chart.js 是一个流行的 JavaScript 图表库，支持多种图表类型（折线图、柱状图、饼图等）。
 * 这里使用折线图（line chart）来显示信号的时域波形。
 *
 * Chart.js 配置结构：
 *   new Chart(ctx, {
 *     type: 'line',     // 图表类型
 *     data: { ... },    // 数据（标签、数据集）
 *     options: { ... }  // 配置（坐标轴、样式、插件、交互）
 *   })
 */
function initChart() {
	/**
	 * 获取 Canvas 元素的 2D 绘图上下文。
	 *
	 * document.getElementById('signalChart') 获取 HTML 中 id 为 signalChart 的 <canvas> 元素。
	 * getContext('2d') 返回 Canvas 2D 渲染上下文，用于绘制图形。
	 *
	 * Chart.js 需要这个 ctx 来在 Canvas 上绘制图表。
	 */
	const ctx = document.getElementById('signalChart').getContext('2d');

	/**
	 * 创建 Chart 实例。
	 *
	 * 配置项详解：
	 */
	chart = new Chart(ctx, {
		/**
		 * type: 图表类型。
		 * 'line' = 折线图（适合显示连续信号波形）。
		 * 其他选项：'bar'（柱状图）、'pie'（饼图）、'scatter'（散点图）等。
		 */
		type: 'line',

		/**
		 * data: 图表的数据部分。
		 * 包含 labels（X 轴标签）和 datasets（数据系列）。
		 */
		data: {
			/**
			 * labels: X 轴的标签数组。
			 * 初始为空数组，后续会在 plotSignal() 中填充。
			 *
			 * 例如：[0, 1, 2, 3, ...] 表示采样点索引。
			 */
			labels: [],

			/**
			 * datasets: 数据系列数组。
			 * 一个 dataset 代表一组数据（可以有多条线，这里只有一条）。
			 */
			datasets: [{
				/**
				 * label: 数据系列名称，显示在图例（legend）中。
				 * 初始为 'Signal'，在 plotSignal() 中会被替换为变量名。
				 */
				label: 'Signal',

				/**
				 * data: Y 轴的数值数组（信号幅度值）。
				 * 初始为空，在 plotSignal() 中填充。
				 */
				data: [],

				/**
				 * borderColor: 折线的颜色（RGB 格式）。
				 * rgb(75, 192, 192) 是青绿色，适合雷达信号可视化。
				 */
				borderColor: 'rgb(75, 192, 192)',

				/**
				 * backgroundColor: 折线下方的填充颜色。
				 * rgba 的第四个参数是透明度（0.1 = 10% 透明度），实现半透明填充效果。
				 */
				backgroundColor: 'rgba(75, 192, 192, 0.1)',

				/**
				 * borderWidth: 折线的宽度（像素）。
				 * 1 表示细线，适合显示大量数据点（不会遮挡）。
				 */
				borderWidth: 1,

				/**
				 * pointRadius: 数据点的半径。
				 * 0 表示不显示点（只显示线），适合大数据集（256+ 个点）。
				 * 如果设为 3，每个点会显示为小圆点，适合小数据集。
				 */
				pointRadius: 0,

				/**
				 * pointHoverRadius: 鼠标悬停时数据点的半径。
				 * 即使 pointRadius 为 0，悬停时仍然可以显示点，方便查看具体数值。
				 */
				pointHoverRadius: 3,

				/**
				 * fill: 是否填充折线下方的区域。
				 * true = 填充，配合 backgroundColor 实现渐变效果。
				 */
				fill: true,

				/**
				 * tension: 曲线平滑度。
				 * 0 = 直线连接（折线），适合雷达信号（真实采样值）。
				 * 0.4 = 贝塞尔曲线平滑，适合显示趋势但不适合精确信号。
				 */
				tension: 0
			}]
		},

		/**
		 * options: 图表的配置选项。
		 */
		options: {
			/**
			 * responsive: true 使图表响应容器大小变化（自动缩放）。
			 * 当用户调整 VSCode 面板大小时，图表会自动重绘以适应新尺寸。
			 */
			responsive: true,

			/**
			 * maintainAspectRatio: false 取消固定宽高比，
			 * 允许图表完全填充容器（配合 CSS 的 flex: 1 使用）。
			 */
			maintainAspectRatio: false,

			/**
			 * animation: 数据更新时的动画效果。
			 * duration: 300ms，平滑过渡，不会太慢（影响体验）或太快（视觉跳跃）。
			 */
			animation: {
				duration: 300
			},

			/**
			 * scales: 坐标轴配置（X 轴和 Y 轴）。
			 */
			scales: {
				/**
				 * x: X 轴（采样点索引）。
				 */
				x: {
					/**
					 * type: 'linear' 表示数值轴（不是分类轴）。
					 * 坐标值是数字（0, 1, 2, ...），不是字符串标签。
					 */
					type: 'linear',

					/**
					 * display: 是否显示此轴。
					 */
					display: true,

					/**
					 * title: 坐标轴标题。
					 */
					title: {
						display: true,
						text: 'Sample Index',
						color: 'rgb(128, 128, 128)',  // 灰色，不抢眼
						font: {
							size: 12
						}
					},

					/**
					 * ticks: 刻度（刻度线和数字）配置。
					 */
					ticks: {
						color: 'rgb(128, 128, 128)',
						maxTicksLimit: 10  // 最多显示 10 个刻度，避免拥挤
					},

					/**
					 * grid: 网格线配置。
					 */
					grid: {
						color: 'rgba(128, 128, 128, 0.1)'  // 淡灰色，几乎不可见
					}
				},

				/**
				 * y: Y 轴（信号幅度）。
				 */
				y: {
					display: true,
					title: {
						display: true,
						text: 'Amplitude',
						color: 'rgb(128, 128, 128)',
						font: {
							size: 12
						}
					},
					ticks: {
						color: 'rgb(128, 128, 128)'
					},
					grid: {
						color: 'rgba(128, 128, 128, 0.1)'
					}
				}
			},

			/**
			 * plugins: 插件配置（图例、提示框等）。
			 */
			plugins: {
				/**
				 * legend: 图例（显示数据系列名称和颜色）。
				 */
				legend: {
					display: true,
					position: 'top',  // 显示在图表顶部
					labels: {
						color: 'rgb(128, 128, 128)',
						usePointStyle: true,   // 用点代替方块
						boxWidth: 8            // 图例符号宽度
					}
				},

				/**
				 * tooltip: 鼠标悬停时的提示框。
				 */
				tooltip: {
					mode: 'index',        // 显示同一 X 值的所有数据系列
					intersect: false,     // 不需要鼠标精确指向数据点，只要在附近就显示
					backgroundColor: 'rgba(0, 0, 0, 0.8)',  // 半透明黑色背景
					titleColor: 'white',
					bodyColor: 'white',
					borderColor: 'rgba(128, 128, 128, 0.5)',
					borderWidth: 1
				}
			},

			/**
			 * interaction: 交互行为配置。
			 */
			interaction: {
				mode: 'nearest',  // 找到最近的数据点
				axis: 'x',        // 仅在 X 轴方向搜索最近点
				intersect: false  // 不需要精确点击，鼠标在附近就响应
			}
		}
	});
}

/**
 * 绘制信号波形。
 *
 * 当扩展代码发送 plotSignal 消息时调用。
 * 此函数更新图表数据并重新渲染。
 *
 * @param variable - 信号变量对象，包含 name、type、data 字段。
 */
function plotSignal(variable) {
	/**
	 * 防御性检查：确保 chart、variable、data 都存在。
	 * 防止空指针异常（Webview 中不会显示错误堆栈，调试困难）。
	 */
	if (!chart || !variable || !variable.data) {
		return;
	}

	const data = variable.data;

	/**
	 * 大数据集降采样：
	 *
	 * Chart.js 绘制超过 10000 个点会非常慢（甚至卡死浏览器）。
	 * 这里实现了一个简单的等间隔采样算法：
	 *   - 如果数据点 <= 10000，直接绘制全部。
	 *   - 如果数据点 > 10000，每隔 step 个点取一个，保证最多 10000 个点。
	 *
	 * 例如：256000 个点 → step = 256000 / 10000 = 25.6 → 向上取整为 26
	 *       取第 0、26、52、78、... 个点，总共约 9846 个点。
	 *
	 * 这种采样方式保留了信号的整体趋势，牺牲了部分细节。
	 * 对于雷达信号调试，通常足够观察波形特征。
	 */
	const MAX_RENDER_POINTS = 10000;
	let renderData = data;
	if (data.length > MAX_RENDER_POINTS) {
		const step = Math.ceil(data.length / MAX_RENDER_POINTS);
		renderData = [];
		for (let i = 0; i < data.length; i += step) {
			renderData.push(data[i]);
		}
	}

	/**
	 * 生成 X 轴标签（采样点索引）。
	 *
	 * .map((_, i) => i) 是数组映射操作：
	 *   _ 表示忽略元素值（我们只关心索引）。
	 *   i 是当前元素的索引（0, 1, 2, ...）。
	 *   返回新数组 [0, 1, 2, ..., renderData.length - 1]。
	 */
	const labels = renderData.map((_, i) => i);

	/**
	 * 更新图表数据。
	 *
	 * chart.data 是 Chart.js 的数据对象，直接修改其属性，
	 * 然后调用 chart.update() 重新渲染。
	 */
	chart.data.labels = labels;
	chart.data.datasets[0].data = renderData;
	chart.data.datasets[0].label = variable.name || 'Signal';
	chart.update();

	/**
	 * 更新信号信息（标题下方）和统计面板。
	 *
	 * 注意：updateStatistics() 使用原始 data（未降采样），
	 * 确保统计信息准确（不受降采样影响）。
	 */
	updateSignalInfo(variable);
	updateStatistics(data); // 统计使用原始数据
}

/**
 * 更新信号信息显示区域。
 *
 * 显示变量名、类型和实际数据点数。
 *
 * @param variable - 信号变量对象。
 */
function updateSignalInfo(variable) {
	const infoDiv = document.getElementById('signalInfo');
	if (infoDiv) {
		/**
		 * 模板字符串（反引号）用于格式化文本。
		 * ${variable.name} 会被变量值替换。
		 * variable.data?.length 使用可选链（?.），
		 * 如果 variable.data 为 null/undefined，不会报错，返回 undefined。
		 * || 0 是默认值，如果 ?. 返回 undefined，使用 0。
		 */
		infoDiv.textContent = `Variable: ${variable.name} | Type: ${variable.type} | Points: ${variable.data?.length || 0}`;
	}
}

/**
 * 计算并显示信号统计信息。
 *
 * 计算最小值、最大值、平均值。
 *
 * 为什么不用 Math.min(...data) 和 Math.max(...data)？
 *   ...（展开运算符）会将数组元素作为函数参数传递。
 *   JavaScript 引擎对函数参数数量有限制（通常约 10 万）。
 *   超过限制会抛出 RangeError（调用栈溢出）。
 *
 * 使用 for 循环遍历可以避免这个问题，且对任意大小的数组都有效。
 *
 * @param data - 信号数值数组。
 */
function updateStatistics(data) {
	if (!data || data.length === 0) {
		return;
	}

	/**
	 * 初始化 min 和 max 为第一个元素。
	 * 不能用 0，因为信号值可能是负数（如 -1.0）。
	 */
	let min = data[0];
	let max = data[0];
	let sum = 0;

	/**
	 * 遍历数组，同时计算 min、max、sum。
	 * 一次遍历完成三个计算，比三次独立遍历更高效。
	 */
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		if (v < min) min = v;
		if (v > max) max = v;
		sum += v;
	}

	const mean = sum / data.length;

	/**
	 * 更新 DOM 元素显示。
	 *
	 * .textContent 设置元素的文本内容（不解析 HTML）。
	 * toLocaleString() 将数字格式化为本地化字符串（如 256,000 而不是 256000）。
	 * .toFixed(6) 保留 6 位小数（信号值通常是小数，需要精度）。
	 */
	document.getElementById('sampleCount').textContent = data.length.toLocaleString();
	document.getElementById('minValue').textContent = min.toFixed(6);
	document.getElementById('maxValue').textContent = max.toFixed(6);
	document.getElementById('meanValue').textContent = mean.toFixed(6);
}
