#!/bin/bash

# 创建构建目录
mkdir -p build
cd build

# 使用cmake构建
cmake ..
make

echo "Build complete. Executable is in: build/test_radar"
