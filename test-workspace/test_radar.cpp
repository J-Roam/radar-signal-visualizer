#include <cmath>
#include <iostream>
#include <random>
#include <vector>

// 生成测试信号数据
void generatePulseSignal(std::vector<float>& signal, int size) {
    for (int i = 0; i < size; i++) {
        float t = static_cast<float>(i) / 100.0f;
        // 生成一个脉冲信号
        signal[i] = std::exp(-0.1f * (t - 10.0f) * (t - 10.0f)) * std::sin(2.0f * M_PI * 0.5f * t);
    }
}

void generateNoiseSignal(std::vector<float>& signal, int size) {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::normal_distribution<float> dist(0.0f, 0.5f);

    for (int i = 0; i < size; i++) {
        signal[i] = dist(gen);
    }
}

void generateChirpSignal(std::vector<float>& signal, int size) {
    for (int i = 0; i < size; i++) {
        float t = static_cast<float>(i) / 100.0f;
        // 生成线性调频信号
        float freq = 0.1f + 0.05f * t;
        signal[i] = std::sin(2.0f * M_PI * freq * t);
    }
}

int main() {
    const int SIGNAL_SIZE = 256;

    std::vector<float> pulse_data(SIGNAL_SIZE);
    std::vector<float> noise_data(SIGNAL_SIZE);
    std::vector<float> chirp_signal(SIGNAL_SIZE);

    generatePulseSignal(pulse_data, SIGNAL_SIZE);
    generateNoiseSignal(noise_data, SIGNAL_SIZE);
    generateChirpSignal(chirp_signal, SIGNAL_SIZE);

    // 混合信号
    std::vector<float> mixed_signal(SIGNAL_SIZE);
    for (int i = 0; i < SIGNAL_SIZE; i++) {
        // mixed_signal[i] = pulse_data[i] + 0.3f * noise_data[i];
        mixed_signal[i] = i;
    }

    std::cout << "Radar Signal Processing Test" << std::endl;
    std::cout << "Generated " << SIGNAL_SIZE << " samples" << std::endl;

    // 这里设置断点进行调试
    std::cout << "First 5 samples of mixed signal: ";
    for (int i = 0; i < 5; i++) {
        std::cout << mixed_signal[i] << " ";
    }
    std::cout << std::endl;

    return 0;
}
