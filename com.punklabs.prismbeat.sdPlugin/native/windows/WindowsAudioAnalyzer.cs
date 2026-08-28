using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Dsp;
using NAudio.Wave;

namespace PunkLabs.PrismBeat.Windows;

internal static class WindowsAudioAnalyzer
{
    public static async Task<int> RunAsync(JsonSerializerOptions jsonOptions)
    {
        using CancellationTokenSource cancellation = new();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        WriteLine(new
        {
            status = "ready",
            source = "windows-process-loopback",
            target = "Spotify",
        }, jsonOptions);

        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                uint? processId = SpotifyBridge.FindSpotifyAudioProcessId();
                if (processId is null)
                {
                    await Task.Delay(500, cancellation.Token);
                    continue;
                }

                try
                {
                    await CaptureSpotifyAsync(processId.Value, jsonOptions, cancellation.Token);
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine($"Spotify audio capture will retry: {error.Message}");
                    await Task.Delay(750, cancellation.Token);
                }
            }
            return 0;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return 0;
        }
        catch (Exception error)
        {
            WriteLine(new
            {
                status = "error",
                code = "capture_stopped",
                message = $"Spotify audio capture stopped: {error.Message}",
            }, jsonOptions);
            return 1;
        }
    }

    private static async Task CaptureSpotifyAsync(
        uint processId,
        JsonSerializerOptions jsonOptions,
        CancellationToken cancellationToken)
    {
        WaveFormat format = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
        await using WasapiRecorder recorder = await new WasapiRecorderBuilder()
            .WithProcessLoopback(processId, ProcessLoopbackMode.IncludeTargetProcessTree)
            .WithFormat(format)
            .WithBufferLength(40)
            .BuildAsync();
        AudioSampleBuffer samples = new(32768);
        AnalyzerCore analyzer = new();
        TaskCompletionSource stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);

        recorder.DataAvailable += (buffer, _, _, _) =>
            samples.Append(buffer, recorder.WaveFormat);
        recorder.RecordingStopped += (_, eventArgs) =>
        {
            if (eventArgs.Exception is not null) stopped.TrySetException(eventArgs.Exception);
            else stopped.TrySetResult();
        };
        using CancellationTokenRegistration registration = cancellationToken.Register(() =>
        {
            try { recorder.StopRecording(); }
            catch { stopped.TrySetCanceled(cancellationToken); }
        });

        recorder.StartRecording();
        using PeriodicTimer timer = new(TimeSpan.FromMilliseconds(80));
        while (!stopped.Task.IsCompleted && await timer.WaitForNextTickAsync(cancellationToken))
        {
            (float[] left, float[] right) = samples.Snapshot(8192);
            WriteLine(analyzer.Analyze(left, right, recorder.WaveFormat.SampleRate), jsonOptions);
        }
        await stopped.Task;
    }

    public static void RunSelfTest()
    {
        const int sampleRate = 48000;
        const int length = 8192;
        AudioFrame bass = AnalyzeSine(100, sampleRate, length);
        AudioFrame mid = AnalyzeSine(1000, sampleRate, length);
        AudioFrame treble = AnalyzeSine(10000, sampleRate, length);

        int bassBand = DominantBand(bass.Bands);
        int midBand = DominantBand(mid.Bands);
        int trebleBand = DominantBand(treble.Bands);
        if (!(bassBand < midBand && midBand < trebleBand))
            throw new InvalidOperationException(
                $"Frequency ordering failed: bass={bassBand}, mid={midBand}, treble={trebleBand}.");
        if (bass.Bass <= bass.Mid || mid.Mid <= mid.Bass || treble.Treble <= treble.Bass)
            throw new InvalidOperationException("Frequency region energy failed the synthetic signal test.");
        if (bass.Waveform.Length != 256 || bass.Bands.Length != 40 || bass.Chroma.Length != 12)
            throw new InvalidOperationException("Analyzer output dimensions are invalid.");
    }

    private static AudioFrame AnalyzeSine(float frequency, int sampleRate, int length)
    {
        float[] signal = Enumerable.Range(0, length)
            .Select(index => 0.7f * MathF.Sin(2 * MathF.PI * frequency * index / sampleRate))
            .ToArray();
        return new AnalyzerCore().Analyze(signal, signal, sampleRate);
    }

    private static int DominantBand(float[] bands) =>
        Array.IndexOf(bands, bands.Max());

    private static void WriteLine<T>(T value, JsonSerializerOptions options)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, options));
        Console.Out.Flush();
    }
}

internal sealed class AudioSampleBuffer
{
    private static readonly Guid IeeeFloatSubFormat =
        new("00000003-0000-0010-8000-00aa00389b71");
    private readonly float[] left;
    private readonly float[] right;
    private readonly object sync = new();
    private int writeIndex;
    private int count;

    public AudioSampleBuffer(int capacity)
    {
        left = new float[capacity];
        right = new float[capacity];
    }

    public void Append(ReadOnlySpan<byte> bytes, WaveFormat format)
    {
        int channels = Math.Max(1, format.Channels);
        int bytesPerSample = Math.Max(1, format.BitsPerSample / 8);
        int frameBytes = bytesPerSample * channels;
        if (frameBytes <= 0) return;

        lock (sync)
        {
            for (int offset = 0; offset + frameBytes <= bytes.Length; offset += frameBytes)
            {
                float sampleLeft = ReadSample(bytes, offset, format);
                float sampleRight = channels > 1
                    ? ReadSample(bytes, offset + bytesPerSample, format)
                    : sampleLeft;
                left[writeIndex] = sampleLeft;
                right[writeIndex] = sampleRight;
                writeIndex = (writeIndex + 1) % left.Length;
                count = Math.Min(count + 1, left.Length);
            }
        }
    }

    public (float[] Left, float[] Right) Snapshot(int length)
    {
        float[] outputLeft = new float[length];
        float[] outputRight = new float[length];
        lock (sync)
        {
            int available = Math.Min(count, length);
            int padding = length - available;
            int start = (writeIndex - available + left.Length) % left.Length;
            for (int index = 0; index < available; index++)
            {
                int source = (start + index) % left.Length;
                outputLeft[padding + index] = left[source];
                outputRight[padding + index] = right[source];
            }
        }
        return (outputLeft, outputRight);
    }

    private static float ReadSample(ReadOnlySpan<byte> bytes, int offset, WaveFormat format)
    {
        bool ieeeFloat = format.Encoding == WaveFormatEncoding.IeeeFloat ||
            format is WaveFormatExtensible extensible &&
            extensible.SubFormat == IeeeFloatSubFormat;
        if (ieeeFloat && format.BitsPerSample == 32)
            return Math.Clamp(BitConverter.ToSingle(bytes[offset..]), -1, 1);

        return format.BitsPerSample switch
        {
            16 => BitConverter.ToInt16(bytes[offset..]) / 32768f,
            24 => ReadInt24(bytes, offset) / 8388608f,
            32 => BitConverter.ToInt32(bytes[offset..]) / 2147483648f,
            _ => 0,
        };
    }

    private static int ReadInt24(ReadOnlySpan<byte> bytes, int offset)
    {
        int value = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
        return (value & 0x800000) != 0 ? value | unchecked((int)0xff000000) : value;
    }
}

internal sealed class AnalyzerCore
{
    private const int FftSize = 8192;
    private const int BandCount = 40;
    private const float MinimumFrequency = 45;
    private const float MaximumFrequency = 16000;
    private readonly float[] smoothedBands = new float[BandCount];
    private float bassEnvelope;

    public AudioFrame Analyze(float[] left, float[] right, int sampleRate)
    {
        float[] mono = new float[FftSize];
        int inputLength = Math.Min(FftSize, Math.Min(left.Length, right.Length));
        int inputStart = Math.Min(left.Length, right.Length) - inputLength;
        int outputStart = FftSize - inputLength;
        float sumSquares = 0;
        float peak = 0;
        for (int index = 0; index < inputLength; index++)
        {
            float sample = (left[inputStart + index] + right[inputStart + index]) * 0.5f;
            mono[outputStart + index] = sample;
            sumSquares += sample * sample;
            peak = Math.Max(peak, Math.Abs(sample));
        }
        float rms = MathF.Sqrt(sumSquares / Math.Max(1, inputLength));

        Complex[] fft = new Complex[FftSize];
        for (int index = 0; index < FftSize; index++)
        {
            float window = 0.5f * (1 - MathF.Cos(2 * MathF.PI * index / (FftSize - 1)));
            fft[index].X = mono[index] * window;
        }
        FastFourierTransform.FFT(true, 13, fft);

        float[] magnitudes = new float[FftSize / 2];
        for (int bin = 1; bin < magnitudes.Length; bin++)
            magnitudes[bin] = 2 * MathF.Sqrt(fft[bin].X * fft[bin].X + fft[bin].Y * fft[bin].Y);

        float[] bands = new float[BandCount];
        float frequencyCeiling = Math.Min(MaximumFrequency, sampleRate * 0.48f);
        for (int band = 0; band < BandCount; band++)
        {
            float low = LogFrequency(band, BandCount, MinimumFrequency, frequencyCeiling);
            float high = LogFrequency(band + 1, BandCount, MinimumFrequency, frequencyCeiling);
            int lowBin = Math.Max(1, (int)MathF.Floor(low * FftSize / sampleRate));
            int highBin = Math.Min(magnitudes.Length - 1, (int)MathF.Ceiling(high * FftSize / sampleRate));
            float sum = 0;
            for (int bin = lowBin; bin <= highBin; bin++) sum += magnitudes[bin] * magnitudes[bin];
            // Match the macOS analyser: a logarithmic band represents the total
            // energy in its FFT bins, rather than their average. Averaging makes
            // the wide high-frequency bands almost silent on Windows.
            float magnitude = MathF.Sqrt(sum);
            float decibels = 20 * MathF.Log10(Math.Max(1e-7f, magnitude));
            float target = Math.Clamp((decibels + 72) / 62, 0, 1);
            float smoothing = target > smoothedBands[band] ? 0.78f : 0.24f;
            smoothedBands[band] += (target - smoothedBands[band]) * smoothing;
            bands[band] = smoothedBands[band];
        }

        float bass = SpectralEnergy(bands, 0, 14);
        float mid = SpectralEnergy(bands, 14, 29);
        float treble = SpectralEnergy(bands, 29, BandCount);
        bassEnvelope = bassEnvelope * 0.92f + bass * 0.08f;
        float beat = Math.Clamp((bass - bassEnvelope) * 5.5f, 0, 1);

        (float[] waveform, float[] stereoLeft, float[] stereoRight) =
            TriggeredWaveform(left, right, 256);
        float correlation = StereoCorrelation(stereoLeft, stereoRight);
        float[] chroma = Chromagram(magnitudes, sampleRate);

        return new AudioFrame(
            bands,
            waveform,
            stereoLeft,
            stereoRight,
            correlation,
            chroma,
            NormalizeLevel(rms),
            NormalizeLevel(peak),
            bass,
            mid,
            treble,
            beat);
    }

    private static float LogFrequency(int index, int count, float minimum, float maximum) =>
        minimum * MathF.Pow(maximum / minimum, index / (float)count);

    private static float SpectralEnergy(float[] values, int start, int end)
    {
        ReadOnlySpan<float> region = values.AsSpan(start, end - start);
        float mean = 0;
        float peak = 0;
        foreach (float value in region)
        {
            mean += value;
            peak = Math.Max(peak, value);
        }
        mean /= region.Length;
        return Math.Clamp(mean * 0.55f + peak * 0.45f, 0, 1);
    }

    private static float NormalizeLevel(float value)
    {
        float decibels = 20 * MathF.Log10(Math.Max(1e-7f, value));
        return Math.Clamp((decibels + 60) / 54, 0, 1);
    }

    private static (float[] Waveform, float[] Left, float[] Right) TriggeredWaveform(
        float[] left,
        float[] right,
        int points)
    {
        int length = Math.Min(left.Length, right.Length);
        int searchStart = Math.Max(1, length - points * 3);
        int start = Math.Max(0, length - points);
        for (int index = searchStart; index < length - points; index++)
        {
            float previous = (left[index - 1] + right[index - 1]) * 0.5f;
            float current = (left[index] + right[index]) * 0.5f;
            if (previous <= 0 && current > 0) { start = index; break; }
        }

        float[] wave = new float[points];
        float[] outputLeft = new float[points];
        float[] outputRight = new float[points];
        for (int index = 0; index < points; index++)
        {
            int source = Math.Min(length - 1, start + index);
            if (source < 0) continue;
            outputLeft[index] = Math.Clamp(left[source], -1, 1);
            outputRight[index] = Math.Clamp(right[source], -1, 1);
            wave[index] = (outputLeft[index] + outputRight[index]) * 0.5f;
        }
        return (wave, outputLeft, outputRight);
    }

    private static float StereoCorrelation(float[] left, float[] right)
    {
        float products = 0;
        float leftSquares = 0;
        float rightSquares = 0;
        for (int index = 0; index < Math.Min(left.Length, right.Length); index++)
        {
            products += left[index] * right[index];
            leftSquares += left[index] * left[index];
            rightSquares += right[index] * right[index];
        }
        return Math.Clamp(products / MathF.Sqrt(Math.Max(1e-8f, leftSquares * rightSquares)), -1, 1);
    }

    private static float[] Chromagram(float[] magnitudes, int sampleRate)
    {
        float[] chroma = new float[12];
        int minimumBin = Math.Max(1, (int)(55 * FftSize / sampleRate));
        int maximumBin = Math.Min(magnitudes.Length - 1, (int)(5000 * FftSize / sampleRate));
        for (int bin = minimumBin; bin <= maximumBin; bin++)
        {
            float frequency = bin * sampleRate / (float)FftSize;
            int midi = (int)MathF.Round(69 + 12 * MathF.Log2(frequency / 440));
            int pitchClass = ((midi % 12) + 12) % 12;
            chroma[pitchClass] += magnitudes[bin];
        }
        float maximum = chroma.Max();
        if (maximum > 0)
            for (int index = 0; index < chroma.Length; index++) chroma[index] /= maximum;
        return chroma;
    }
}

internal sealed record AudioFrame(
    float[] Bands,
    float[] Waveform,
    float[] StereoLeft,
    float[] StereoRight,
    float StereoCorrelation,
    float[] Chroma,
    float Rms,
    float Peak,
    float Bass,
    float Mid,
    float Treble,
    float Beat);
