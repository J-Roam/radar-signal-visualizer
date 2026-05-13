/*
 * ======================================================================
 * test_radar.cu - 插件验证用最小信号生成
 * ======================================================================
 *
 * 目的：只生成两路最典型的雷达可视化信号，供插件 Pin + 绘图验证。
 *
 *   [1] sine_signal   std::vector<float>           —— 实数正弦
 *   [2] lfm_signal    std::vector<cuFloatComplex>  —— 复数线性调频 (LFM chirp)
 *
 * 参数设计思路（便于肉眼核对插件绘图是否正确）：
 *
 *   Sine（实数 plot kind: Magnitude）
 *     N  = 512 samples
 *     fs = 1 kHz
 *     f  = 50 Hz
 *     A  = 1.0
 *     → 1 秒内 50 个完整周期，512 个样本 ≈ 25.6 个周期，曲线均匀光滑。
 *
 *   LFM chirp（复数 plot kinds: Complex I/Q、Complex |z|）
 *     N  = 512 samples
 *     fs = 10 MHz                      （采样率）
 *     T  = N/fs ≈ 51.2 us              （脉冲时长）
 *     BW = 5 MHz                       （调频带宽）
 *     k  = BW/T                        （调频斜率）
 *     f0 = -BW/2 = -2.5 MHz            （起始频率，中心零频）
 *     s(t) = exp(j·2π(f0·t + 0.5·k·t²))
 *     → I(t) = cos(φ)，Q(t) = sin(φ)，瞬时频率随时间线性扫过
 *       [-2.5 MHz, +2.5 MHz]。
 *     → |z(t)| ≡ 1.0 （恒幅），是验证插件 "Complex |z|" 计算
 *       (sqrt(re²+im²)) 正确性的最稳指标——理想情况下是一条水平直线。
 *
 * 推荐调试流程：
 *   1) 在文件末尾标记 "// <<< 推荐断点" 的那行设置断点
 *   2) 启动 "Debug CUDA with cuda-gdb" 配置
 *   3) 命中后在 Variables 面板：
 *        • 右键 sine_signal → Pin To Visualizer
 *          → Table 三列 Index | Value，Chart 默认 Magnitude (line)
 *          → 应看到清晰的 50 Hz 正弦
 *        • 右键 lfm_signal → Pin To Visualizer
 *          → Table 三列 Index | I | Q，Chart 默认 Complex I/Q
 *          → 应看到 I (蓝) 与 Q (橙) 两条交叉扫频波形
 *          → 下拉切到 "Complex |z|" 应看到一条平直线，纵坐标 ≈ 1.0
 * ======================================================================
 */

#include <cmath>
#include <cstdio>
#include <cuda_runtime.h>
#include <cuComplex.h>
#include <iostream>
#include <vector>

#define CUDA_CHECK(call)                                                          \
    do {                                                                          \
        cudaError_t err__ = (call);                                               \
        if (err__ != cudaSuccess) {                                               \
            std::cerr << "CUDA error at " << __FILE__ << ":" << __LINE__ << " - " \
                      << cudaGetErrorString(err__) << std::endl;                  \
            std::exit(1);                                                         \
        }                                                                         \
    } while (0)

constexpr float PI = 3.14159265358979323846f;

/* ---------------------------------------------------------------------
 * Kernel 1: 生成实数正弦信号 s[n] = A * sin(2π f n / fs)
 * --------------------------------------------------------------------- */
__global__ void generateSineKernel(float* signal, int N, float fs, float freq, float amp) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= N) return;
    float t = static_cast<float>(tid) / fs;
    signal[tid] = amp * sinf(2.0f * PI * freq * t);
}

/* ---------------------------------------------------------------------
 * Kernel 2: 生成复数 LFM chirp 信号
 *   φ(t) = 2π (f0·t + 0.5·k·t²)
 *   s(t) = cos(φ) + j·sin(φ)
 * --------------------------------------------------------------------- */
__global__ void generateLfmChirpKernel(cuFloatComplex* signal, int N, float fs, float f0, float k) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= N) return;
    float t = static_cast<float>(tid) / fs;
    float phase = 2.0f * PI * (f0 * t + 0.5f * k * t * t);
    signal[tid] = make_cuFloatComplex(cosf(phase), sinf(phase));
}

int main() {
    // ---------------- 正弦信号参数 ----------------
    const int   SINE_N  = 512;
    const float SINE_FS = 1000.0f;   // 1 kHz 采样率
    const float SINE_F  = 50.0f;     // 50 Hz
    const float SINE_A  = 1.0f;

    // ---------------- LFM 复数信号参数 ----------------
    const int   LFM_N  = 512;
    const float LFM_FS = 10.0e6f;              // 10 MHz 采样率
    const float LFM_BW = 5.0e6f;               // 5 MHz 带宽
    const float LFM_T  = static_cast<float>(LFM_N) / LFM_FS;  // ≈ 51.2 us
    const float LFM_K  = LFM_BW / LFM_T;       // 调频斜率
    const float LFM_F0 = -LFM_BW / 2.0f;       // 起始频率（中心零频）

    // ---------------- Host 可视化目标 ----------------
    std::vector<float>          sine_signal(SINE_N);
    std::vector<cuFloatComplex> lfm_signal(LFM_N);

    // ---------------- Device 缓冲区 ----------------
    float*          d_sine = nullptr;
    cuFloatComplex* d_lfm  = nullptr;
    CUDA_CHECK(cudaMalloc(&d_sine, SINE_N * sizeof(float)));
    CUDA_CHECK(cudaMalloc(&d_lfm,  LFM_N  * sizeof(cuFloatComplex)));

    // ---------------- Kernel 启动 ----------------
    const int BLOCK = 128;
    generateSineKernel<<<(SINE_N + BLOCK - 1) / BLOCK, BLOCK>>>(d_sine, SINE_N, SINE_FS, SINE_F, SINE_A);
    generateLfmChirpKernel<<<(LFM_N + BLOCK - 1) / BLOCK, BLOCK>>>(d_lfm, LFM_N, LFM_FS, LFM_F0, LFM_K);
    CUDA_CHECK(cudaDeviceSynchronize());

    // ---------------- 拷回 host ----------------
    CUDA_CHECK(cudaMemcpy(sine_signal.data(), d_sine, SINE_N * sizeof(float),          cudaMemcpyDeviceToHost));
    CUDA_CHECK(cudaMemcpy(lfm_signal.data(),  d_lfm,  LFM_N  * sizeof(cuFloatComplex), cudaMemcpyDeviceToHost));

    // ======================================================
    // <<< 推荐断点：下一行 std::cout
    //     此时 sine_signal 与 lfm_signal 均已填充数据，
    //     可在 Variables 面板右键 Pin 到插件进行可视化验证。
    // ======================================================
    std::cout << "Sine : N=" << SINE_N << " fs=" << SINE_FS << "Hz freq=" << SINE_F
              << "Hz amp=" << SINE_A << std::endl;
    std::cout << "LFM  : N=" << LFM_N  << " fs=" << LFM_FS  << "Hz BW="   << LFM_BW
              << "Hz f0=" << LFM_F0 << "Hz k=" << LFM_K << "Hz/s" << std::endl;

    std::cout << "sine_signal[0..4]: ";
    for (int i = 0; i < 5; ++i) std::cout << sine_signal[i] << " ";
    std::cout << std::endl;

    std::cout << "lfm_signal[0..2]: ";
    for (int i = 0; i < 3; ++i) {
        std::cout << "(" << lfm_signal[i].x << "," << lfm_signal[i].y << ") ";
    }
    std::cout << std::endl;

    cudaFree(d_sine);
    cudaFree(d_lfm);
    return 0;
}
