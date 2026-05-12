/*
 * ======================================================================
 * test_radar.cu - CUDA 版雷达信号生成测试程序
 * ======================================================================
 *
 * 本文件是 CUDA 版本的雷达信号测试程序，用于验证扩展对 cuda-gdb
 * 调试器的适配能力。
 *
 * 与 test_radar.cpp 的区别：
 *   - 信号生成逻辑运行在 GPU 上（__global__ kernel）。
 *   - 使用 cudaMalloc / cudaMemcpy 在主机和设备之间交换数据。
 *   - 主机端仍然保留 std::vector<float>，便于扩展在断点处识别信号。
 *
 * 调试断点策略：
 *   1. 主机端断点（推荐）：在 cudaMemcpy 之后的位置设置断点。
 *      此时 std::vector<float> 已经包含 GPU 计算的结果，
 *      扩展的 Radar Signals 面板会自动显示这些变量。
 *
 *   2. 设备端断点（进阶）：在 __global__ kernel 函数内部设置断点。
 *      cuda-gdb 会暂停在一个线程上，可以通过
 *        (cuda-gdb) cuda thread
 *      查看/切换当前 CUDA 线程。
 *
 * 编译方式（由 CMakeLists.txt 处理）：
 *   nvcc -G -g -O0 test_radar.cu -o test_radar_cuda
 *     -G : 生成 GPU 代码调试符号（必须，否则 device 断点不生效）
 *     -g : 生成 host 代码调试符号
 *     -O0: 关闭优化，保证源码与执行一致
 *
 * 调试方式：
 *   在 VSCode 中选择 "Debug CUDA with cuda-gdb" 配置启动。
 * ======================================================================
 */

#include <cmath>
#include <cstdio>
#include <cuda_runtime.h>
#include <iostream>
#include <vector>

/*
 * CUDA 错误检查宏。
 * 每次调用 CUDA API 后用此宏包裹，能及时捕获错误并输出文件/行号。
 */
#define CUDA_CHECK(call)                                                                \
    do {                                                                                \
        cudaError_t err__ = (call);                                                     \
        if (err__ != cudaSuccess) {                                                     \
            std::cerr << "CUDA error at " << __FILE__ << ":" << __LINE__ << " - "       \
                      << cudaGetErrorString(err__) << std::endl;                        \
            std::exit(1);                                                               \
        }                                                                               \
    } while (0)

/*
 * 设备端辅助函数：基于线程索引产生一个确定性的伪随机数。
 *
 * CUDA kernel 中不能使用 std::random_device / std::mt19937（host 库）。
 * 这里用一个简单的整数 hash 将线程索引映射到 [-1, 1] 区间，
 * 作为噪声信号。不需要随机性强度，只需"看上去像噪声"。
 *
 * __device__ 关键字表示此函数只能在 GPU 上调用，不能从 host 调用。
 */
__device__ float pseudoNoise(int idx) {
    unsigned int x = static_cast<unsigned int>(idx) * 2654435761u;  // Knuth 乘法 hash
    x ^= (x >> 16);
    x *= 2246822519u;
    x ^= (x >> 13);
    // 将 unsigned int 映射到 [-1, 1]
    return (static_cast<float>(x) / 4294967295.0f) * 2.0f - 1.0f;
}

/*
 * __global__ kernel：生成脉冲信号。
 *
 * __global__ 表示这是一个从 host 调用、在 device 上执行的函数（kernel）。
 * 每个 CUDA 线程计算输出数组中的一个元素：signal[tid]。
 *
 * 参数：
 *   signal : 设备端输出缓冲区（已在 host 端用 cudaMalloc 分配）
 *   size   : 数组长度
 */
__global__ void generatePulseKernel(float* signal, int size) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= size) return;

    float t = static_cast<float>(tid) / 100.0f;
    // 形状与 CPU 版本一致：高斯包络 × 正弦载波
    signal[tid] = expf(-0.1f * (t - 10.0f) * (t - 10.0f)) * sinf(2.0f * 3.14159265f * 0.5f * t);
}

/*
 * __global__ kernel：生成噪声信号。
 */
__global__ void generateNoiseKernel(float* signal, int size) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= size) return;
    // 振幅缩放到 0.5（与 CPU 版本保持一致：normal_distribution(0, 0.5)）
    signal[tid] = 0.5f * pseudoNoise(tid);
}

/*
 * __global__ kernel：生成线性调频（chirp）信号。
 */
__global__ void generateChirpKernel(float* signal, int size) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= size) return;

    float t = static_cast<float>(tid) / 100.0f;
    float freq = 0.1f + 0.05f * t;
    signal[tid] = sinf(2.0f * 3.14159265f * freq * t);
}

/*
 * __global__ kernel：将三种信号按权重混合。
 *
 * 这里演示 kernel 内部的多输入操作，同时也是一个合适的设备端断点位置。
 */
__global__ void mixSignalsKernel(const float* pulse,
                                 const float* noise,
                                 const float* chirp,
                                 float* mixed,
                                 int size) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= size) return;

    // 可以在这一行设置 device 断点，用 cuda-gdb 查看 tid 和各信号值
    mixed[tid] = pulse[tid] + 0.3f * noise[tid] + 0.5f * chirp[tid];
}

int main() {
    const int SIGNAL_SIZE = 256;
    const int BLOCK_SIZE = 128;
    const int GRID_SIZE = (SIGNAL_SIZE + BLOCK_SIZE - 1) / BLOCK_SIZE;

    /*
     * 主机端 vector（断点可视化目标）。
     * 扩展扫描断点所在作用域的变量时，会按名称模式匹配到这些变量。
     */
    std::vector<float> pulse_data(SIGNAL_SIZE);
    std::vector<float> noise_data(SIGNAL_SIZE);
    std::vector<float> chirp_signal(SIGNAL_SIZE);
    std::vector<float> mixed_signal(SIGNAL_SIZE);

    /*
     * 在 GPU 上为每种信号分配内存。
     * 共 4 个缓冲区，每个 SIGNAL_SIZE * sizeof(float) 字节。
     */
    float *d_pulse = nullptr, *d_noise = nullptr, *d_chirp = nullptr, *d_mixed = nullptr;
    size_t bytes = SIGNAL_SIZE * sizeof(float);
    CUDA_CHECK(cudaMalloc(&d_pulse, bytes));
    CUDA_CHECK(cudaMalloc(&d_noise, bytes));
    CUDA_CHECK(cudaMalloc(&d_chirp, bytes));
    CUDA_CHECK(cudaMalloc(&d_mixed, bytes));

    /*
     * 启动三个 kernel 分别生成 pulse / noise / chirp 信号。
     * <<<GRID_SIZE, BLOCK_SIZE>>> 是 CUDA 的 kernel 启动语法，
     * 表示启动 GRID_SIZE 个 block、每个 block BLOCK_SIZE 个线程。
     */
    generatePulseKernel<<<GRID_SIZE, BLOCK_SIZE>>>(d_pulse, SIGNAL_SIZE);
    generateNoiseKernel<<<GRID_SIZE, BLOCK_SIZE>>>(d_noise, SIGNAL_SIZE);
    generateChirpKernel<<<GRID_SIZE, BLOCK_SIZE>>>(d_chirp, SIGNAL_SIZE);

    /*
     * 启动混合 kernel。可以在这个 kernel 内部设置 device 断点，
     * 用 cuda-gdb 查看 tid、blockIdx 等信息。
     */
    mixSignalsKernel<<<GRID_SIZE, BLOCK_SIZE>>>(d_pulse, d_noise, d_chirp, d_mixed, SIGNAL_SIZE);

    // 等待所有 kernel 执行完毕
    CUDA_CHECK(cudaDeviceSynchronize());

    /*
     * 将 GPU 结果拷回 host 端的 vector。
     * 拷贝完成后，vector 内容已经是 GPU 计算结果。
     */
    CUDA_CHECK(cudaMemcpy(pulse_data.data(),   d_pulse, bytes, cudaMemcpyDeviceToHost));
    CUDA_CHECK(cudaMemcpy(noise_data.data(),   d_noise, bytes, cudaMemcpyDeviceToHost));
    CUDA_CHECK(cudaMemcpy(chirp_signal.data(), d_chirp, bytes, cudaMemcpyDeviceToHost));
    CUDA_CHECK(cudaMemcpy(mixed_signal.data(), d_mixed, bytes, cudaMemcpyDeviceToHost));

    /*
     * ==========================================================
     * 推荐断点位置（host 断点）：下一行的 std::cout。
     *
     * 在此处暂停时：
     *   - pulse_data / noise_data / chirp_signal / mixed_signal
     *     都是 std::vector<float>，已经填充了 GPU 计算结果。
     *   - 扩展的 Radar Signals 面板应当显示这四个变量。
     *   - 点击 "Visualize Signal" 可以在图表中查看波形。
     * ==========================================================
     */
    std::cout << "CUDA Radar Signal Processing Test" << std::endl;
    std::cout << "Generated " << SIGNAL_SIZE << " samples on GPU" << std::endl;

    std::cout << "First 5 samples of mixed signal: ";
    for (int i = 0; i < 5; i++) {
        std::cout << mixed_signal[i] << " ";
    }
    std::cout << std::endl;

    // 释放 GPU 内存
    cudaFree(d_pulse);
    cudaFree(d_noise);
    cudaFree(d_chirp);
    cudaFree(d_mixed);

    return 0;
}
