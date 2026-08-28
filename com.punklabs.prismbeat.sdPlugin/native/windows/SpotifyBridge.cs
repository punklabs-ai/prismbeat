using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using NAudio.CoreAudioApi;
using Windows.Media;
using Windows.Media.Control;

namespace PunkLabs.PrismBeat.Windows;

internal static class SpotifyBridge
{
    private const string SpotifyToken = "spotify";

    public static async Task<object> ReadStateAsync()
    {
        GlobalSystemMediaTransportControlsSession? session = await FindSpotifySessionAsync();
        bool isRunning = session is not null || IsSpotifyRunning();
        if (session is null) return EmptyState(isRunning);

        GlobalSystemMediaTransportControlsSessionPlaybackInfo playback = session.GetPlaybackInfo();
        GlobalSystemMediaTransportControlsSessionTimelineProperties timeline = session.GetTimelineProperties();
        GlobalSystemMediaTransportControlsSessionMediaProperties media =
            await session.TryGetMediaPropertiesAsync();

        double durationSeconds = Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalSeconds);
        double positionSeconds = Math.Max(0, timeline.Position.TotalSeconds);
        double volume = TryGetSpotifyVolume(out float spotifyVolume)
            ? Math.Round(spotifyVolume * 100)
            : 0;
        string artworkUrl = await SaveArtworkAsync(media);
        string trackKey = string.Join("\n", media.Title, media.Artist, media.AlbumTitle, durationSeconds);
        string trackId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(trackKey)))[..24]
            .ToLowerInvariant();
        string searchText = string.Join(" ", new[] { media.Artist, media.Title }.Where(value => !string.IsNullOrWhiteSpace(value)));
        string spotifyUrl = string.IsNullOrWhiteSpace(searchText)
            ? string.Empty
            : $"https://open.spotify.com/search/{Uri.EscapeDataString(searchText)}";
        string repeatMode = playback.AutoRepeatMode?.ToString() ?? "None";
        bool repeatActive = playback.AutoRepeatMode is not null and not MediaPlaybackAutoRepeatMode.None;

        return new
        {
            timestamp = DateTimeOffset.UtcNow,
            isRunning,
            player = new
            {
                version = "Windows",
                state = PlaybackState(playback.PlaybackStatus),
                autoRepeatMode = repeatMode,
                isShuffleActive = playback.IsShuffleActive ?? false,
                isShuffleEnabled = playback.Controls.IsShuffleEnabled,
                isRepeatActive = repeatActive,
                isRepeatEnabled = playback.Controls.IsRepeatEnabled,
                volume,
                lastPosition = Math.Floor(positionSeconds),
            },
            currentTrack = new
            {
                id = trackId,
                spotifyUrl,
                title = media.Title ?? string.Empty,
                artist = media.Artist ?? string.Empty,
                album = media.AlbumTitle ?? string.Empty,
                albumArtist = media.AlbumArtist ?? string.Empty,
                duration = Math.Round(durationSeconds * 1000),
                durationSeconds = Math.Floor(durationSeconds),
                positionSeconds,
                positionPercent = durationSeconds > 0 ? positionSeconds * 100 / durationSeconds : 0,
                trackNumber = media.TrackNumber,
                artworkUrl,
            },
        };
    }

    public static async Task ControlAsync(string rawCommand, string[] args)
    {
        string command = rawCommand.Trim().ToLowerInvariant();
        if (command is "setvolume" or "changevolume")
        {
            float current = TryGetSpotifyVolume(out float value) ? value * 100 : 50;
            float requested = command == "setvolume" ? Number(args, 0) : current + Number(args, 0);
            if (!TrySetSpotifyVolume(Math.Clamp(requested / 100, 0, 1)))
                throw new InvalidOperationException("Spotify does not have an active Windows audio session.");
            return;
        }

        GlobalSystemMediaTransportControlsSession session =
            await FindSpotifySessionAsync()
            ?? throw new InvalidOperationException("Spotify does not have an active Windows media session.");

        bool succeeded = command switch
        {
            "play" => await session.TryPlayAsync(),
            "pause" or "stop" => await session.TryPauseAsync(),
            "playpause" => await session.TryTogglePlayPauseAsync(),
            "next" => await session.TrySkipNextAsync(),
            "previous" => await session.TrySkipPreviousAsync(),
            "restart" => await session.TryChangePlaybackPositionAsync(0),
            "skipbyseconds" => await SeekByAsync(session, Number(args, 0)),
            "setshuffling" => await session.TryChangeShuffleActiveAsync(Boolean(args, 0)),
            "setrepeating" => await session.TryChangeAutoRepeatModeAsync(
                Boolean(args, 0) ? MediaPlaybackAutoRepeatMode.List : MediaPlaybackAutoRepeatMode.None),
            _ => throw new ArgumentException($"Unknown Spotify command: {command}"),
        };
        if (!succeeded) throw new InvalidOperationException($"Spotify rejected the {command} command.");
    }

    public static void Launch()
    {
        Exception? lastError = null;
        string localSpotify = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WindowsApps", "Spotify.exe");
        foreach (string target in new[] { "spotify:", localSpotify })
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                return;
            }
            catch (Exception error)
            {
                lastError = error;
            }
        }
        throw new InvalidOperationException("Spotify could not be opened.", lastError);
    }

    internal static uint? FindSpotifyAudioProcessId()
    {
        try
        {
            using MMDeviceEnumerator enumerator = new();
            using MMDevice device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            SessionCollection sessions = device.AudioSessionManager.Sessions;
            for (int index = 0; index < sessions.Count; index++)
            {
                AudioSessionControl session = sessions[index];
                if (IsSpotifyAudioSession(session)) return session.GetProcessID;
            }
        }
        catch { }
        return null;
    }

    private static async Task<GlobalSystemMediaTransportControlsSession?> FindSpotifySessionAsync()
    {
        GlobalSystemMediaTransportControlsSessionManager manager =
            await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        return manager.GetSessions().FirstOrDefault(session =>
            session.SourceAppUserModelId.Contains(SpotifyToken, StringComparison.OrdinalIgnoreCase));
    }

    private static async Task<bool> SeekByAsync(
        GlobalSystemMediaTransportControlsSession session,
        float seconds)
    {
        TimeSpan position = session.GetTimelineProperties().Position + TimeSpan.FromSeconds(seconds);
        return await session.TryChangePlaybackPositionAsync(Math.Max(0, position.Ticks));
    }

    private static bool IsSpotifyRunning()
    {
        try
        {
            foreach (Process process in Process.GetProcesses())
            {
                using (process)
                {
                    try
                    {
                        if (process.ProcessName.Contains(SpotifyToken, StringComparison.OrdinalIgnoreCase))
                            return true;
                    }
                    catch { }
                }
            }
        }
        catch { }
        return false;
    }

    private static bool TryGetSpotifyVolume(out float volume)
    {
        volume = 0;
        try
        {
            using MMDeviceEnumerator enumerator = new();
            using MMDevice device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            SessionCollection sessions = device.AudioSessionManager.Sessions;
            for (int index = 0; index < sessions.Count; index++)
            {
                AudioSessionControl session = sessions[index];
                if (!IsSpotifyAudioSession(session)) continue;
                volume = session.SimpleAudioVolume.Volume;
                return true;
            }
        }
        catch { }
        return false;
    }

    private static bool TrySetSpotifyVolume(float volume)
    {
        bool found = false;
        try
        {
            using MMDeviceEnumerator enumerator = new();
            using MMDevice device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            SessionCollection sessions = device.AudioSessionManager.Sessions;
            for (int index = 0; index < sessions.Count; index++)
            {
                AudioSessionControl session = sessions[index];
                if (!IsSpotifyAudioSession(session)) continue;
                session.SimpleAudioVolume.Volume = volume;
                found = true;
            }
        }
        catch { }
        return found;
    }

    private static bool IsSpotifyAudioSession(AudioSessionControl session)
    {
        try
        {
            using Process process = Process.GetProcessById((int)session.GetProcessID);
            return process.ProcessName.Contains(SpotifyToken, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static async Task<string> SaveArtworkAsync(
        GlobalSystemMediaTransportControlsSessionMediaProperties media)
    {
        if (media.Thumbnail is null) return string.Empty;
        try
        {
            string directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PUNK LABS", "PrismBeat", "cache");
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "now-playing-artwork");
            using global::Windows.Storage.Streams.IRandomAccessStreamWithContentType random =
                await media.Thumbnail.OpenReadAsync();
            using Stream input = random.AsStreamForRead();
            await using FileStream output = File.Create(path);
            await input.CopyToAsync(output);
            return new Uri(path).AbsoluteUri;
        }
        catch { return string.Empty; }
    }

    private static string PlaybackState(GlobalSystemMediaTransportControlsSessionPlaybackStatus status) =>
        status switch
        {
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "paused",
            _ => "stopped",
        };

    private static float Number(string[] args, int index) =>
        index < args.Length && float.TryParse(
            args[index], System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out float value)
            ? value : 0;

    private static bool Boolean(string[] args, int index) =>
        index < args.Length && new[] { "1", "true", "yes", "on" }.Contains(
            args[index].Trim().ToLowerInvariant());

    private static object EmptyState(bool isRunning) => new
    {
        timestamp = DateTimeOffset.UtcNow,
        isRunning,
        player = new
        {
            version = "Windows",
            state = "stopped",
            autoRepeatMode = "None",
            isShuffleActive = false,
            isShuffleEnabled = false,
            isRepeatActive = false,
            isRepeatEnabled = false,
            volume = 0,
            lastPosition = 0,
        },
        currentTrack = new
        {
            id = string.Empty,
            spotifyUrl = string.Empty,
            title = string.Empty,
            artist = string.Empty,
            album = string.Empty,
            albumArtist = string.Empty,
            duration = 0,
            durationSeconds = 0,
            positionSeconds = 0,
            positionPercent = 0,
            trackNumber = 0,
            artworkUrl = string.Empty,
        },
    };
}
