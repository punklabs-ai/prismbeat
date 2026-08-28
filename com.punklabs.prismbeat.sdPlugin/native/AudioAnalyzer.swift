import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

private let fftSize = 8_192
private let bandCount = 40
private let sampleRate = 48_000.0
private let waveformPointCount = 256
private let waveformWindowSize = 1_536
private let stereoPointCount = 256
private let stereoWindowSize = 2_048
private let pitchClassCount = 12

private final class SpotifyAudioAnalyzer: NSObject, SCStreamOutput, SCStreamDelegate {
    private let audioQueue = DispatchQueue(label: "com.punklabs.prismbeat.audio")
    private var stream: SCStream?
    private var sampleWindow = [Double]()
    private var leftSampleWindow = [Double]()
    private var rightSampleWindow = [Double]()
    private var samplesSinceAnalysis = 0
    private var smoothedBands = Array(repeating: 0.0, count: bandCount)
    private var smoothedChroma = Array(repeating: 0.0, count: pitchClassCount)
    private var bassEnvelope = 0.0
    private var waveformGain = 1.0
    private var stereoGain = 1.0

    func runSelfTest() {
        let leftSamples = (0..<fftSize).map { index -> Double in
            let time = Double(index) / sampleRate
            return sin(2.0 * Double.pi * 90.0 * time) * 0.42
                + sin(2.0 * Double.pi * 880.0 * time) * 0.3
                + sin(2.0 * Double.pi * 7_000.0 * time) * 0.18
        }
        let rightSamples = (0..<fftSize).map { index -> Double in
            let time = Double(index) / sampleRate
            return sin(2.0 * Double.pi * 90.0 * time + 0.18) * 0.42
                + sin(2.0 * Double.pi * 880.0 * time + 1.05) * 0.3
                + sin(2.0 * Double.pi * 7_000.0 * time + 0.62) * 0.18
        }
        let samples = zip(leftSamples, rightSamples).map { ($0 + $1) / 2.0 }
        analyse(samples, leftSamples: leftSamples, rightSamples: rightSamples)
    }

    func runToneTest(frequency: Double) {
        let samples = (0..<fftSize).map { index -> Double in
            let time = Double(index) / sampleRate
            return sin(2.0 * Double.pi * frequency * time) * 0.65
        }
        analyse(samples, leftSamples: samples, rightSamples: samples)
    }

    func runStereoTest() {
        let leftSamples = (0..<fftSize).map { index -> Double in
            let time = Double(index) / sampleRate
            return sin(2.0 * Double.pi * 440.0 * time) * 0.62
        }
        let rightSamples = (0..<fftSize).map { index -> Double in
            let time = Double(index) / sampleRate
            return sin(2.0 * Double.pi * 440.0 * time + Double.pi / 2.0) * 0.52
                + sin(2.0 * Double.pi * 659.255 * time) * 0.16
        }
        let samples = zip(leftSamples, rightSamples).map { ($0 + $1) / 2.0 }
        analyse(samples, leftSamples: leftSamples, rightSamples: rightSamples)
    }

    func runBalancedBandTest() {
        var samples = Array(repeating: 0.0, count: fftSize)
        let minimumFrequency = 45.0
        let maximumFrequency = 16_000.0
        for band in 0..<bandCount {
            let centreRatio = (Double(band) + 0.5) / Double(bandCount)
            let centreFrequency = minimumFrequency * pow(
                maximumFrequency / minimumFrequency,
                centreRatio
            )
            let fftBin = max(1, Int((centreFrequency * Double(fftSize) / sampleRate).rounded()))
            let binCentredFrequency = Double(fftBin) * sampleRate / Double(fftSize)
            let phase = Double(band) * 2.399963
            for index in 0..<fftSize {
                let time = Double(index) / sampleRate
                samples[index] += sin(2.0 * Double.pi * binCentredFrequency * time + phase) * 0.025
            }
        }
        analyse(samples, leftSamples: samples, rightSamples: samples)
    }

    func start() async throws {
        if !CGPreflightScreenCaptureAccess(), !CGRequestScreenCaptureAccess() {
            throw AnalyzerError.screenRecordingPermission
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: false
        )

        guard let display = content.displays.first else {
            throw AnalyzerError.noDisplay
        }

        let spotifyApplications = content.applications.filter {
            $0.bundleIdentifier == "com.spotify.client"
        }
        guard !spotifyApplications.isEmpty else {
            throw AnalyzerError.spotifyNotRunning
        }
        let filter = SCContentFilter(
            display: display,
            including: spotifyApplications,
            exceptingWindows: []
        )

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = Int(sampleRate)
        configuration.channelCount = 2
        configuration.width = 2
        configuration.height = 2
        configuration.queueDepth = 3

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        try await stream.startCapture()
        self.stream = stream
        emit(["status": "ready"])
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio, sampleBuffer.isValid else { return }
        appendSamples(from: sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        emitError("Audio capture stopped: \(error.localizedDescription)", code: "capture_stopped")
        exit(2)
    }

    private func appendSamples(from sampleBuffer: CMSampleBuffer) {
        guard let formatDescription = sampleBuffer.formatDescription,
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else { return }

        let maximumBuffers = max(1, Int(description.pointee.mChannelsPerFrame))
        let audioBufferList = AudioBufferList.allocate(maximumBuffers: maximumBuffers)
        defer { free(audioBufferList.unsafeMutablePointer) }

        var retainedBlockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: maximumBuffers),
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard status == noErr else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList.unsafeMutablePointer)
        let frameCount = sampleBuffer.numSamples
        let channelCount = max(1, Int(description.pointee.mChannelsPerFrame))
        let isFloat = description.pointee.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let isNonInterleaved = description.pointee.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let bitsPerChannel = Int(description.pointee.mBitsPerChannel)

        guard isFloat, bitsPerChannel == 32 else { return }

        if isNonInterleaved {
            for frame in 0..<frameCount {
                var mono = 0.0
                var channelsRead = 0
                var left = 0.0
                var right = 0.0
                for (channel, buffer) in buffers.enumerated() {
                    guard let data = buffer.mData else { continue }
                    let samples = data.assumingMemoryBound(to: Float.self)
                    let sample = Double(samples[frame])
                    if channel == 0 { left = sample }
                    if channel == 1 { right = sample }
                    mono += sample
                    channelsRead += 1
                }
                if channelsRead > 0 {
                    if channelsRead == 1 { right = left }
                    sampleWindow.append(mono / Double(channelsRead))
                    leftSampleWindow.append(left)
                    rightSampleWindow.append(right)
                }
            }
        } else if let data = buffers.first?.mData {
            let samples = data.assumingMemoryBound(to: Float.self)
            for frame in 0..<frameCount {
                var mono = 0.0
                for channel in 0..<channelCount {
                    mono += Double(samples[frame * channelCount + channel])
                }
                sampleWindow.append(mono / Double(channelCount))
                let left = Double(samples[frame * channelCount])
                let right = channelCount > 1
                    ? Double(samples[frame * channelCount + 1])
                    : left
                leftSampleWindow.append(left)
                rightSampleWindow.append(right)
            }
        }

        samplesSinceAnalysis += frameCount
        if sampleWindow.count > fftSize * 3 {
            let samplesToRemove = sampleWindow.count - fftSize * 2
            sampleWindow.removeFirst(samplesToRemove)
            leftSampleWindow.removeFirst(min(samplesToRemove, leftSampleWindow.count))
            rightSampleWindow.removeFirst(min(samplesToRemove, rightSampleWindow.count))
        }
        guard sampleWindow.count >= fftSize,
              leftSampleWindow.count >= fftSize,
              rightSampleWindow.count >= fftSize,
              samplesSinceAnalysis >= 2_048
        else { return }
        samplesSinceAnalysis = 0
        analyse(
            Array(sampleWindow.suffix(fftSize)),
            leftSamples: Array(leftSampleWindow.suffix(fftSize)),
            rightSamples: Array(rightSampleWindow.suffix(fftSize))
        )
    }

    private func analyse(
        _ samples: [Double],
        leftSamples: [Double],
        rightSamples: [Double]
    ) {
        var real = Array(repeating: 0.0, count: fftSize)
        var imaginary = Array(repeating: 0.0, count: fftSize)
        var sumSquares = 0.0
        var absolutePeak = 0.0

        for index in 0..<fftSize {
            let sample = samples[index]
            let window = 0.5 - 0.5 * cos(2.0 * Double.pi * Double(index) / Double(fftSize - 1))
            real[index] = sample * window
            sumSquares += sample * sample
            absolutePeak = max(absolutePeak, abs(sample))
        }

        fft(real: &real, imaginary: &imaginary)

        var nextBands = Array(repeating: 0.0, count: bandCount)
        let minimumFrequency = 45.0
        let maximumFrequency = 16_000.0
        for band in 0..<bandCount {
            let lowRatio = Double(band) / Double(bandCount)
            let highRatio = Double(band + 1) / Double(bandCount)
            let lowFrequency = minimumFrequency * pow(maximumFrequency / minimumFrequency, lowRatio)
            let highFrequency = minimumFrequency * pow(maximumFrequency / minimumFrequency, highRatio)
            let lowBin = max(1, Int(floor(lowFrequency * Double(fftSize) / sampleRate)))
            let highBin = min(fftSize / 2 - 1, max(lowBin, Int(ceil(highFrequency * Double(fftSize) / sampleRate))))
            var bandPower = 0.0
            for bin in lowBin...highBin {
                let magnitude = hypot(real[bin], imaginary[bin]) * 2.0 / Double(fftSize)
                bandPower += magnitude * magnitude
            }
            let magnitude = sqrt(bandPower)
            let decibels = 20.0 * log10(max(1e-9, magnitude))
            let normalized = clamp((decibels + 72.0) / 62.0)
            let response = normalized > smoothedBands[band] ? 0.78 : 0.24
            smoothedBands[band] += (normalized - smoothedBands[band]) * response
            nextBands[band] = smoothedBands[band]
        }

        let rms = sqrt(sumSquares / Double(fftSize))
        let loudness = clamp((20.0 * log10(max(1e-9, rms)) + 60.0) / 54.0)
        let bass = spectralEnergy(nextBands, range: 0..<14)
        let mid = spectralEnergy(nextBands, range: 14..<29)
        let treble = spectralEnergy(nextBands, range: 29..<bandCount)
        bassEnvelope = bassEnvelope * 0.92 + bass * 0.08
        let beat = clamp((bass - bassEnvelope) * 5.5)

        let waveform = triggeredWaveform(from: samples)
        let stereo = stereoScope(leftSamples: leftSamples, rightSamples: rightSamples)
        let chroma = pitchClassEnergy(real: real, imaginary: imaginary, loudness: loudness)

        emit([
            "bands": nextBands.map { rounded($0) },
            "waveform": waveform.map { rounded($0) },
            "stereoLeft": stereo.left.map { rounded($0) },
            "stereoRight": stereo.right.map { rounded($0) },
            "stereoCorrelation": rounded(stereo.correlation),
            "chroma": chroma.map { rounded($0) },
            "rms": rounded(loudness),
            "peak": rounded(clamp(absolutePeak)),
            "bass": rounded(bass),
            "mid": rounded(mid),
            "treble": rounded(treble),
            "beat": rounded(beat),
        ])
    }

    private func stereoScope(
        leftSamples: [Double],
        rightSamples: [Double]
    ) -> (left: [Double], right: [Double], correlation: Double) {
        guard leftSamples.count >= stereoWindowSize, rightSamples.count >= stereoWindowSize else {
            return (
                Array(repeating: 0.0, count: stereoPointCount),
                Array(repeating: 0.0, count: stereoPointCount),
                0.0
            )
        }

        let leftWindow = Array(leftSamples.suffix(stereoWindowSize))
        let rightWindow = Array(rightSamples.suffix(stereoWindowSize))
        let leftMean = leftWindow.reduce(0.0, +) / Double(stereoWindowSize)
        let rightMean = rightWindow.reduce(0.0, +) / Double(stereoWindowSize)
        let centredLeft = leftWindow.map { $0 - leftMean }
        let centredRight = rightWindow.map { $0 - rightMean }
        let referenceSamples = zip(centredLeft, centredRight)
            .map { max(abs($0), abs($1)) }
            .sorted()
        let percentileIndex = min(
            referenceSamples.count - 1,
            Int(Double(referenceSamples.count - 1) * 0.97)
        )
        let referenceLevel = referenceSamples[percentileIndex]
        guard referenceLevel >= 0.000_5 else {
            return (
                Array(repeating: 0.0, count: stereoPointCount),
                Array(repeating: 0.0, count: stereoPointCount),
                0.0
            )
        }

        let targetGain = max(0.65, min(14.0, 0.88 / referenceLevel))
        let gainResponse = targetGain < stereoGain ? 0.72 : 0.16
        stereoGain += (targetGain - stereoGain) * gainResponse

        let samplesPerPoint = stereoWindowSize / stereoPointCount
        var left = Array(repeating: 0.0, count: stereoPointCount)
        var right = Array(repeating: 0.0, count: stereoPointCount)
        for point in 0..<stereoPointCount {
            let start = point * samplesPerPoint
            let end = min(stereoWindowSize, start + samplesPerPoint)
            left[point] = max(
                -1.0,
                min(1.0, centredLeft[start..<end].reduce(0.0, +) / Double(end - start) * stereoGain)
            )
            right[point] = max(
                -1.0,
                min(1.0, centredRight[start..<end].reduce(0.0, +) / Double(end - start) * stereoGain)
            )
        }

        var cross = 0.0
        var leftPower = 0.0
        var rightPower = 0.0
        for index in 0..<stereoWindowSize {
            cross += centredLeft[index] * centredRight[index]
            leftPower += centredLeft[index] * centredLeft[index]
            rightPower += centredRight[index] * centredRight[index]
        }
        let denominator = sqrt(leftPower * rightPower)
        let correlation = denominator > 1e-12
            ? max(-1.0, min(1.0, cross / denominator))
            : 0.0
        return (left, right, correlation)
    }

    private func pitchClassEnergy(
        real: [Double],
        imaginary: [Double],
        loudness: Double
    ) -> [Double] {
        var powers = Array(repeating: 0.0, count: pitchClassCount)
        let minimumFrequency = 65.406
        let maximumFrequency = 4_186.009
        let lowBin = max(1, Int(ceil(minimumFrequency * Double(fftSize) / sampleRate)))
        let highBin = min(
            fftSize / 2 - 1,
            Int(floor(maximumFrequency * Double(fftSize) / sampleRate))
        )

        if lowBin <= highBin {
            for bin in lowBin...highBin {
                let frequency = Double(bin) * sampleRate / Double(fftSize)
                let midiNote = 69.0 + 12.0 * log2(frequency / 440.0)
                let nearestNote = midiNote.rounded()
                let distance = midiNote - nearestNote
                let tuningWeight = exp(-0.5 * pow(distance / 0.32, 2.0))
                let note = Int(nearestNote)
                let pitchClass = ((note % pitchClassCount) + pitchClassCount) % pitchClassCount
                let magnitude = hypot(real[bin], imaginary[bin]) * 2.0 / Double(fftSize)
                let octaveWeight = 1.0 / sqrt(max(1.0, frequency / minimumFrequency))
                powers[pitchClass] += magnitude * magnitude * tuningWeight * octaveWeight
            }
        }

        let maximumPower = powers.max() ?? 0.0
        let loudnessGate = clamp((loudness - 0.04) / 0.42)
        for pitchClass in 0..<pitchClassCount {
            let relative = maximumPower > 1e-12
                ? pow(powers[pitchClass] / maximumPower, 0.38) * loudnessGate
                : 0.0
            let response = relative > smoothedChroma[pitchClass] ? 0.74 : 0.2
            smoothedChroma[pitchClass] += (relative - smoothedChroma[pitchClass]) * response
        }
        return smoothedChroma
    }

    private func triggeredWaveform(from samples: [Double]) -> [Double] {
        guard samples.count >= waveformWindowSize else {
            return Array(repeating: 0.0, count: waveformPointCount)
        }

        // Keep the trace current, but start it at the most recent rising zero
        // crossing. This is the audio equivalent of an oscilloscope trigger and
        // prevents each frame from beginning at an arbitrary phase.
        let latestStart = samples.count - waveformWindowSize
        let searchStart = max(1, latestStart - 2_048)
        var triggerStart = latestStart
        if searchStart <= latestStart {
            for index in stride(from: latestStart, through: searchStart, by: -1) {
                if samples[index - 1] <= 0, samples[index] > 0 {
                    triggerStart = index - 1
                    break
                }
            }
        }

        let rawWindow = Array(samples[triggerStart..<(triggerStart + waveformWindowSize)])
        let absoluteSamples = rawWindow.map(abs).sorted()
        let percentileIndex = min(
            absoluteSamples.count - 1,
            Int(Double(absoluteSamples.count - 1) * 0.96)
        )
        let referenceLevel = absoluteSamples[percentileIndex]
        if referenceLevel < 0.000_5 {
            return Array(repeating: 0.0, count: waveformPointCount)
        }

        // A percentile-based gain keeps quiet tracks visible without letting a
        // single transient flatten the rest of the waveform. Gain drops quickly
        // to prevent clipping and rises more slowly to avoid visible pumping.
        let targetGain = max(0.65, min(16.0, 0.82 / referenceLevel))
        let gainResponse = targetGain < waveformGain ? 0.72 : 0.16
        waveformGain += (targetGain - waveformGain) * gainResponse

        let samplesPerPoint = waveformWindowSize / waveformPointCount
        return (0..<waveformPointCount).map { point -> Double in
            let start = point * samplesPerPoint
            let end = min(rawWindow.count, start + samplesPerPoint)
            let averaged = rawWindow[start..<end].reduce(0.0, +) / Double(end - start)
            return max(-1.0, min(1.0, averaged * waveformGain))
        }
    }
}

private enum AnalyzerError: LocalizedError {
    case noDisplay
    case screenRecordingPermission
    case spotifyNotRunning

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display is available for Spotify audio capture."
        case .screenRecordingPermission: return "Screen Recording permission is required."
        case .spotifyNotRunning: return "Spotify is not running."
        }
    }

    var code: String {
        switch self {
        case .noDisplay: return "no_display"
        case .screenRecordingPermission: return "permission"
        case .spotifyNotRunning: return "spotify_not_running"
        }
    }
}

private func fft(real: inout [Double], imaginary: inout [Double]) {
    let count = real.count
    var target = 0
    for index in 1..<count {
        var bit = count >> 1
        while target & bit != 0 {
            target ^= bit
            bit >>= 1
        }
        target ^= bit
        if index < target {
            real.swapAt(index, target)
            imaginary.swapAt(index, target)
        }
    }

    var length = 2
    while length <= count {
        let angle = -2.0 * Double.pi / Double(length)
        let baseReal = cos(angle)
        let baseImaginary = sin(angle)
        for start in stride(from: 0, to: count, by: length) {
            var phaseReal = 1.0
            var phaseImaginary = 0.0
            for offset in 0..<(length / 2) {
                let even = start + offset
                let odd = even + length / 2
                let oddReal = real[odd] * phaseReal - imaginary[odd] * phaseImaginary
                let oddImaginary = real[odd] * phaseImaginary + imaginary[odd] * phaseReal
                real[odd] = real[even] - oddReal
                imaginary[odd] = imaginary[even] - oddImaginary
                real[even] += oddReal
                imaginary[even] += oddImaginary
                let nextReal = phaseReal * baseReal - phaseImaginary * baseImaginary
                phaseImaginary = phaseReal * baseImaginary + phaseImaginary * baseReal
                phaseReal = nextReal
            }
        }
        length <<= 1
    }
}

private func average(_ values: [Double], range: Range<Int>) -> Double {
    guard !range.isEmpty else { return 0 }
    return values[range].reduce(0, +) / Double(range.count)
}

private func spectralEnergy(_ values: [Double], range: Range<Int>) -> Double {
    let mean = average(values, range: range)
    let peak = values[range].max() ?? 0
    return clamp(mean * 0.55 + peak * 0.45)
}

private func clamp(_ value: Double) -> Double {
    max(0.0, min(1.0, value))
}

private func rounded(_ value: Double) -> Double {
    (value * 1_000.0).rounded() / 1_000.0
}

private func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8)
    else { return }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

private func emitError(_ message: String, code: String) {
    emit(["status": "error", "code": code, "message": message])
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

@main
private struct AudioAnalyzerMain {
    static func main() async {
        guard #available(macOS 13.0, *) else {
            emitError("Audio-reactive visuals require macOS 13 or later.", code: "unsupported_os")
            exit(1)
        }

        let analyzer = SpotifyAudioAnalyzer()
        if let argumentIndex = CommandLine.arguments.firstIndex(of: "--test-tone"),
           CommandLine.arguments.indices.contains(argumentIndex + 1),
           let frequency = Double(CommandLine.arguments[argumentIndex + 1]),
           frequency > 0
        {
            analyzer.runToneTest(frequency: frequency)
            return
        }
        if CommandLine.arguments.contains("--test-balanced-bands") {
            analyzer.runBalancedBandTest()
            return
        }
        if CommandLine.arguments.contains("--test-stereo") {
            analyzer.runStereoTest()
            return
        }
        if CommandLine.arguments.contains("--self-test") {
            analyzer.runSelfTest()
            return
        }
        do {
            try await analyzer.start()
            await withUnsafeContinuation { (_: UnsafeContinuation<Void, Never>) in }
        } catch {
            let analyzerError = error as? AnalyzerError
            emitError(
                analyzerError?.localizedDescription ?? "Unable to capture Spotify audio: \(error.localizedDescription)",
                code: analyzerError?.code ?? (CGPreflightScreenCaptureAccess() ? "capture_failed" : "permission")
            )
            exit(1)
        }
    }
}
