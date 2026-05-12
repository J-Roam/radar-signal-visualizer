#!/bin/bash
# ======================================================================
# build.sh - 一键构建脚本
# ======================================================================
#
# 构建产物（均为 Debug 构建，带调试符号）：
#   build/test_radar        - C++ 版本（用 GDB 调试）
#   build/test_radar_cuda   - CUDA 版本（用 cuda-gdb 调试，需要 nvcc）
#
# 若系统未安装 CUDA，CMake 会自动跳过 CUDA 版本，不会导致构建失败。
# ======================================================================

set -e

# 创建构建目录
mkdir -p build
cd build

# 使用 cmake 构建（Debug 模式，带调试符号）
cmake -DCMAKE_BUILD_TYPE=Debug ..
make

echo ""
echo "Build complete."
if [ -x ./test_radar ]; then
    echo "  CPU  binary: build/test_radar"
fi
if [ -x ./test_radar_cuda ]; then
    echo "  CUDA binary: build/test_radar_cuda"
fi
