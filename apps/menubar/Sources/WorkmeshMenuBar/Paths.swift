import Foundation

/// Resolves the same config/state locations as the CLI (packages/cli/src/lib/paths.ts),
/// honoring XDG_CONFIG_HOME / XDG_STATE_HOME so a customized daemon is still found.
/// Before the rename the CLI used `agentblip` directories; when the `workmesh` file is
/// missing (an older daemon still running), the old one is read instead.
enum Paths {
    private static var home: String {
        FileManager.default.homeDirectoryForCurrentUser.path
    }

    private static func envDir(_ key: String, default fallback: [String]) -> String {
        if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
        return ([home] + fallback).joined(separator: "/")
    }

    private static var configBase: String { envDir("XDG_CONFIG_HOME", default: [".config"]) }
    private static var stateBase: String { envDir("XDG_STATE_HOME", default: [".local", "state"]) }

    static var configDir: String { configBase + "/workmesh" }
    static var stateDir: String { stateBase + "/workmesh" }

    /// The current file, or its pre-rename twin when only that one exists.
    private static func current(_ path: String, legacy: String) -> String {
        let fm = FileManager.default
        return !fm.fileExists(atPath: path) && fm.fileExists(atPath: legacy) ? legacy : path
    }

    static var configPath: String {
        current(configDir + "/config.json", legacy: configBase + "/agentblip/config.json")
    }

    static var daemonSecretPath: String {
        current(stateDir + "/daemon.secret", legacy: stateBase + "/agentblip/daemon.secret")
    }
}
