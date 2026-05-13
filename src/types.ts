/**
 * ======================================================================
 * types.ts - 类型定义文件
 * ======================================================================
 *
 * 本文件定义扩展中使用的所有接口。重构后采用"手动 Pin + readMemory 裸字节
 * 解码"的数据通路，不再依赖 DAP variables 子树自动展开。
 *
 * ======================================================================
 */

/**
 * 容器种类。决定 readSignalBytes 走哪条路径取指针与大小。
 *   - stl: std::vector / std::array / std::deque 等，走 _M_impl._M_start 私有字段
 *   - array: 原生数组如 float[N]，取 &(name[0])
 *   - pointer: 裸指针如 float*，直接用 name，需要 sizeHint
 */
export type ContainerKind = 'stl' | 'array' | 'pointer';

/**
 * PinnedVariable - 已 Pin 到可视化插件的变量描述。
 *
 * 用户在 VSCode Variables 面板右键 "Pin to Radar Signal Visualizer" 时
 * 由 pinFromContext 构造并入队。每个 Pin 都是独立的卡片。
 */
export interface PinnedVariable {
	id: string;                    // 唯一 ID，UI 卡片 DOM 复用依据
	evaluateName: string;          // GDB 可 evaluate 的完整表达式（含作用域）
	displayName: string;           // 用户看到的短名字
	type: string;                  // 原始 C++ 类型文本
	containerKind: ContainerKind;  // 容器种类
	elementType: string;           // 元素类型，如 float / int32_t / cuFloatComplex
	bytesPerElement: number;       // 单元素字节数（复数类型按一个完整复数计，如 cuFloatComplex = 8）
	isComplex: boolean;            // 元素是否为复数（cuFloatComplex / std::complex<*>）
	sizeHint?: number;             // 非 stl 必填，stl 在 readSignalBytes 时动态获取
	lastData?: number[];           // 实数：值；复数：实部 re
	lastDataIm?: number[];         // 复数：虚部 im（实数时为 undefined）
	lastError?: string;            // 上一次错误文本，用于卡片错误态
	lastUpdatedMs?: number;        // 上一次刷新时间戳
}

/**
 * CardPayload - 发给 webview 的单卡片负载。
 *
 * 由 extension 端在 syncAllCards / updateCard 消息中填充。
 * webview 仅消费此结构，不感知 PinnedVariable 内部字段。
 */
export interface CardPayload {
	id: string;          // 与 PinnedVariable.id 一致，DOM 复用键
	displayName: string; // 标题
	type: string;        // 副标题元信息
	elementType: string; // 元素类型文本，用于卡片 meta 行显示
	isComplex: boolean;  // 是否复数；webview 据此决定 plot kind 可用集
	data: number[];      // 实数：值；复数：实部 re；error 态可为空
	dataIm?: number[];   // 复数：虚部 im；实数时缺省
	error?: string;      // 错误文本；非空表示此卡片渲染为错误态
	pageSize: number;    // Table 每页行数
}
