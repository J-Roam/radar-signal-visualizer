# ======================================================================
# CMakeLists.txt - 测试程序构建脚本
# ======================================================================
#
# 同时构建两个可执行文件：
#   test_radar        - 基于 C++ / std::vector 的 CPU 版本（GDB 调试）
#   test_radar_cuda   - 基于 CUDA 的 GPU 版本（cuda-gdb 调试）
#
# 如果系统没有 CUDA 工具链（未安装 nvcc 或没有 NVIDIA GPU），
# 只会构建 CPU 版本，CUDA 版本会被自动跳过，保证脚本不失败。
#
# 构建命令（带调试符号）：
#   mkdir -p build && cd build
#   cmake -DCMAKE_BUILD_TYPE=Debug ..
#   make
# ======================================================================

cmake_minimum_required(VERSION 3.18)
project(RadarSignalTest LANGUAGES CXX)

# 默认使用 Debug 构建类型，保证带调试符号
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "Build type" FORCE)
endif()

# --------- C++ 版本 ---------
set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0")

add_executable(test_radar test_radar.cpp)
target_compile_features(test_radar PRIVATE cxx_std_14)

# --------- CUDA 版本（可选） ---------
# CheckLanguage 模块允许我们"探测"CUDA 是否可用而不立即失败
include(CheckLanguage)
check_language(CUDA)

if(CMAKE_CUDA_COMPILER)
    message(STATUS "CUDA compiler found: ${CMAKE_CUDA_COMPILER}")
    enable_language(CUDA)

    set(CMAKE_CUDA_STANDARD 14)
    set(CMAKE_CUDA_STANDARD_REQUIRED ON)

    # -G 生成 device 调试符号（允许 cuda-gdb 在 kernel 内断点）
    # -g 生成 host 调试符号
    # -O0 禁用优化，避免变量被优化掉
    set(CMAKE_CUDA_FLAGS_DEBUG "-G -g -O0")

    # 允许用户通过 -DCMAKE_CUDA_ARCHITECTURES=xx 指定目标架构；
    # 默认使用 "native" 让 nvcc 自动匹配当前 GPU（CMake 3.24+ 支持）。
    # 若使用旧 CMake，可退化为一个常见的架构列表。
    if(NOT CMAKE_CUDA_ARCHITECTURES)
        if(CMAKE_VERSION VERSION_GREATER_EQUAL "3.24")
            set(CMAKE_CUDA_ARCHITECTURES native)
        else()
            set(CMAKE_CUDA_ARCHITECTURES 75)  # Turing，常见的默认值
        endif()
    endif()

    add_executable(test_radar_cuda test_radar.cu)
    set_target_properties(test_radar_cuda PROPERTIES
        CUDA_SEPARABLE_COMPILATION ON
    )
else()
    message(WARNING "CUDA compiler not found. Skipping test_radar_cuda build.")
endif()
