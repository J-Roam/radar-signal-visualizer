/**
 * ======================================================================
 * types.ts - 类型定义文件
 * ======================================================================
 *
 * 本文件定义扩展中使用的所有接口（Interface）。
 * 在 TypeScript 中，接口用于描述对象的结构（有哪些属性、什么类型）。
 *
 * TypeScript 是静态类型语言，与 JavaScript（动态类型）不同：
 *   - JavaScript: 变量可以在运行时改变类型（如 var x = 1; x = "hello";）。
 *   - TypeScript: 编译时检查类型，变量声明后不能随意更改类型。
 *
 * 接口的好处：
 *   1. 代码补全：IDE 知道对象的属性，自动提示。
 *   2. 类型安全：编译时发现属性拼写错误、类型不匹配等问题。
 *   3. 文档：接口本身就是代码的文档，说明数据结构。
 *
 * ======================================================================
 */

/**
 * SignalVariable - 信号变量接口。
 *
 * 定义树视图中每个节点（信号变量）的数据结构。
 * 这个接口与 VSCode 的 TreeDataProvider<SignalVariable> 配合使用。
 *
 * 字段说明：
 *   - name: 变量名（如 "pulse_data"）。
 *     来源：GDB 返回的变量信息中的 name 字段。
 *
 *   - value: 变量的值（如 "std::vector of length 256, capacity 256"）。
 *     来源：GDB pretty-print 后的显示字符串，不是实际数值。
 *     这个值用于：
 *       - 判断是否是数组（包含 "[0]" 或 "array"）。
 *       - 提取数组大小（如 "length 256" → 256）。
 *       - 显示在树节点的 tooltip 中。
 *
 *   - type: 变量的 C++ 类型（如 "std::vector<float>"）。
 *     来源：GDB 返回的变量类型信息。
 *     显示在树节点的 description（右侧灰色文字）。
 *
 *   - variablesReference: DAP 变量引用 ID。
 *     这是 DAP（Debug Adapter Protocol）中的核心概念：
 *       - 0: 变量是简单类型（如 int、float），value 就是最终值。
 *       - > 0: 变量是复合类型（数组、结构体、类），需要再次发送
 *              "variables" 请求并用这个 ID 获取子元素。
 *     示例：std::vector<float> 的 variablesReference 可能是 100，
 *           用这个 ID 发请求可以获取 [0], [1], [2], ... 等元素。
 *
 *   - children: 是否有子节点（用于树视图的折叠状态）。
 *     由 variablesReference > 0 推导而来。
 *     true → 显示折叠图标，用户可以展开。
 *     false → 叶子节点，不可展开。
 *
 * 注意：这个接口中的 value 和 type 都是字符串（GDB 返回的文本），
 *       而 data 字段（用于绘图的实际数值）是在 getVariableData() 中单独获取的。
 *       这是为了分离"元数据"（变量名、类型、引用）和"实际数据"（数值数组）。
 */
export interface SignalVariable {
	name: string;               // 变量名
	value: string;              // GDB 显示的值（字符串形式）
	type: string;               // 变量的 C++ 类型
	variablesReference: number; // DAP 变量引用 ID（保留仅供 VSCode 面板/识别用，插件不再主动消耗）
	children: boolean;          // 是否有子节点（树视图折叠状态）
}

/**
 * SignalData - 信号数据接口。
 *
 * 用于表示一个完整的信号数据集，包含：
 *   - name: 信号变量名（用于图表标题显示）。
 *   - data: 实际数值数组（用于绘图）。
 *   - type: 变量类型（可选，用于调试信息）。
 *
 * 这个接口目前主要用于 Webview 通信时的数据结构。
 * 当扩展向 Webview 发送 plotSignal 消息时，传递的就是这种格式：
 *   {
 *     command: 'plotSignal',
 *     variable: {
 *       name: 'pulse_data',
 *       type: 'std::vector<float>',
 *       data: [0.1, 0.2, 0.3, ...]
 *     }
 *   }
 *
 * 与 SignalVariable 的区别：
 *   - SignalVariable: 描述变量的"元数据"（从 DAP 直接获取）。
 *   - SignalData: 描述变量的"实际数据"（通过递归获取所有子元素的值）。
 */
export interface SignalData {
	name: string;      // 信号名称
	data: number[];    // 数值数组（用于绘图）
	type: string;      // 变量类型
}
