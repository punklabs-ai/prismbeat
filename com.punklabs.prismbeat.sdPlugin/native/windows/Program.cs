using System.Text.Json;

namespace PunkLabs.PrismBeat.Windows;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static async Task<int> Main(string[] args)
    {
        string mode = args.FirstOrDefault()?.Trim().ToLowerInvariant() ?? "state";
        if (mode == "self-test")
        {
            WindowsAudioAnalyzer.RunSelfTest();
            Console.WriteLine("PrismBeat Windows helper self-test passed");
            return 0;
        }

        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("PrismBeat Windows helper can only run on Windows.");
            return 1;
        }

        try
        {
            switch (mode)
            {
                case "state":
                    WriteJson(await SpotifyBridge.ReadStateAsync());
                    return 0;
                case "control":
                    if (args.Length < 2) throw new ArgumentException("A control command is required.");
                    await SpotifyBridge.ControlAsync(args[1], args.Skip(2).ToArray());
                    Console.WriteLine("ok");
                    return 0;
                case "launch":
                    SpotifyBridge.Launch();
                    Console.WriteLine("ok");
                    return 0;
                case "analyze":
                    return await WindowsAudioAnalyzer.RunAsync(JsonOptions);
                default:
                    throw new ArgumentException($"Unknown mode: {mode}");
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"{error.GetType().Name}: {error.Message}");
            return 1;
        }
    }

    private static void WriteJson<T>(T value) =>
        Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
}
