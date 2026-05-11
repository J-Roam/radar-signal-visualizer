cmake_minimum_required(VERSION 3.10)
project(RadarSignalTest)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0")

add_executable(test_radar test_radar.cpp)
target_compile_features(test_radar PRIVATE cxx_std_14)
